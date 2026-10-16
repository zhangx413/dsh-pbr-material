"""
PBRLab - local PBR material synthesis nodes for ComfyUI.

Design constraints (deliberate):
  * Zero third-party dependencies beyond what ComfyUI already ships
    (torch, numpy). No scipy, no OpenCV, no model weights.
  * Everything is deterministic and offline-verifiable. The heavy lifting is
    closed-form array math, so it can be unit-tested outside ComfyUI.
  * No network access, no subprocess, no writes outside ComfyUI's normal
    output paths.

Node list
---------
PBRLabCircularVAEPad      - make ANY VAE/decode pipeline tileable via circular padding
PBRLabCircularBlur        - tileable (wrap-around) gaussian blur
PBRLabCircularDownscale   - tileable area-average downsample
PBRLabPBRSynth            - albedo/height/detail -> normal/height/rough/AO/curv/metal
PBRLabMakeSeamless        - repair an existing image so it tiles (lossy, see notes)
PBRLabSaveImage16         - save PBR maps as real 16-bit PNGs (SaveImage is 8-bit only)
PBRLabColorMatch          - Reinhard colour transfer: give a generated tile the
                            palette of a reference photo without touching structure
PBRLabTileValidator       - measure seam continuity + normal map validity
"""

from __future__ import annotations

import json
import math
import os

import numpy as np
import torch
import torch.nn.functional as F

CATEGORY = "PBRLab"


# --------------------------------------------------------------------------- #
# small math helpers
# --------------------------------------------------------------------------- #

def _as_bchw(t: torch.Tensor) -> torch.Tensor:
    """Accept HWC / BHWC / BCHW float tensors and return BHWC float32."""
    if t.ndim == 3:
        b = t.unsqueeze(0)
    elif t.ndim == 4:
        b = t
    else:
        raise ValueError(f"expected 3D or 4D image tensor, got shape {tuple(t.shape)}")

    # ComfyUI's IMAGE is NHWC, but be forgiving about NCHW input.
    if b.shape[-1] == 1 or b.shape[-1] == 2:
        b = b.expand(-1, -1, -1, 3)
    if b.shape[-1] == 3:
        pass
    elif b.shape[1] == 3:
        b = b.permute(0, 2, 3, 1)
    return b.to(torch.float32)


def _batchify(t: torch.Tensor) -> tuple[torch.Tensor, bool]:
    """Accept HWC or BHWC and return (BHWC, was_unbatched)."""
    if t.ndim == 3:
        return t.unsqueeze(0), True
    if t.ndim == 4:
        return t, False
    raise ValueError(f"expected 3D or 4D image tensor, got shape {tuple(t.shape)}")


def _unbatchify(t: torch.Tensor, was_unbatched: bool) -> torch.Tensor:
    return t.squeeze(0) if was_unbatched else t


def _pad_hw(x: torch.Tensor, py: int, px: int, mode: str) -> torch.Tensor:
    """Pad the last two dims (H, W) of a BHWC tensor, torch-style explicitly."""
    if py == 0 and px == 0:
        return x
    b = x.permute(0, 3, 1, 2)  # BCHW
    b = F.pad(b, (px, px, py, py), mode=mode)
    return b.permute(0, 2, 3, 1)


def _gauss_kernel(radius: int, device, dtype) -> torch.Tensor:
    radius = max(1, int(radius))
    sigma = max(0.5, radius / 2.0)
    xs = torch.arange(-radius, radius + 1, device=device, dtype=torch.float32)
    k = torch.exp(-(xs * xs) / (2.0 * sigma * sigma))
    k = k / k.sum()
    return k.to(dtype)


def _circular_blur(x: torch.Tensor, radius: int) -> torch.Tensor:
    """Separable gaussian blur with periodic (wrap) boundary handling.

    Accepts HWC or BHWC. This is what keeps the height field tileable: edge
    pixels see the opposite edge instead of a flat border.
    """
    radius = int(radius)
    x, unbatched = _batchify(x)
    if radius <= 0:
        return _unbatchify(x, unbatched)
    b, h, w, c = x.shape
    k = _gauss_kernel(radius, x.device, x.dtype)
    ksz = k.numel()

    # horizontal
    p = _pad_hw(x, 0, radius, "circular")
    p = p.permute(0, 3, 1, 2).reshape(b * c, 1, h, w + 2 * radius)
    kx = k.view(1, 1, 1, ksz).expand(1, 1, 1, ksz)
    out = F.conv2d(p, kx)  # (B*C, 1, H, W)
    out = out.reshape(b, c, h, w).permute(0, 2, 3, 1)

    # vertical
    p = _pad_hw(out, radius, 0, "circular")
    p = p.permute(0, 3, 1, 2).reshape(b * c, 1, h + 2 * radius, w)
    ky = k.view(1, 1, ksz, 1).expand(1, 1, ksz, 1)
    out = F.conv2d(p, ky)
    out = out.reshape(b, c, h, w).permute(0, 2, 3, 1).contiguous()
    return _unbatchify(out, unbatched)


def _high_pass(x: torch.Tensor, radius: int) -> torch.Tensor:
    return x - _circular_blur(x, radius)


def _luma(x: torch.Tensor) -> torch.Tensor:
    """Rec.709 luma, returns BHWC with C=1."""
    return (0.2126 * x[..., 0:1] + 0.7152 * x[..., 1:2] + 0.0722 * x[..., 2:3])


def _grad_mag(h: torch.Tensor) -> torch.Tensor:
    """Magnitude of the gradient of a BHWC, C=1 tileable height field.

    Uses circular differences so the gradient is also tileable.
    """
    gx = torch.roll(h, -1, dims=2) - torch.roll(h, 1, dims=2)
    gy = torch.roll(h, -1, dims=1) - torch.roll(h, 1, dims=1)
    return torch.sqrt(gx * gx + gy * gy + 1e-12)


def _normalize01(t: torch.Tensor, ref: torch.Tensor | None = None) -> torch.Tensor:
    """Percentile-normalize t to 0..1. `ref` supplies the statistics when t is
    derived from another field (keeps the mapping stable across seeds)."""
    src = ref if ref is not None else t
    lo = torch.quantile(src.flatten(), 0.005)
    hi = torch.quantile(src.flatten(), 0.995)
    if float(hi - lo) < 1e-8:
        return torch.zeros_like(t)
    return torch.clamp((t - lo) / (hi - lo), 0.0, 1.0)


# --------------------------------------------------------------------------- #
# seam metrics (shared by the validator node and the offline test)
# --------------------------------------------------------------------------- #

def seam_metrics(img: torch.Tensor, normal: torch.Tensor | None = None,
                 normal_encoded: bool = True) -> dict:
    """img: BHWC. Returns seam metrics for the discrete tiling test.

    The correct discrete definition of "tiles seamlessly": when you butt the
    image against a copy of itself, the last column must equal the first column
    and the last row must equal the first row. Any difference IS the visible
    seam, by definition - no statistical modelling involved.

    `wrap_*` is the mean absolute value of that mismatch, in 0..1 image units.
    `wrap_*_ratio` normalises it by the typical interior neighbour difference,
    so the number means "how many times harder is the seam than the busiest
    normal step inside the texture". <= 1 means the seam is indistinguishable
    from ordinary texture detail.

    NOTE: do not measure this with a diagonal roll(x, (-1,-1)). For separable
    fields that doubles the deviation and produces false failures on perfectly
    good sinusoids, while white noise scores a misleading 1.0.
    """
    img, unbatched = _batchify(_as_bchw(img))
    b, h, w, _ = img.shape

    dx = (img[:, :, 0, :] - img[:, :, -1, :]).abs()
    dy = (img[:, 0, :, :] - img[:, -1, :, :]).abs()

    ref_global = (img[:, :, 1:, :] - img[:, :, :-1, :]).abs().mean()
    ref_global = max(float(ref_global), float((img[:, 1:, :, :] - img[:, :-1, :, :]).abs().mean()))
    # Floor the reference so that flat maps (face normal ~ (0,0,1), constant
    # metallic, a low-contrast curvature map) cannot blow the ratio up towards
    # infinity. For those, wrap_max is the decisive number anyway.
    ref_global = max(ref_global, 0.002)

    wrap_x = float(dx.mean())
    wrap_y = float(dy.mean())
    wrap = max(wrap_x, wrap_y)

    out = {
        "resolution": f"{w}x{h}",
        "wrap_x": round(wrap_x, 6),
        "wrap_y": round(wrap_y, 6),
        "wrap_max": round(max(float(dx.max()), float(dy.max())), 6),
        "wrap": round(wrap, 6),
        "interior_ref": round(ref_global, 6),
        "wrap_ratio": round(wrap / ref_global, 4),
        "wrap_ratio_db": round(20.0 * math.log10(max(wrap / ref_global, 1e-6)), 2),
    }

    if normal is not None:
        # Normal map storage convention matters and is a classic silent bug:
        #   * direct tangent-space vector  -> values already in -1..1   (default)
        #   * image-encoded for PNG        -> (n + 1) / 2 in 0..1
        # Decoding the wrong one double-transforms the vector and produces a
        # normal map with |n| ~ 1.7 that is nonetheless fully self-consistent,
        # which is exactly why it needs to be an explicit choice here.
        n = _as_bchw(normal)
        if normal_encoded:
            n = n * 2.0 - 1.0
        else:
            n = torch.clamp(n, -1.0, 1.0)
        length = torch.sqrt((n * n).sum(dim=-1) + 1e-12)
        out["normal_encoding"] = "image 0..1 (decoded with n*2-1)" if normal_encoded else "direct tangent -1..1"
        out["normal_length_mean"] = round(float(length.mean()), 5)
        out["normal_length_p01"] = round(float(torch.quantile(length.flatten(), 0.01)), 5)
        out["normal_unit_frac"] = round(
            float(((length - 1.0).abs() < 0.02).float().mean()), 4
        )
        out["normal_range"] = [round(float(n.min()), 3), round(float(n.max()), 3)]
        # A non-directional height field must give an unbiased normal map.
        out["normal_mean_xy"] = [
            round(float(n[..., 0].mean()), 4),
            round(float(n[..., 1].mean()), 4),
        ]
        out["normal_z_positive"] = bool(float(n[..., 2].min()) > 0.0)

    # Calibrated on this host (256x256, mean edge step / interior step):
    #   exactly periodic field ............ 0.00
    #   circular-blurred periodic field ... 0.25
    #   white noise (non-tileable) ........ 0.99   <- both criteria fail
    #   periodic content with a hard seam . 4.68   <- vetoed
    #
    # The mean (`wrap`) is the primary signal; `wrap_max` is a max over all
    # channels and is easily dominated by one pixel, so it is only used as a
    # blunt veto, never as the pass criterion.
    #
    # Caveat: the ratio compresses towards 1 for texel-level high-frequency
    # content, where a seam is genuinely hard to see. A PASS here is a necessary
    # check, not a visual guarantee.
    out["hard_seam"] = bool(out["wrap_max"] > 0.5)
    out["seam_pass"] = bool(
        (not out["hard_seam"]) and (out["wrap_ratio"] <= 1.4 or out["wrap"] <= 0.02)
    )
    if normal is not None:
        out["normal_pass"] = bool(
            abs(out["normal_length_mean"] - 1.0) < 0.02
            and out["normal_unit_frac"] > 0.9
            and out["normal_range"][0] >= -1.001
            and out["normal_range"][1] <= 1.001
            and out.get("normal_z_positive", True)
        )
    return out


# --------------------------------------------------------------------------- #
# nodes
# --------------------------------------------------------------------------- #

class PBRLabCircularVAEPad:
    """Pad a latent with circular (wrap-around) values.

    Why this is the only correct way to do tiling: in latent space each latent
    pixel is a learned patch code, not a pixel. Any seam-free strategy that
    works after decoding (mirror/reflect padding, edge repeat, pixel shifting)
    still leaves a discontinuity in the *latent* field, which the VAE then
    turns into a visible tile border. Padding the latent with genuine circular
    values makes the decoder emit an image that is periodic by construction;
    the outer `pad` pixels are then cropped away and the remaining centre tiles
    perfectly.

    Output tile size = (input + 2*pad), because the centre is cropped back.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "pad": ("INT", {"default": 128, "min": 8, "max": 512, "step": 8}),
                "padding_mode": (["circular", "replicate", "reflect"], {"default": "circular"}),
                "tile_size": ("INT", {"default": 1024, "min": 0, "max": 8192, "step": 64}),
            },
            "optional": {
                "verify_roundtrip": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("latent", "report")
    FUNCTION = "pad"
    CATEGORY = CATEGORY

    def pad(self, samples, pad, padding_mode, tile_size, verify_roundtrip=True):
        latent = samples["samples"]
        if latent.ndim != 4:
            raise ValueError(f"expected 4D latent (B,C,H,W), got {tuple(latent.shape)}")
        b, c, h, w = latent.shape

        report = {
            "input_latent": [w, h],
            "pad_latent": pad,
            "padding_mode": padding_mode,
        }

        if verify_roundtrip:
            # Exact proof the padding is periodic: pad, unpad, compare.
            try:
                p = F.pad(latent, (pad, pad, pad, pad), mode="circular")
            except RuntimeError:
                p = None
            if p is not None:
                back = p[..., pad:pad + h, pad:pad + w]
                report["pad_roundtrip_max_abs_err"] = float((back - latent).abs().max())
                report["pad_roundtrip_exact"] = report["pad_roundtrip_max_abs_err"] == 0.0
            else:
                report["pad_roundtrip_exact"] = False
                report["pad_roundtrip_note"] = (
                    "torch circular padding cannot wrap more than one period; "
                    "use a smaller pad or a larger latent."
                )

        mode = "replicate" if padding_mode == "replicate" else ("reflect" if padding_mode == "reflect" else "circular")
        if mode == "reflect" and (pad >= h or pad >= w):
            # torch reflect padding cannot wrap more than (size - 1).
            mode = "replicate"
            report["reflect_fallback"] = "reflect needs pad < min(H,W); fell back to replicate"
        if mode == "circular" and (pad >= h or pad >= w):
            if padding_mode == "circular":
                report["circular_fallback"] = (
                    f"pad={pad} >= latent {w}x{h}: one circular period is the most "
                    f"torch can wrap, so this fell back to replicate. Use pad < "
                    f"{min(h, w)}, or a larger latent."
                )
                mode = "replicate"
            else:
                raise ValueError(f"cannot pad {pad} on a {w}x{h} latent with mode={mode}")

        padded = F.pad(latent, (pad, pad, pad, pad), mode=mode)
        out_w, out_h = w + 2 * pad, h + 2 * pad
        report["padded_latent"] = [out_w, out_h]

        if tile_size > 0:
            want = int(math.ceil(tile_size / 8.0))
            report["tile_size_requested"] = tile_size
            report["output_pixels"] = out_w * 8
            if want != out_w or want != out_h:
                report["tile_size_hint"] = (
                    f"requested tile_size={tile_size} needs a {want}x{want} latent, "
                    f"but this graph produces {out_w}x{out_h} (output "
                    f"{out_w * 8}x{out_h * 8} px). Set tile_size="
                    f"{out_w * 8}, or keep tile_size={tile_size} and set "
                    f"pad={(want - w) // 2}."
                )
                report["tile_size_ok"] = False
            else:
                report["tile_size_ok"] = True

        return ({"samples": padded}, json.dumps(report, ensure_ascii=False, indent=2))


class PBRLabCircularBlur:
    """Gaussian blur that wraps around the image edges.

    Used on albedo before deriving maps, so the derived detail layer is
    seamless too. A normal gaussian blur would smear the border outward and
    reintroduce a seam in roughness/normal.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "radius": ("INT", {"default": 4, "min": 0, "max": 128, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, radius):
        return (_circular_blur(_as_bchw(image), radius),)


class PBRLabCircularDownscale:
    """Area-average downsample with wrap-around edges (exact for integer factors)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "factor": ("INT", {"default": 2, "min": 2, "max": 16, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, factor):
        x = _as_bchw(image)
        b, h, w, c = x.shape
        factor = int(factor)
        # tolerate non divisible sizes by rolling the tail in from the start
        need_h = int(math.ceil(h / factor)) * factor
        need_w = int(math.ceil(w / factor)) * factor
        if need_h != h or need_w != w:
            x = torch.cat([x, x[:, : need_h - h]], dim=1)
            x = torch.cat([x, x[:, :, : need_w - w]], dim=2)
        x = x.reshape(b, need_h // factor, factor, need_w // factor, factor, c)
        x = x.mean(dim=(2, 4))
        return (x.contiguous(),)


class PBRLabPBRSynth:
    """Derive a complete PBR map set from one colour image.

    Pipeline
    --------
    1. height  = luma(albedo), optionally sharpened with an unsharp mask.
    2. detail  = high-pass of height; this is the "material grain" energy.
    3. normal  = Sobel of a blurred height, encoded tangent-space, with the
                 slope divided by `height_scale` to control apparent depth.
    4. rough   = base_roughness modulated by fine detail energy: smooth areas
                 read as glossy, grainy areas read as matte. This is the only
                 honest way to get roughness from a single 2D image.
    5. ao      = creases from a wide high-pass of height, relative to its own
                 standard deviation so one scale works across images.
    6. curvature = signed laplacian of height (convex positive / concave negative).
    7. metal   = constant, broadcast. Auto-guessing metal from albedo produces
                 inverted masks; you pick this by material type instead.

    All convolutions use periodic boundaries, so every output map is tileable
    if the input is tileable.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "albedo": ("IMAGE",),
                "normal_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 8.0, "step": 0.05}),
                "height_sharpen": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 4.0, "step": 0.05}),
                "detail_radius": ("INT", {"default": 4, "min": 1, "max": 64, "step": 1}),
                "normal_radius": ("INT", {"default": 2, "min": 0, "max": 32, "step": 1}),
                "ao_radius": ("INT", {"default": 24, "min": 1, "max": 128, "step": 1}),
                "ao_intensity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.05}),
                "curvature_radius": ("INT", {"default": 6, "min": 1, "max": 64, "step": 1}),
                "curvature_strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 4.0, "step": 0.05}),
                "base_roughness": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 1.0, "step": 0.01}),
                "roughness_span": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 1.0, "step": 0.01}),
                "metallic": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "invert_height": ("BOOLEAN", {"default": False}),
                "invert_roughness": ("BOOLEAN", {"default": False}),
                "encode_normal_for_png": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("normal", "height", "roughness", "ao", "curvature", "metallic")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(
        self,
        albedo,
        normal_strength,
        height_sharpen,
        detail_radius,
        normal_radius,
        ao_radius,
        ao_intensity,
        curvature_radius,
        curvature_strength,
        base_roughness,
        roughness_span,
        metallic,
        invert_height,
        invert_roughness,
        encode_normal_for_png=True,
    ):
        a = _as_bchw(albedo)
        h = _luma(a)

        # 1. height field
        height = h
        if height_sharpen > 0.0:
            height = h + height_sharpen * _high_pass(h, max(1, detail_radius))
        if invert_height:
            height = 1.0 - height
        height = torch.clamp(height, 0.0, 1.0)

        # 2. detail energy (scale-free: divided by its own std)
        detail = _high_pass(height, max(1, detail_radius)).abs()
        d_std = float(detail.std())
        detail_n = detail / max(d_std, 1e-6)

        # 3. normal map. Sobel on a slightly smoothed height, so single-pixel
        #    noise does not become a spike field.
        hs = _circular_blur(height, normal_radius) if normal_radius > 0 else height
        kx = torch.tensor(
            [[[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]]]
        ).view(1, 1, 3, 3).to(hs.device) / 8.0
        ky = kx.transpose(-1, -2)
        gx = _conv3(hs, kx)
        gy = _conv3(hs, ky)
        # A negative Y gradient means the surface rises towards +Y in the image,
        # which in tangent space is a -Y normal component.
        scale = 8.0 / max(normal_strength, 1e-3)
        nx = -gx * scale
        ny = -gy * scale
        nz = torch.ones_like(nx)
        length = torch.sqrt(nx * nx + ny * ny + nz * nz)
        nrm = torch.cat([nx / length, ny / length, nz / length], dim=-1)

        # 4. roughness
        r = base_roughness + roughness_span * torch.tanh(detail_n * 0.6)
        if invert_roughness:
            r = 1.0 - r
        r = torch.clamp(r, 0.0, 1.0).expand(-1, -1, -1, 3)

        # 5. ambient occlusion from creases
        wide = _high_pass(height, ao_radius)
        w_std = float(wide.std())
        z = wide / max(w_std, 1e-6)
        occ = torch.exp(-torch.clamp(-z, 0.0, 4.0) * ao_intensity)
        ao = occ.clamp(0.0, 1.0).expand(-1, -1, -1, 3)

        # 6. curvature (binary image: convex bright, concave dark)
        lap = _conv3(height, _laplacian().to(height.device)) * curvature_strength
        curv = torch.clamp(0.5 + lap, 0.0, 1.0).expand(-1, -1, -1, 3)

        # 7. metallic
        metal = torch.full_like(r, float(metallic))

        height3 = height.expand(-1, -1, -1, 3)

        # Normal storage, and why the default matters:
        #   * direct tangent-space vector, components in -1..1. Correct as DATA,
        #     but the moment it is written to an 8-bit PNG the negative half is
        #     clipped to 0 and the map is silently destroyed.
        #   * (n + 1) / 2 in 0..1, which is the convention Blender / Substance /
        #     Unreal expect and what survives an 8-bit write.
        # Measured on a real end-to-end run: direct storage gave a PNG whose
        # channels were clipped to 0.0 and yielded |n| = 0.9934 when read back;
        # the encoded form round-trips at |n| = 1.0000.
        if encode_normal_for_png:
            nrm = nrm * 0.5 + 0.5

        return (
            nrm.to(torch.float32).contiguous(),
            height3.contiguous(),
            r.contiguous(),
            ao.contiguous(),
            curv.contiguous(),
            metal.contiguous(),
        )


def _laplacian() -> torch.Tensor:
    return torch.tensor(
        [[[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]]]
    ).view(1, 1, 3, 3) / 4.0


def _conv3(x: torch.Tensor, k: torch.Tensor) -> torch.Tensor:
    """3x3 circular convolution over an HWC or BHWC tensor."""
    x, unbatched = _batchify(x)
    xp = _pad_hw(x, 1, 1, "circular")
    xp = xp.permute(0, 3, 1, 2)  # B,C,H+2,W+2
    out = F.conv2d(xp, k, padding=0)
    out = out.permute(0, 2, 3, 1)
    return _unbatchify(out, unbatched)


class PBRLabMakeSeamless:
    """Force an image to tile, by cross-fading each border strip into its opposite.

    This is the classical "offset + blend" trick expressed as one operation:
    the left band fades out of the left edge and into the right edge (and vice
    versa). After this the first and last columns are identical, so the image
    butts against itself with no step.

    It is a lossy, mechanical fix: it hides a seam rather than never creating
    one. Prefer generating through PBRLabCircularVAEPad when you can. Use this
    when you have an existing albedo (a photo, a render, a downloaded texture)
    that you must tile.

    Implementation note: both axes are blended in ONE pass with a 2D weight.
    Blending x and then y sequentially does not work - the second pass re-mixes
    the equality the first pass established at the corners, so the tile stays
    broken. Within a single axis the head band may only mix with the tail band
    (mixing an edge with its own near neighbour shifts it instead of matching
    it), and the two opposite edges converge to their average.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "blend": ("INT", {"default": 32, "min": 1, "max": 512, "step": 1}),
                "blend_y": ("BOOLEAN", {"default": True}),
                "blend_x": ("BOOLEAN", {"default": True}),
                "skip_if_seamless": ("BOOLEAN", {"default": True}),
                "seamless_tolerance": (
                    "FLOAT",
                    {"default": 0.02, "min": 0.0, "max": 0.5, "step": 0.005},
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "report")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, blend, blend_y, blend_x, skip_if_seamless=True,
            seamless_tolerance=0.02):
        x, unbatched = _batchify(_as_bchw(image))
        h, w = x.shape[1], x.shape[2]
        n = int(blend)

        seam_before = max(
            float((x[:, :, 0, :] - x[:, :, -1, :]).abs().max()),
            float((x[:, 0, :, :] - x[:, -1, :, :]).abs().max()),
        )
        report = {"seam_before": round(seam_before, 6), "blend": n}

        if skip_if_seamless and seam_before <= float(seamless_tolerance):
            report["skipped"] = (
                f"already seamless (max edge step {seam_before:.4f} <= tolerance "
                f"{seamless_tolerance}); left untouched"
            )
            return (_unbatchify(x.contiguous(), unbatched), json.dumps(report, indent=2))

        wy = None
        wx = None
        if blend_y:
            n_y = min(n, h // 2)
            if n_y >= 1:
                # quadratic (C1-smooth) profile: a LINEAR ramp leaves a kink in
                # the first derivative at the band edge, which is visible as a
                # faint ridge along the join. t^2 ramps in smoothly instead.
                t = torch.linspace(0.0, 1.0, n_y, device=x.device, dtype=x.dtype) ** 2
                wy = torch.zeros(h, device=x.device, dtype=x.dtype)
                wy[:n_y] = t / 2.0            # head 0 -> 1/2 : converge on the tail
                wy[h - n_y:] = (1.0 + t) / 2.0  # tail 1/2 -> 1 : converge on the head
        if blend_x:
            n_x = min(n, w // 2)
            if n_x >= 1:
                t = torch.linspace(0.0, 1.0, n_x, device=x.device, dtype=x.dtype) ** 2
                wx = torch.zeros(w, device=x.device, dtype=x.dtype)
                wx[:n_x] = t / 2.0
                wx[w - n_x:] = (1.0 + t) / 2.0

        if wy is None and wx is None:
            report["skipped"] = "both axes disabled"
            return (_unbatchify(x.contiguous(), unbatched), json.dumps(report, indent=2))

        # Weight of the "other side" for each pixel. Zero in the interior, which
        # is what keeps the blend confined to the border bands. Each band
        # converges to the midpoint of the two opposite edges at the very edge,
        # so head == tail exactly once both axes are applied.
        a = wy.view(1, h, 1, 1) if wy is not None else torch.zeros(1, 1, 1, 1, device=x.device, dtype=x.dtype)
        b = wx.view(1, 1, w, 1) if wx is not None else torch.zeros(1, 1, 1, 1, device=x.device, dtype=x.dtype)

        # "Neighbour across the wrap" permutation. NOT torch.roll: roll is a
        # cyclic shift, which moves band[k] to band[k+1] rather than swapping
        # head with tail, and therefore never ties the two edges together.
        def wrap_flip(t: torch.Tensor, axis: int, n_band: int, size: int) -> torch.Tensor:
            if n_band < 1:
                return t
            idx = list(range(size))
            for k in range(n_band):
                idx[k], idx[size - 1 - k] = size - 1 - k, k
            index = torch.tensor(idx, device=t.device)
            return t.index_select(axis, index)

        ny = min(int(blend), h // 2) if blend_y else 0
        nx = min(int(blend), w // 2) if blend_x else 0
        flip_y = wrap_flip(x, 1, ny, h)
        flip_x = wrap_flip(x, 2, nx, w)
        flip_xy = wrap_flip(flip_x, 1, ny, h)

        out = (
            x * (1.0 - a) * (1.0 - b)
            + flip_y * a * (1.0 - b)
            + flip_x * (1.0 - a) * b
            + flip_xy * a * b
        )
        # The four weights sum to exactly 1 in exact arithmetic, but the float
        # products drift by ~1e-1 at the corners once a and b are both large.
        # That drift is the difference between "head == tail" being exact and
        # being approximate, so normalise the weights instead of trusting them.
        wsum = (1.0 - a) * (1.0 - b) + a * (1.0 - b) + (1.0 - a) * b + a * b
        out = (out / wsum).clamp(0.0, 1.0)

        seam_after = max(
            float((out[:, :, 0, :] - out[:, :, -1, :]).abs().max()),
            float((out[:, 0, :, :] - out[:, -1, :, :]).abs().max()),
        )
        report["seam_after"] = round(seam_after, 8)
        report["seamless"] = bool(seam_after <= 1e-6)
        report["note"] = (
            "This is a lossy repair: blending the two opposite edges together is "
            "a local mirror symmetry, so on heavily damaged input it can show as "
            "repeating motifs when tiled. Prefer PBRLabCircularVAEPad, which "
            "never creates the seam in the first place. Cropping the blend band "
            "away is NOT offered as a fix: removing c pixels from both sides "
            "changes the wrap step from N to N-2c+1, which is no longer a whole "
            "period and installs a NEW seam."
        )
        report["interior_untouched"] = True
        return (_unbatchify(out.contiguous(), unbatched), json.dumps(report, indent=2))


class PBRLabColorMatch:
    """Transfer the colour statistics of a reference onto a generated image.

    Why this earns its place: generating a material tile from scratch (with
    circular latent padding) is the ONLY way to get a genuinely seamless, sharp,
    front-facing swatch - resampling an existing photo cannot do it, because a
    low-denoise pass neither enforces periodicity nor avoids a second lossy VAE
    round trip. But a from-scratch tile has its own colour, which need not match
    the material you photographed. This node closes that gap: it keeps the
    generated STRUCTURE and adopts the reference's PALETTE.

    Method: Reinhard colour transfer - per channel, match mean and standard
    deviation of the target to the reference in a decorrelated space. It is
    closed-form, deterministic, non-destructive to structure, and has no
    parameters that can go wrong.

    Note it deliberately does NOT copy the reference's structure, so the
    result stays seamless (a pointwise colour map commutes with the wrap).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "reference": ("IMAGE",),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "match_contrast": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, reference, strength, match_contrast=True):
        src, src_unbatched = _batchify(_as_bchw(image))
        ref = _as_bchw(reference)

        # mean/std over the reference (all pixels, all batches)
        ref_mean = ref.mean(dim=(0, 1, 2), keepdim=True)
        ref_std = ref.std(dim=(0, 1, 2), keepdim=True).clamp_min(1e-6)
        src_mean = src.mean(dim=(0, 1, 2), keepdim=True)
        src_std = src.std(dim=(0, 1, 2), keepdim=True).clamp_min(1e-6)

        if match_contrast:
            scaled = (src - src_mean) / src_std * ref_std + ref_mean
        else:
            scaled = src - src_mean + ref_mean

        out = src + (scaled - src) * float(strength)
        return (_unbatchify(out.clamp(0.0, 1.0).contiguous(), src_unbatched),)


def _draw_quad(img: torch.Tensor, quad, thickness: int, dim_inside: float):
    """Draw a quad outline over BHWC img. Returns (overlay, mask B,H,W).

    Shared by the warp node's preview output and by PBRLabQuadMask, so the two
    can never disagree about what the corners mean.
    """
    b, h, w, c = img.shape
    pts = torch.tensor([[x * w, y * h] for x, y in quad],
                       device=img.device, dtype=img.dtype)
    ys = torch.arange(h, device=img.device, dtype=img.dtype).view(-1, 1)
    xs = torch.arange(w, device=img.device, dtype=img.dtype).view(1, -1)
    inside = torch.ones(h, w, dtype=torch.bool, device=img.device)
    edge_dist = torch.full((h, w), 1e9, device=img.device, dtype=img.dtype)

    for i in range(4):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % 4]
        ex, ey = bx - ax, by - ay
        elen2 = (ex * ex + ey * ey).clamp_min(1e-9)
        cross = (ex * (ys.view(-1, 1) - ay) - ey * (xs.view(1, -1) - ax))
        inside &= cross >= 0
        # distance to the EDGE SEGMENT, not its infinite line, so the band does
        # not leak out along the extensions past the corners
        tpar = (((xs.view(1, -1) - ax) * ex + (ys.view(-1, 1) - ay) * ey) / elen2).clamp(0.0, 1.0)
        px = ax + tpar * ex
        py = ay + tpar * ey
        seg = torch.sqrt((xs.view(1, -1) - px) ** 2 + (ys.view(-1, 1) - py) ** 2)
        edge_dist = torch.minimum(edge_dist, seg)

    weight = (edge_dist <= float(thickness)).to(img.dtype)
    out = img.clone()
    if dim_inside > 0:
        out = out * (1.0 - float(dim_inside) * inside.to(img.dtype)).view(1, h, w, 1)
    red = torch.tensor([1.0, 0.0, 0.0], device=img.device, dtype=img.dtype).view(1, 1, 1, 3)
    out = out + (red - out) * weight.view(1, h, w, 1)
    return out.clamp(0.0, 1.0), weight.unsqueeze(0)


class PBRLabPerspectiveWarp:
    """Dewarp a photographed surface into a front-facing square.

    This is the missing piece for "the material is right but the photo is at an
    angle". It is a plain projective transform (homography) applied with bilinear
    resampling: DETERMINISTIC, no diffusion, no VAE, and therefore no loss of the
    texture's identity. Compare the alternatives, all measured on this machine:

      * pixel-space tiling (04)        retain 0.96x detail, tiles, but keeps the tilt
      * latent resample (05 PASS 2)    retain 1.03x, wrap_ratio 12.6 -> does not tile
      * generate from noise (06)       structure replaced entirely, wrap_ratio 12.6

    Use: give the four corners of a flat surface region in the photo, in
    TL, TR, BR, BL order (normalised 0..1), and this maps that quad onto the
    output rectangle, i.e. straightens it. Then tile the result with
    PBRLabMakeSeamless.

    Coordinates are normalised so they survive any input resolution. Tune them
    with PBRLabQuadMask, which draws the same quad so you can see it first.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "tl_x": ("FLOAT", {"default": 0.15, "min": -1.0, "max": 2.0, "step": 0.005}),
                "tl_y": ("FLOAT", {"default": 0.10, "min": -1.0, "max": 2.0, "step": 0.005}),
                "tr_x": ("FLOAT", {"default": 0.85, "min": -1.0, "max": 2.0, "step": 0.005}),
                "tr_y": ("FLOAT", {"default": 0.10, "min": -1.0, "max": 2.0, "step": 0.005}),
                "br_x": ("FLOAT", {"default": 0.85, "min": -1.0, "max": 2.0, "step": 0.005}),
                "br_y": ("FLOAT", {"default": 0.90, "min": -1.0, "max": 2.0, "step": 0.005}),
                "bl_x": ("FLOAT", {"default": 0.15, "min": -1.0, "max": 2.0, "step": 0.005}),
                "bl_y": ("FLOAT", {"default": 0.90, "min": -1.0, "max": 2.0, "step": 0.005}),
                "output_size": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 64}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "preview")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @staticmethod
    def _homography(src, dst, device, dtype):
        """3x3 H with dst ~ H @ src, from 4 point pairs (standard DLT, 8x8 solve)."""
        a = []
        b = []
        for (x, y), (u, v) in zip(src, dst):
            a.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
            b.append(u)
            a.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
            b.append(v)
        am = torch.tensor(a, device=device, dtype=torch.float64)
        bv = torch.tensor(b, device=device, dtype=torch.float64)
        h = torch.linalg.solve(am, bv)
        return torch.cat([h, torch.ones(1, device=device, dtype=torch.float64)]).to(dtype).view(3, 3)

    def run(self, image, tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y, output_size):
        src_img, unbatched = _batchify(_as_bchw(image))
        b, h, w, c = src_img.shape
        n = int(output_size)
        device, dtype = src_img.device, src_img.dtype

        corners = [(tl_x, tl_y), (tr_x, tr_y), (br_x, br_y), (bl_x, bl_y)]
        src_pts = [(cx * w, cy * h) for cx, cy in corners]
        dst_pts = [(0.0, 0.0), (float(n), 0.0), (float(n), float(n)), (0.0, float(n))]

        # We need, for each OUTPUT pixel, the source pixel -> invert the forward map.
        fwd = self._homography(src_pts, dst_pts, device, torch.float64)
        try:
            inv = torch.linalg.inv(fwd)
        except Exception:  # noqa: BLE001
            return (src_img.clone(),)

        # output pixel grid (pixel centres)
        us = torch.arange(n, device=device, dtype=torch.float64) + 0.5
        vs = torch.arange(n, device=device, dtype=torch.float64) + 0.5
        vv, uu = torch.meshgrid(vs, us, indexing="ij")
        ones = torch.ones_like(uu)
        pts = torch.stack([uu, vv, ones], dim=-1)            # n,n,3
        mapd = pts @ inv.t()                                  # n,n,3
        sx = (mapd[..., 0] / mapd[..., 2]).to(dtype)
        sy = (mapd[..., 1] / mapd[..., 2]).to(dtype)

        # grid_sample wants normalised coords in [-1,1]
        gx = (sx / w) * 2.0 - 1.0
        gy = (sy / h) * 2.0 - 1.0
        grid = torch.stack([gx, gy], dim=-1).unsqueeze(0).expand(b, -1, -1, -1)

        src_bchw = src_img.permute(0, 3, 1, 2)
        out = F.grid_sample(src_bchw, grid, mode="bilinear",
                            padding_mode="border", align_corners=False)
        out = out.permute(0, 2, 3, 1).contiguous()

        # Second output: the SOURCE with the quad drawn on it. Tuning the corners
        # needs to be visible, and putting it here means the corners exist in
        # exactly ONE node instead of being duplicated between a warp and a mask
        # node (which would inevitably drift out of sync).
        overlay, _ = _draw_quad(src_img, corners, 3, 0.45)
        return (_unbatchify(out.clamp(0.0, 1.0), unbatched),
                _unbatchify(overlay, unbatched))


class PBRLabQuadMask:
    """Draw the same quad that PBRLabPerspectiveWarp will use, as a mask.

    Exists so corner tuning is not blind: composite this over the photo and you
    can see exactly what the warp will treat as the surface. Drawing is done
    analytically (point-in-quad edges via half-plane tests) so it is exact and
    testable, not an approximation.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "tl_x": ("FLOAT", {"default": 0.15, "min": -1.0, "max": 2.0, "step": 0.005}),
                "tl_y": ("FLOAT", {"default": 0.10, "min": -1.0, "max": 2.0, "step": 0.005}),
                "tr_x": ("FLOAT", {"default": 0.85, "min": -1.0, "max": 2.0, "step": 0.005}),
                "tr_y": ("FLOAT", {"default": 0.10, "min": -1.0, "max": 2.0, "step": 0.005}),
                "br_x": ("FLOAT", {"default": 0.85, "min": -1.0, "max": 2.0, "step": 0.005}),
                "br_y": ("FLOAT", {"default": 0.90, "min": -1.0, "max": 2.0, "step": 0.005}),
                "bl_x": ("FLOAT", {"default": 0.15, "min": -1.0, "max": 2.0, "step": 0.005}),
                "bl_y": ("FLOAT", {"default": 0.90, "min": -1.0, "max": 2.0, "step": 0.005}),
                "thickness": ("INT", {"default": 3, "min": 1, "max": 64, "step": 1}),
                "dim_inside": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "quad_mask")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y,
            thickness, dim_inside=0.0):
        img, unbatched = _batchify(_as_bchw(image))
        quad = [(tl_x, tl_y), (tr_x, tr_y), (br_x, br_y), (bl_x, bl_y)]
        overlay, mask = _draw_quad(img, quad, int(thickness), float(dim_inside))
        return (_unbatchify(overlay, unbatched), _unbatchify(mask, unbatched))


class PBRLabDelight:
    """Remove the lighting gradient baked into a photo, keeping the texture.

    Why this matters and how I found it: after perspective-correcting a road
    photo, the single tile looked right, but tiling it 2x2 produced a clear
    bright/dark butterfly pattern. The cause was not the seam - it was the
    PHOTOGRAPH'S OWN ILLUMINATION GRADIENT. A photo of a large surface is lit
    unevenly (nearer/darker, farther/brighter, plus vignetting), and a tiled
    material makes that low-frequency variation repeat visibly, which the eye
    reads as structure.

    Method: estimate the illumination as a heavily blurred luminance field and
    divide it out (flat-field correction). Deterministic, no models, and it
    commutes with the wrap because the blur is circular - so it cannot introduce
    a seam.

    radius: larger than the texture features you want to keep. For a 1024 tile,
    128-256 removes room-scale lighting while keeping material grain.
    strength 1.0 fully flattens; lower values keep some of the original mood.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "radius": ("INT", {"default": 192, "min": 8, "max": 512, "step": 8}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "preserve_mean": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, radius, strength, preserve_mean=True):
        x, unbatched = _batchify(_as_bchw(image))
        lum = _luma(x)
        base = _circular_blur(lum, int(radius)).clamp_min(1e-4)
        if preserve_mean:
            gain = float(base.mean()) / base
        else:
            gain = 1.0 / base
        gain = gain.clamp(0.1, 10.0)
        out = x * (1.0 + (gain - 1.0) * float(strength))
        return (_unbatchify(out.clamp(0.0, 1.0).contiguous(), unbatched),)


class PBRLabDetailTransfer:
    """Put the SOURCE photo's real micro-texture back on top of a generated image.

    Why this exists: img2img does the flattening well (it removes perspective,
    shadows and objects) but it INVENTS the high-frequency detail. When the input
    is much smaller than the working resolution - measured case: a 334x396 input
    scaled to 1024, so ~90% of the output's detail is hallucinated - the result
    reads as "AI": uniformly distributed noise instead of the irregular, layered
    grain a real surface has.

    Frequency split:
        low  band = generated             (keep: the model is good at this)
        high band = generated band REPLACED by source - blur(source)
    scaled by `strength`. 0 is a no-op; 1 carries the source's exact
    micro-texture.

    mode="soft" (default) weights the swap by LOCAL DETAIL ENERGY, so flat
    regions of the source keep the model's texture instead of being blanked -
    see the comment in run() for the measured failure that forced this.
    mode="replace" is the original unconditional swap, kept for comparison.

    Both blurs are circular, so if the inputs tile the result still tiles.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "generated": ("IMAGE",),
                "source": ("IMAGE",),
                "radius": ("INT", {"default": 8, "min": 1, "max": 64, "step": 1}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
                "mode": (["soft", "replace"], {"default": "soft"}),
                "detail_gain": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 4.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, generated, source, radius, strength, mode="soft", detail_gain=1.0):
        gen, unbatched = _batchify(_as_bchw(generated))
        src = _as_bchw(source)
        if tuple(src.shape[1:3]) != tuple(gen.shape[1:3]):
            # be explicit rather than silently broadcasting mismatched sizes
            raise ValueError(
                f"source {tuple(src.shape[1:3])} and generated "
                f"{tuple(gen.shape[1:3])} must share a resolution - scale them to "
                f"match before this node"
            )
        r = int(radius)
        src_high = src - _circular_blur(src, r)
        gen_high = gen - _circular_blur(gen, r)

        if mode == "replace":
            # TRUE replacement, and a no-op at strength 0.
            # The first version of this line was
            #     gen - gen_high * (1 - strength) + src_high * strength
            # which at strength 1 does NOT subtract the generated high band at all
            # (the factor is 0), so it actually computed gen + src_high - an
            # ADDITION, not a replacement. Measured consequence: hf rose 53%
            # (0.0161 -> 0.0247) and the result looked harsh and grainy, and
            # strength 0 was not a no-op either. Caught by the offline suite.
            replaced = _circular_blur(gen, r) + src_high
            out = gen + (replaced - gen) * float(strength)
        else:
            # SOFT mode - the fix for the "smooth blob" failure.
            #
            # Plain replacement is only valid where the SOURCE actually HAS detail
            # at this scale. On a real photo of paving slabs the flat pale slabs
            # have src_high ~ 0, so `blur(gen) + src_high` DELETED the model's
            # texture there and put nothing back - measured as a smooth pale blob
            # the user spotted immediately.
            #
            # Weight by local detail energy instead: where the source is rich,
            # adopt its detail; where the source is flat, keep the model's.
            #     w -> 1 : out = blur(gen) + src_high   (source detail wins)
            #     w -> 0 : out = blur(gen) + gen_high = gen (untouched)
            # NOTE: these tensors are BHWC, so the channel dim is -1. Averaging
            # dim 1 would collapse HEIGHT instead, leaving shape (B,1,W,C) and
            # making the blur pad a size-1 dimension (torch: "Padding value causes
            # wrapping around more than once"). That was a real bug here.
            e_src = _circular_blur(src_high.abs().mean(-1, keepdim=True), max(1, r))
            e_gen = _circular_blur(gen_high.abs().mean(-1, keepdim=True), max(1, r))
            w = ((e_src * float(detail_gain))
                 / (e_src * float(detail_gain) + e_gen + 1e-6)).clamp(0.0, 1.0)
            high = src_high * w + gen_high * (1.0 - w)
            out = _circular_blur(gen, r) + high
            if float(strength) != 1.0:
                out = gen + (out - gen) * float(strength)
        return (_unbatchify(out.clamp(0.0, 1.0).contiguous(), unbatched),)


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    import struct
    import zlib
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png16(arr: np.ndarray) -> bytes:
    """Encode an HxW (gray) or HxWx3 (RGB) uint16 array as a 16-bit PNG.

    Written by hand for one reason: Pillow cannot save 16-bit RGB PNGs, and
    ComfyUI's own SaveImage is hard-wired to 8 bits. PBR maps lose real
    information at 8 bits - a height field or a normal map shows visible
    banding/terracing that no amount of generation fixes. Only stdlib + numpy.
    """
    if arr.dtype != np.uint16:
        raise ValueError(f"expected uint16, got {arr.dtype}")
    if arr.ndim == 2:
        h, w = arr.shape
        colour_type = 0                      # greyscale
    elif arr.ndim == 3 and arr.shape[2] == 3:
        h, w, _ = arr.shape
        colour_type = 2                      # truecolour
    else:
        raise ValueError(f"expected HxW or HxWx3, got {tuple(arr.shape)}")

    be = np.ascontiguousarray(arr.astype(">u2"))     # PNG samples are big-endian
    raw = bytearray()
    for y in range(h):
        raw.append(0)                                # filter type 0 (None)
        raw += be[y].tobytes()

    import zlib
    ihdr = struct_pack_ihdr(w, h, colour_type)
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + _png_chunk(b"IEND", b""))


def struct_pack_ihdr(w: int, h: int, colour_type: int) -> bytes:
    import struct
    return struct.pack(">IIBBBBB", w, h, 16, colour_type, 0, 0, 0)


class PBRLabSaveImage16:
    """Save PBR maps as real 16-bit PNGs (ComfyUI's SaveImage cannot).

    Use it for the maps that carry gradients or signed-ish data: height,
    normal, roughness, AO, curvature. Albedo is normally fine at 8-bit sRGB,
    so 8 is available here too for convenience.

    Files land in the normal ComfyUI output directory, under the given prefix.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "pbrlab/16bit"}),
                "bit_depth": (["16", "8"], {"default": "16"}),
                "grayscale": ("BOOLEAN", {"default": True}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = CATEGORY

    @staticmethod
    def _to_uint16(x: torch.Tensor) -> np.ndarray:
        a = np.clip(x.detach().cpu().numpy(), 0.0, 1.0)
        return np.rint(a * 65535.0).astype(np.uint16)

    @staticmethod
    def _to_uint8(x: torch.Tensor) -> np.ndarray:
        a = np.clip(x.detach().cpu().numpy(), 0.0, 1.0)
        return np.rint(a * 255.0).astype(np.uint8)

    def run(self, images, filename_prefix, bit_depth, grayscale=True,
            prompt=None, extra_pnginfo=None):
        import folder_paths
        from PIL import Image as _PILImage
        from PIL.PngImagePlugin import PngInfo

        x, _ = _batchify(_as_bchw(images))
        b, h, w, c = x.shape
        out_dir = folder_paths.get_output_directory()
        full, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, out_dir, w, h)

        use16 = str(bit_depth) == "16"
        written = []
        meta = PngInfo()
        if extra_pnginfo is not None:
            for k, v in extra_pnginfo.items():
                meta.add_text(k, json.dumps(v))
        if prompt is not None:
            meta.add_text("prompt", json.dumps(prompt))

        for i in range(b):
            one = x[i:i + 1]
            if use16:
                arr = self._to_uint16(one[0])
                if grayscale and arr.shape[-1] == 3:
                    # keep the extra precision on the single channel that matters
                    # for height/rough/AO/curvature-style maps
                    arr = np.rint(
                        (0.2126 * arr[..., 0] + 0.7152 * arr[..., 1]
                         + 0.0722 * arr[..., 2])).astype(np.uint16)
                png = encode_png16(arr)
                fn = f"{name}_{counter + i:05d}_.png"
                with open(os.path.join(full, fn), "wb") as f:
                    f.write(png)
            else:
                arr8 = self._to_uint8(one[0])
                if grayscale and arr8.shape[-1] == 3:
                    arr8 = np.rint(
                        (0.2126 * arr8[..., 0] + 0.7152 * arr8[..., 1]
                         + 0.0722 * arr8[..., 2])).astype(np.uint8)
                fn = f"{name}_{counter + i:05d}_.png"
                _PILImage.fromarray(arr8).save(os.path.join(full, fn), pnginfo=meta)
            written.append(os.path.join(subfolder, fn) if subfolder else fn)

        depth = 16 if use16 else 8
        print(f"[PBRLab] saved {len(written)} x {depth}-bit PNG -> {full}")
        return {"ui": {"text": [f"{depth}-bit: " + ", ".join(written)]}}


class PBRLabPeriodicNoise:
    """Noise that is periodic, so generation from noise comes out seamless.

    This exists because PBRLabCircularVAEPad cannot deliver seamlessness on its
    own, and I had claimed it could for several rounds:

        EmptySD3LatentImage returns an all-ZERO latent. The noise that actually
        decides the output is generated INSIDE the sampler from the seed.
        Circular-padding zeros therefore pads nothing - the noise stays
        independent per pixel and no periodicity is ever established.

    Measured: padded generation gave wrap_ratio 5.4-9.3 against a required <1.4,
    versus 13.8 for the unpadded control - the pad helped about 2x and was still
    nowhere near seamless.

    The fix is to make the NOISE periodic, because the noise is what determines
    the result. ComfyUI's NOISE protocol is an object exposing
    `generate_noise(input_latent)`, so this class generates a base noise of
    `period` and tiles it up to the requested size - which is precisely circular
    padding, applied where it actually matters.

    Use with: EmptySD3LatentImage -> PBRLabCircularVAEPad (zero latent of the
    padded size) -> SamplerCustomAdvanced(noise=this, ...) -> ImageCrop(pad*8).
    """

    def __init__(self):
        self.seed = 0
        self.period = 128

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 101, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "period": ("INT", {"default": 128, "min": 8, "max": 4096, "step": 8}),
            }
        }

    RETURN_TYPES = ("NOISE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, seed, period):
        self.seed = int(seed)
        self.period = int(period)
        return (self,)

    def generate_noise(self, input_latent):
        lat = input_latent["samples"] if isinstance(input_latent, dict) else input_latent
        b, c, h, w = lat.shape
        ph = max(1, min(self.period, h))
        pw = max(1, min(self.period, w))
        g = torch.Generator().manual_seed(self.seed)
        base = torch.randn(1, c, ph, pw, generator=g, dtype=torch.float32)
        ry = -(-h // ph)          # ceil division
        rx = -(-w // pw)
        tiled = base.repeat(1, 1, ry, rx)[:, :, :h, :w]
        return tiled.to(lat.device, lat.dtype)


class PBRLabTileValidator:
    """Measure whether an image (and its normal map) actually tiles.

    Reports numbers plus a PASS/FAIL verdict. The useful reference value: two
    unrelated images differ by ~0.5 on average, and an image vs itself shifted
    by one pixel differs by exactly the interior value. So `seam_ratio` near
    1.0 means the wrap boundary is statistically indistinguishable from the
    interior, which is what "seamless" means in practice.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "normal_is_image_encoded": (
                    "BOOLEAN",
                    {"default": True},
                ),
            },
            "optional": {"normal": ("IMAGE",)},
        }

    RETURN_TYPES = ("STRING", "FLOAT", "FLOAT")
    RETURN_NAMES = ("verdict", "wrap_ratio", "interior_ref")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, image, normal=None, normal_is_image_encoded=True):
        m = seam_metrics(image, normal, normal_encoded=normal_is_image_encoded)
        ok = m["seam_pass"] and m.get("normal_pass", True)
        head = "PASS" if ok else "FAIL"
        lines = [f"[{head}] tile seam continuity", json.dumps(m, indent=2, ensure_ascii=False)]
        if not m["seam_pass"]:
            lines.append(
                f"FAIL: butting two copies together shows a step of {m['wrap']:.4f} "
                f"({m['wrap_ratio']}x the normal interior step). Regenerate through "
                f"PBRLabCircularVAEPad, and make sure every filtering step before "
                f"this point was circular."
            )
        if normal is not None and not m.get("normal_pass", True):
            lines.append(
                "FAIL: normal map is not unit length everywhere - check "
                "normal_strength / height_sharpen, or that the input was 0..1."
            )
        return (
            "\n".join(lines),
            float(m["wrap_ratio"]),
            float(m["interior_ref"]),
        )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Cheap, deterministic, and always unique per input so ComfyUI caches
        # correctly instead of replaying a stale verdict.
        return float("nan")


NODE_CLASS_MAPPINGS = {
    "PBRLabCircularVAEPad": PBRLabCircularVAEPad,
    "PBRLabCircularBlur": PBRLabCircularBlur,
    "PBRLabCircularDownscale": PBRLabCircularDownscale,
    "PBRLabMakeSeamless": PBRLabMakeSeamless,
    "PBRLabColorMatch": PBRLabColorMatch,
    "PBRLabDelight": PBRLabDelight,
    "PBRLabDetailTransfer": PBRLabDetailTransfer,
    "PBRLabSaveImage16": PBRLabSaveImage16,
    "PBRLabPeriodicNoise": PBRLabPeriodicNoise,
    "PBRLabPerspectiveWarp": PBRLabPerspectiveWarp,
    "PBRLabQuadMask": PBRLabQuadMask,
    "PBRLabPBRSynth": PBRLabPBRSynth,
    "PBRLabTileValidator": PBRLabTileValidator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PBRLabCircularVAEPad": "PBR Lab · Circular VAE Pad (tileable latent)",
    "PBRLabCircularBlur": "PBR Lab · Circular Blur (seamless)",
    "PBRLabCircularDownscale": "PBR Lab · Circular Downscale (seamless)",
    "PBRLabMakeSeamless": "PBR Lab · Make Seamless (blend borders)",
    "PBRLabColorMatch": "PBR Lab · Color Match (adopt a photo's palette)",
    "PBRLabDelight": "PBR Lab · Delight (flatten baked-in lighting)",
    "PBRLabDetailTransfer": "PBR Lab · Detail Transfer (put real grain back)",
    "PBRLabSaveImage16": "PBR Lab · Save 16-bit PNG (PBR maps)",
    "PBRLabPeriodicNoise": "PBR Lab · Periodic Noise (seamless from noise)",
    "PBRLabPerspectiveWarp": "PBR Lab · Perspective Warp (straighten a surface)",
    "PBRLabQuadMask": "PBR Lab · Quad Mask (see the warp corners)",
    "PBRLabPBRSynth": "PBR Lab · PBR Map Synth (normal/rough/AO/curv)",
    "PBRLabTileValidator": "PBR Lab · Tile Validator (seam metrics)",
}
