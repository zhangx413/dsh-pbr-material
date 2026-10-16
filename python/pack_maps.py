#!/usr/bin/env python
"""Channel-packed companion textures, per the project's naming sheet.

   _CA   固有色 RGB + AO Alpha
   _CH   固有色 RGB + Height Alpha
   _NRM  法线 RG  + 粗糙度 B + 金属度 A

Why 8-bit: the individual maps stay 16-bit (that is where the precision is
wanted for height and normal), but a packed channel texture is an engine-side
asset, and 16-bit RGBA PNGs are both poorly supported and pointless for AO /
roughness / metallic, which are perceptually 8-bit quantities. The sheet does
not state a depth, so this is the conventional choice and it is recorded in the
output JSON.

For _NRM the normal's X and Y are copied **as stored** (already (n+1)/2), which
is exactly what an engine expects to reconstruct Z from.

CLI:
  python pack_maps.py --asset T_Military_SandBag_01 --out-dir <dir> \
      --albedo ... --normal ... --roughness ... --metallic ... --ao ... --height ...
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from measure_maps import load_array  # noqa: E402


def write_rgba(path, channels):
    arr = np.stack([np.clip(c, 0.0, 1.0) for c in channels], -1)
    Image.fromarray(np.rint(arr * 255.0).astype(np.uint8), "RGBA").save(path)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--asset", required=True, help="asset base name, e.g. T_Military_SandBag_01")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--kinds", default="CA,CH,NRM")
    ap.add_argument("--albedo")
    ap.add_argument("--normal")
    ap.add_argument("--roughness")
    ap.add_argument("--metallic")
    ap.add_argument("--ao")
    ap.add_argument("--height")
    # Accepted and ignored: the pipeline forwards every map it has, and a map
    # the packing rules do not consume (curvature) must not become a hard error.
    ap.add_argument("--curvature")
    a = ap.parse_args(argv)

    wanted = [k.strip().upper() for k in a.kinds.split(",") if k.strip()]
    sources = {
        "albedo": a.albedo,
        "normal": a.normal,
        "roughness": a.roughness,
        "metallic": a.metallic,
        "ao": a.ao,
        "height": a.height,
    }
    loaded = {}
    report = {"asset": a.asset, "bit_depth": 8, "written": [], "skipped": []}

    def need(*keys):
        for key in keys:
            path = sources.get(key)
            if not path or not os.path.exists(path):
                return f"缺少 {key}（{path or '未提供'}）"
            if key not in loaded:
                loaded[key] = load_array(path)[0]
        return None

    def channel(key):
        """Single channel value 0..1 from a (possibly replicated) colour array."""
        return loaded[key][..., 0]

    os.makedirs(a.out_dir, exist_ok=True)

    if "CA" in wanted:
        missing = need("albedo", "ao")
        if missing:
            report["skipped"].append({"kind": "CA", "reason": missing})
        else:
            base = loaded["albedo"]
            out = os.path.join(a.out_dir, f"{a.asset}_CA.png")
            report["written"].append(
                {"kind": "CA", "path": write_rgba(out, [base[..., 0], base[..., 1], base[..., 2], channel("ao")])}
            )

    if "CH" in wanted:
        missing = need("albedo", "height")
        if missing:
            report["skipped"].append({"kind": "CH", "reason": missing})
        else:
            base = loaded["albedo"]
            out = os.path.join(a.out_dir, f"{a.asset}_CH.png")
            report["written"].append(
                {"kind": "CH", "path": write_rgba(out, [base[..., 0], base[..., 1], base[..., 2], channel("height")])}
            )

    if "NRM" in wanted:
        missing = need("normal", "roughness", "metallic")
        if missing:
            report["skipped"].append({"kind": "NRM", "reason": missing})
        else:
            nrm = loaded["normal"]  # stored (n+1)/2, so RG are copied verbatim
            out = os.path.join(a.out_dir, f"{a.asset}_NRM.png")
            report["written"].append(
                {
                    "kind": "NRM",
                    "path": write_rgba(
                        out, [nrm[..., 0], nrm[..., 1], channel("roughness"), channel("metallic")]
                    ),
                }
            )

    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
