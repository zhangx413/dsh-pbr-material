#!/usr/bin/env python
"""Saturation-gated (hue-selective) colour match: generated swatch -> reference palette.

Why this is not a plain Reinhard transfer: a per-channel mean/std match scales
EVERY pixel, so when the reference palette is warm the neutral pixels (bare
metal, white chips, dust) also get their blue channel raised and come back
CYAN. Measured. The fix is to only touch pixels that are actually colourful.

The reference's paint colour is estimated with a HUE MASK, never by hand-picking
a "pure paint" crop — hand-picking framed the object's frame and shadow and
produced a wrong target.

Output: same resolution as --src.

CLI:
  python hue_colormatch.py --src gen.png --ref photo.png --out matched.png \
      --strength 0.6 --hue-lo 5 --hue-hi 35 --min-sat 0.25
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
from PIL import Image

# Orange-red by default; --hue-lo/--hue-hi override.
HUE_LO, HUE_HI = 5.0, 35.0


def rgb_to_hsv_np(rgb: np.ndarray) -> np.ndarray:
    """rgb float [0,1] HxWx3 -> hsv (h in degrees 0-360, s/v 0-1)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-8
    safe = np.where(d == 0, 1, d)
    idx = nz & (mx == r)
    h[idx] = (60 * ((g - b) / safe))[idx] % 360
    idx = nz & (mx == g)
    h[idx] = (60 * ((b - r) / safe) + 120)[idx]
    idx = nz & (mx == b)
    h[idx] = (60 * ((r - g) / safe) + 240)[idx]
    s = np.where(mx > 1e-8, d / np.where(mx == 0, 1, mx), 0.0)
    return np.stack([h, s, mx], -1)


def hsv_to_rgb_np(hsv: np.ndarray) -> np.ndarray:
    h, s, v = hsv[..., 0] % 360, np.clip(hsv[..., 1], 0, 1), np.clip(hsv[..., 2], 0, 1)
    c = v * s
    x = c * (1 - np.abs((h / 60.0) % 2 - 1))
    m = v - c
    z = np.zeros_like(h)
    conds = [(h < 60), (h < 120), (h < 180), (h < 240), (h < 300), (h <= 360)]
    r = np.select(conds, [c, x, z, z, x, c])
    g = np.select(conds, [x, c, c, x, z, z])
    b = np.select(conds, [z, z, x, c, c, x])
    return np.clip(np.stack([r + m, g + m, b + m], -1), 0, 1)


def paint_stats(rgb, hue_lo=HUE_LO, hue_hi=HUE_HI, min_sat=0.25, min_val=0.10,
                min_pixels=50):
    """Robustly estimate the paint colour: only hue-in-range, saturated pixels."""
    hsv = rgb_to_hsv_np(rgb)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = (h >= hue_lo) & (h <= hue_hi) & (s >= min_sat) & (v >= min_val)
    n = int(m.sum())
    if n < min_pixels:
        return None, n
    px = rgb[m]
    return dict(mean=px.mean(0), std=px.std(0), n=n), n


def apply_selective(src, tgt, strength=1.0, sat_gate=0.18,
                    hue_lo=HUE_LO, hue_hi=HUE_HI, min_sat=0.25, min_val=0.10):
    """Move only the colourful pixels toward the target; neutrals stay put."""
    hsv = rgb_to_hsv_np(src)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]

    st, _ = paint_stats(src, hue_lo, hue_hi, min_sat, min_val)
    if st is None or tgt is None:
        return src

    th, ts, tv = rgb_to_hsv_np(tgt["mean"][None, None, :])[0, 0]
    sh, ss, sv = rgb_to_hsv_np(st["mean"][None, None, :])[0, 0]
    dh = ((th - sh + 180) % 360) - 180            # shortest way round the circle
    h2 = (h + dh * strength) % 360
    s2 = np.clip(s * (ts / max(ss, 1e-3)) ** strength, 0, 1)
    v2 = np.clip(v * (tv / max(sv, 1e-3)) ** strength, 0, 1)
    out = hsv_to_rgb_np(np.stack([h2, s2, v2], -1))

    # Soft saturation gate. 1.0 overshoots (orange-red became dark red-brown);
    # ~0.6 matched the reference.
    w = np.clip((s - sat_gate) / 0.12, 0, 1)[..., None] * strength
    return np.clip(src * (1 - w) + out * w, 0, 1)


def load_rgb(path):
    img = Image.open(path)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    return np.asarray(img.convert("RGB")).astype(np.float64) / 255.0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", required=True, help="generated material image (PNG)")
    ap.add_argument("--ref", required=True, help="reference photo (PNG/JPEG)")
    ap.add_argument("--out", required=True, help="output PNG")
    ap.add_argument("--strength", type=float, default=0.6)
    ap.add_argument("--hue-lo", type=float, default=HUE_LO)
    ap.add_argument("--hue-hi", type=float, default=HUE_HI)
    ap.add_argument("--min-sat", type=float, default=0.25)
    ap.add_argument("--min-val", type=float, default=0.10)
    ap.add_argument("--sat-gate", type=float, default=0.18)
    a = ap.parse_args(argv)

    src = load_rgb(a.src)
    ref = load_rgb(a.ref)
    tgt, n = paint_stats(ref, a.hue_lo, a.hue_hi, a.min_sat, a.min_val)

    report = {
        "hue_range": [a.hue_lo, a.hue_hi],
        "strength": a.strength,
        "reference_paint_pixels": n,
        "applied": tgt is not None,
    }
    if tgt is None:
        report["note"] = (
            f"only {n} reference pixels fell inside hue [{a.hue_lo}, {a.hue_hi}] "
            "with enough saturation - colour match skipped, source copied through"
        )
        out = src
    else:
        report["target_rgb"] = [round(float(x), 4) for x in tgt["mean"]]
        out = apply_selective(src, tgt, a.strength, a.sat_gate,
                              a.hue_lo, a.hue_hi, a.min_sat, a.min_val)
        if src.shape != out.shape:
            raise SystemExit("internal error: shape changed")

    Image.fromarray((out * 255.0 + 0.5).astype(np.uint8)).save(a.out)
    report["out"] = a.out
    report["size"] = [int(out.shape[1]), int(out.shape[0])]
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
