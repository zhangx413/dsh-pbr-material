#!/usr/bin/env python
"""Tests the delivery half: explicit --map measurement and channel packing.

Needs a real map set on disk to measure. Point PBR_TEST_MAPSET at one, or the
test skips with a message instead of failing on a machine that has none:

  PBR_TEST_MAPSET=/path/to/albedo+normal+roughness+... python test/naming_pipeline.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PYDIR = os.path.join(HERE, "..", "python")
PY = sys.executable
# Any directory holding albedo/normal/roughness/metallic/ao/height PNGs will do.
SET = os.environ.get("PBR_TEST_MAPSET", "")

failures = []


def check(label, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + ("" if ok else f"   {detail}"))
    if not ok:
        failures.append(label)


def run(script, args):
    proc = subprocess.run([PY, "-B", os.path.join(PYDIR, script), *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"{script} failed:\n{proc.stderr or proc.stdout}")
    return proc.stdout


def load_rgba(path):
    img = Image.open(path)
    assert img.mode == "RGBA", (path, img.mode)
    return np.asarray(img).astype(np.int32)


albedo = os.path.join(SET, "albedo.png")
normal = os.path.join(SET, "normal.png")
roughness = os.path.join(SET, "roughness.png")
metallic = os.path.join(SET, "metallic.png")
ao = os.path.join(SET, "ao.png")
height = os.path.join(SET, "height.png")
missing = [p for p in (albedo, normal, roughness, metallic, ao, height) if not os.path.exists(p)]
if missing:
    print("SKIP - no map set to measure.")
    print("       Set PBR_TEST_MAPSET to a directory holding albedo.png, normal.png,")
    print("       roughness.png, metallic.png, ao.png and height.png.")
    if SET:
        print(f"       PBR_TEST_MAPSET={SET}")
        for p in missing[:3]:
            print(f"       missing: {p}")
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix="pbr-naming-")
asset = "T_Test_SandBag_01"

print("measure: explicit --map, previews into --preview-dir")
preview_dir = os.path.join(tmp, "preview")
out = run(
    "measure_maps.py",
    [
        "--map", f"albedo={albedo}",
        "--map", f"normal={normal}",
        "--map", f"roughness={roughness}",
        "--preview", "--preview-dir", preview_dir,
    ],
)
report = json.loads(out[out.index("{"):])
keys = sorted(m["key"] for m in report["maps"])
check("only the explicitly named maps are measured", keys == ["albedo", "normal", "roughness"], str(keys))
check("no auto-discovery leftovers", report["ignored"] == [])
check("every entry carries its own path", all(m.get("path") for m in report["maps"]))
check("normal metrics still computed", report["normal"] is not None and "unit_frac" in report["normal"])
names = sorted(os.path.basename(p) for p in report["previews"])
check(
    "previews land in the preview dir, named after the map",
    names == ["albedo_tiled3x3.png", "normal_tiled3x3.png"] and os.path.isdir(preview_dir),
    str(names),
)

print("pack: _CA / _CH / _NRM channel layout")
out = run(
    "pack_maps.py",
    [
        "--asset", asset, "--out-dir", tmp, "--kinds", "CA,CH,NRM",
        "--albedo", albedo, "--normal", normal, "--roughness", roughness,
        "--metallic", metallic, "--ao", ao, "--height", height,
    ],
)
packed = json.loads(out[out.index("{"):])
check("all three packed maps written", sorted(w["kind"] for w in packed["written"]) == ["CA", "CH", "NRM"])
check("packed at 8-bit", packed["bit_depth"] == 8)

a = np.asarray(Image.open(albedo).convert("RGB")).astype(np.int32)
n = np.asarray(Image.open(normal).convert("RGB")).astype(np.int32)
r = np.asarray(Image.open(roughness).convert("L")).astype(np.int32)
m = np.asarray(Image.open(metallic).convert("L")).astype(np.int32)
o = np.asarray(Image.open(ao).convert("L")).astype(np.int32)
h = np.asarray(Image.open(height).convert("L")).astype(np.int32)

ca = load_rgba(os.path.join(tmp, f"{asset}_CA.png"))
check("_CA rgb == albedo rgb", np.array_equal(ca[..., :3], a), f"max diff {np.abs(ca[...,:3]-a).max()}")
check("_CA alpha == AO", np.array_equal(ca[..., 3], o), f"max diff {np.abs(ca[...,3]-o).max()}")

ch = load_rgba(os.path.join(tmp, f"{asset}_CH.png"))
check("_CH rgb == albedo rgb", np.array_equal(ch[..., :3], a))
check("_CH alpha == height", np.array_equal(ch[..., 3], h), f"max diff {np.abs(ch[...,3]-h).max()}")

nrm = load_rgba(os.path.join(tmp, f"{asset}_NRM.png"))
check("_NRM r == normal r", np.array_equal(nrm[..., 0], n[..., 0]))
check("_NRM g == normal g", np.array_equal(nrm[..., 1], n[..., 1]))
check("_NRM b == roughness", np.array_equal(nrm[..., 2], r), f"max diff {np.abs(nrm[...,2]-r).max()}")
check("_NRM a == metallic", np.array_equal(nrm[..., 3], m), f"max diff {np.abs(nrm[...,3]-m).max()}")

print("pack: a missing source is skipped with a reason, not a crash")
out = run("pack_maps.py", ["--asset", "T_X_Y_01", "--out-dir", tmp, "--kinds", "NRM", "--normal", normal])
report = json.loads(out[out.index("{"):])
check("NRM skipped when roughness/metallic are absent", report["written"] == [] and len(report["skipped"]) == 1,
      json.dumps(report, ensure_ascii=False))

print()
if failures:
    print(f"FAIL ({len(failures)}): " + ", ".join(failures))
    sys.exit(1)
print("PASS - explicit measurement and channel packing behave")
