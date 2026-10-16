#!/usr/bin/env python
"""Measure whether a PBR map set actually tiles, and look at the normal map.

Why this exists as a script instead of reading a graph node: ComfyUI's /history
keeps only SaveImage's `images`; PBRLabTileValidator returns a STRING and that
output is dropped, so its verdict cannot be read back programmatically. The
honest move is to measure the files that were written.

The metric definitions below are byte-for-byte the ones PBRLabTileValidator
uses (`seam_metrics` in the pbrlab pack), including the 0.002 interior floor and
the `<= 1.4 or wrap <= 0.02` pass rule, so a number reported here can be
compared directly with the verdict shown in the ComfyUI GUI:

  wrap        mean |first - last| across the wrap boundary   (primary signal)
  wrap_max    extreme value at the boundary; blunt veto only (>0.5 = hard seam).
              A single pixel dominates it, so it is never the pass criterion.
  interior    max(mean |adjacent| along x, along y), floored at 0.002 so that
              flat maps (constant metallic, face normal, low-contrast curvature)
              cannot blow the ratio up towards infinity
  wrap_ratio  wrap / interior

  Calibrated on this host (256x256): exactly periodic 0.00, circular-blurred
  periodic 0.25, white noise 0.99, periodic content with a hard seam 4.68.

The correct discrete criterion is "after tiling, the last column equals the
first". Never use a diagonal roll for this: on a separable field it doubles the
error, so a perfect sine FAILs while white noise PASSes.

CLI:
  python measure_maps.py --dir <map dir> [--normal <path>] [--preview]
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import struct
import sys
import zlib

import numpy as np
from PIL import Image

WRAP_RATIO_THRESHOLD = 1.4
WRAP_ABS_FLOOR = 0.02
WRAP_MAX_VETO = 0.5
INTERIOR_FLOOR = 0.002

MAP_ORDER = ["albedo", "normal", "height", "roughness", "ao", "curvature", "metallic"]

PNG_COLOR_TYPES = {0: "gray", 2: "rgb", 3: "palette", 4: "gray+alpha", 6: "rgba"}


def png_header(path):
    """Read IHDR directly: PIL silently narrows 16-bit RGB PNGs to 8-bit."""
    with open(path, "rb") as fh:
        head = fh.read(26)
    if len(head) < 26 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return {}
    width, height = struct.unpack(">II", head[16:24])
    return {
        "width": width,
        "height": height,
        "file_bits": head[24],
        "color_type": PNG_COLOR_TYPES.get(head[25], str(head[25])),
    }


def decode_png16(path):
    """Decode a 16-bit gray/RGB PNG at full precision.

    Pillow narrows 16-bit RGB to 8-bit and gives no warning, which silently
    quantizes exactly the map that needs the precision (the normal map). The
    pbrlab encoder writes every scanline with filter type 0, so the common path
    here is a pure reshape; the other filters are decoded too, for PNGs that
    came from somewhere else.
    """
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"not a PNG: {path}")
    pos = 8
    idat = bytearray()
    w = h = depth = ctype = None
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 16 or ctype not in (0, 2, 4, 6) or interlace != 0:
                raise ValueError(f"unsupported PNG: depth={depth} colour={ctype} interlace={interlace}")
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
    raw = zlib.decompress(bytes(idat))
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    stride = w * ch * 2
    bpp = ch * 2
    rows = np.frombuffer(raw, dtype=np.uint8).reshape(h, stride + 1)
    filters = rows[:, 0]
    if not filters.any():
        out = rows[:, 1:].copy().view(">u2").reshape(h, w, ch)
        return out.astype(np.float64) / 65535.0, ch

    acc = np.zeros((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.int32)
    for y in range(h):
        ftype = int(filters[y])
        line = rows[y, 1:].astype(np.int32)
        if ftype == 0:
            pass
        elif ftype == 1:
            line = line.reshape(-1, bpp)
            line = np.cumsum(line, axis=0) & 0xFF
            line = line.reshape(-1)
        elif ftype == 2:
            line = (line + prev) & 0xFF
        elif ftype in (3, 4):
            cur = line.copy()
            for i in range(stride):
                a = int(cur[i - bpp]) if i >= bpp else 0
                b = int(prev[i])
                c = int(prev[i - bpp]) if i >= bpp else 0
                if ftype == 3:
                    pred = (a + b) >> 1
                else:
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (int(line[i]) + pred) & 0xFF
            line = cur
        else:
            raise ValueError(f"unknown PNG filter {ftype}")
        acc[y] = line & 0xFF
        prev = line
    out = acc.copy().view(">u2").reshape(h, w, ch)
    return out.astype(np.float64) / 65535.0, ch


def load_array(path):
    """-> (float array [0,1] HxWxC, meta).

    16-bit PNGs are decoded by hand so that "16-bit" in the metadata means the
    numbers really came from 16-bit samples.
    """
    header = png_header(path)
    if header.get("file_bits") == 16:
        arr, ch = decode_png16(path)
        header.update({"mode": f"16-bit/{ch}ch", "decoded_bits": 16, "channels": ch})
        return (arr if arr.shape[-1] == 3 else np.repeat(arr, 3, axis=-1)), {
            **header,
            "channels": int(arr.shape[-1]),
        }
    img = Image.open(path)
    a = np.asarray(img.convert("RGB")).astype(np.float64) / 255.0
    header.update({"mode": img.mode, "decoded_bits": 8, "channels": int(a.shape[2])})
    return a, header


def seam_metrics(a: np.ndarray) -> dict:
    dx = np.abs(a[:, 0, :] - a[:, -1, :])
    dy = np.abs(a[0, :, :] - a[-1, :, :])

    ref = max(
        float(np.abs(a[:, 1:, :] - a[:, :-1, :]).mean()),
        float(np.abs(a[1:, :, :] - a[:-1, :, :]).mean()),
    )
    ref = max(ref, INTERIOR_FLOOR)

    wrap_x = float(dx.mean())
    wrap_y = float(dy.mean())
    wrap = max(wrap_x, wrap_y)
    wrap_max = max(float(dx.max()), float(dy.max()))
    ratio = wrap / ref
    hard_seam = wrap_max > WRAP_MAX_VETO
    return {
        "wrap_x": round(wrap_x, 6),
        "wrap_y": round(wrap_y, 6),
        "wrap_max": round(wrap_max, 6),
        "wrap": round(wrap, 6),
        "interior_ref": round(ref, 6),
        "wrap_ratio": round(ratio, 4),
        "wrap_ratio_db": round(20.0 * math.log10(max(ratio, 1e-6)), 2),
        "hard_seam": bool(hard_seam),
        "pass": bool((not hard_seam) and (ratio <= WRAP_RATIO_THRESHOLD or wrap <= WRAP_ABS_FLOOR)),
    }


def color_stats(a: np.ndarray) -> dict:
    """Mean colour, plus the mean of the *colourful* pixels only.

    The colourful average is the useful one for "did the palette follow the
    reference": neutral chips and bare metal drag a plain mean towards grey.
    """
    rgb = np.clip(a[..., :3], 0.0, 1.0).reshape(-1, 3)
    mx = rgb.max(1)
    mn = rgb.min(1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    colourful = rgb[sat > 0.2]
    return {
        "mean_rgb": [round(float(x), 4) for x in rgb.mean(0)],
        "colourful_frac": round(float((sat > 0.2).mean()), 4),
        "colourful_rgb": [round(float(x), 4) for x in (colourful.mean(0) if len(colourful) else rgb.mean(0))],
    }


def normal_metrics(a: np.ndarray) -> dict:
    """`a` is image-encoded tangent space: n = 2*a - 1.

    Decoding the wrong convention gives a self-consistent map with |n| ~ 1.7,
    which is exactly why this has to be measured rather than assumed.
    """
    n = a[..., :3] * 2.0 - 1.0
    length = np.sqrt((n * n).sum(-1))
    unit_frac = float((np.abs(length - 1.0) < 0.02).mean())
    z_positive = bool(float(n[..., 2].min()) > 0.0)
    out = {
        "encoding": "image 0..1 (decoded with n*2-1)",
        "mean_length": round(float(length.mean()), 5),
        "length_p01": round(float(np.quantile(length, 0.01)), 5),
        "unit_frac": unit_frac,
        "range": [round(float(n.min()), 3), round(float(n.max()), 3)],
        "xy_mean": [round(float(n[..., 0].mean()), 4), round(float(n[..., 1].mean()), 4)],
        "min_z": round(float(n[..., 2].min()), 4),
        "z_positive": z_positive,
    }
    out["pass"] = bool(
        abs(out["mean_length"] - 1.0) < 0.02
        and unit_frac > 0.9
        and out["range"][0] >= -1.001
        and out["range"][1] <= 1.001
        and z_positive
    )
    return out


def tiled_preview(path, out_path, times=3):
    img = Image.open(path).convert("RGB")
    w, h = img.size
    sheet = Image.new("RGB", (w * times, h * times))
    for y in range(times):
        for x in range(times):
            sheet.paste(img, (x * w, y * h))
    sheet.save(out_path)
    return out_path


def pick_maps(files):
    """One file per canonical map; previews/comparison sheets are ignored."""
    by_name = {}
    used = set()
    for key in MAP_ORDER:
        candidates = []
        for f in files:
            stem = os.path.splitext(os.path.basename(f))[0].lower()
            if stem.startswith("_") or "preview" in stem or "tiled" in stem:
                continue
            if stem == key or stem.startswith(f"{key}_") or stem.startswith(f"{key}-"):
                candidates.append(f)
        if not candidates:
            continue
        exact = [f for f in candidates if os.path.splitext(os.path.basename(f))[0].lower() == key]
        chosen = exact[0] if exact else max(candidates, key=os.path.getsize)
        by_name[key] = chosen
        used.add(chosen)
    return by_name, [os.path.basename(f) for f in files if f not in used]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", default=None, help="directory holding the map PNGs (auto-discovery)")
    ap.add_argument(
        "--map",
        action="append",
        default=[],
        metavar="KEY=PATH",
        help="explicit map path; use when the files are named by a studio convention "
        "that auto-discovery cannot read. Repeatable.",
    )
    ap.add_argument("--normal", default=None, help="path to the normal map (default: auto)")
    ap.add_argument("--preview", action="store_true", help="write 3x3 tiling previews")
    ap.add_argument("--preview-dir", default=None, help="where previews go (default: beside the map)")
    ap.add_argument("--json-out", default=None)
    a = ap.parse_args(argv)

    explicit = {}
    for spec in a.map:
        key, _, path = spec.partition("=")
        key = key.strip()
        if key not in MAP_ORDER:
            raise SystemExit(f"unknown map key {key!r}; expected one of {', '.join(MAP_ORDER)}")
        if not os.path.exists(path):
            raise SystemExit(f"map {key} not found: {path}")
        explicit[key] = os.path.abspath(path)

    if explicit:
        by_name = explicit
        ignored = []
    else:
        if not a.dir:
            raise SystemExit("either --dir or at least one --map is required")
        files = sorted(glob.glob(os.path.join(a.dir, "*.png")))
        if not files:
            raise SystemExit(f"no PNGs under {a.dir}")
        by_name, ignored = pick_maps(files)

    normal_path = a.normal or by_name.get("normal")
    report = {
        "dir": a.dir or (os.path.dirname(next(iter(by_name.values()))) if by_name else None),
        "maps": [],
        "previews": [],
        "normal": None,
        "ignored": ignored,
        "thresholds": {
            "wrap_ratio": WRAP_RATIO_THRESHOLD,
            "wrap_max_veto": WRAP_MAX_VETO,
            "wrap_abs_floor": WRAP_ABS_FLOOR,
        },
        "comfy_note": None,
    }

    for key in MAP_ORDER:
        if key not in by_name:
            continue
        f = by_name[key]
        arr, meta = load_array(f)
        entry = seam_metrics(arr)
        entry.update(key=key, name=os.path.basename(f), path=f, size=[meta["width"], meta["height"]], **meta)
        entry.update(color_stats(arr))
        entry["is_normal"] = normal_path is not None and os.path.abspath(f) == os.path.abspath(normal_path)
        if entry["is_normal"]:
            entry["normal"] = normal_metrics(arr)
        report["maps"].append(entry)

    if normal_path:
        arr, _ = load_array(normal_path)
        report["normal"] = {"file": os.path.basename(normal_path), **normal_metrics(arr)}

    report["all_tile_pass"] = bool(report["maps"]) and all(m["pass"] for m in report["maps"])
    report["all_normal_pass"] = report["normal"] is None or report["normal"]["pass"]

    if a.preview:
        for key in ("albedo", "normal"):
            if key in by_name:
                stem = os.path.splitext(os.path.basename(by_name[key]))[0]
                out_dir = a.preview_dir or os.path.dirname(by_name[key])
                os.makedirs(out_dir, exist_ok=True)
                report["previews"].append(tiled_preview(by_name[key], os.path.join(out_dir, f"{stem}_tiled3x3.png")))
        # A PASS here is necessary, not sufficient. The metric compresses
        # towards 1 for texel-level content, and MakeSeamless leaves a genuine
        # repeating mirror motif that no edge metric can see.
        report["comfy_note"] = (
            "wrap_ratio passing means the boundary is statistically indistinguishable "
            "from the interior. It does NOT mean the image is free of the repeating mirror "
            "motif that MakeSeamless introduces, and it compresses towards 1 for "
            "texel-level detail - look at the 3x3 preview."
        )

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if a.json_out:
        with open(a.json_out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
