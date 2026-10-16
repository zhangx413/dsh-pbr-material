#!/usr/bin/env python
"""Parity test: this plugin's seam_metrics must agree with PBRLabTileValidator's.

Both are supposed to answer the same question, so a number reported by
`pbr_check_maps` must be the same number the ComfyUI GUI shows. This runs the
pbrlab pack's own function and mine over the same arrays and compares.

  python test/metric_parity.py
"""
from __future__ import annotations

import os
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))
# The pack the plugin actually ships and links into its run root — not some
# checkout on the author's machine. If these two ever diverge, the metric a user
# sees would stop matching the GUI's, which is the whole point of this test.
sys.path.insert(0, os.path.join(HERE, "..", "assets", "pbrlab"))

import nodes as pbrlab  # noqa: E402
from measure_maps import seam_metrics  # noqa: E402


def bhwc(arr):
    return torch.from_numpy(arr.astype(np.float32))[None, ...]


def periodic_field(n=256):
    """Discretely periodic: f[n-1] must equal f[0], so the parameter runs one
    full turn over n-1 samples (a period of n would leave a half-step at the
    boundary and is NOT the same thing)."""
    t = np.arange(n) / (n - 1) * 2 * np.pi
    X, Y = np.meshgrid(t, t)
    fig = np.sin(3 * X) * np.cos(2 * Y) + 0.4 * np.sin(5 * (X + Y))
    img = (fig - fig.min()) / (fig.max() - fig.min())
    return np.stack([img, img * 0.7 + 0.15, 1.0 - img * 0.5], -1)


def white_noise(n=256, seed=0):
    rng = np.random.default_rng(seed)
    return rng.random((n, n, 3))


def hard_seam(n=256):
    """Periodic content whose right-hand band is replaced: the wrap breaks."""
    img = periodic_field(n).copy()
    img[:, -32:, :] = 1.0 - img[:, -32:, :]
    return img


def flat(n=64):
    return np.full((n, n, 3), 0.5)


def blurred_periodic(n=256):
    base = bhwc(periodic_field(n))
    lum = base.mean(-1, keepdim=True)
    blurred = pbrlab._circular_blur(lum, 8)
    return blurred.repeat(1, 1, 1, 3)[0].numpy()


CASES = {
    "exactly periodic field": periodic_field(),
    "circular-blurred periodic": blurred_periodic(),
    "white noise": white_noise(),
    "periodic content + hard seam": hard_seam(),
    "flat constant": flat(),
}

KEYS = ["wrap", "wrap_max", "interior_ref", "wrap_ratio", "hard_seam"]

failures = []
print(f"{'case':32} {'wrap':>10} {'wrap_max':>10} {'interior':>10} {'ratio':>9}  pass")
for label, arr in CASES.items():
    mine = seam_metrics(arr)
    theirs = pbrlab.seam_metrics(bhwc(arr))
    theirs_named = {
        "wrap": theirs["wrap"],
        "wrap_max": theirs["wrap_max"],
        "interior_ref": theirs["interior_ref"],
        "wrap_ratio": theirs["wrap_ratio"],
        "hard_seam": theirs["hard_seam"],
        "seam_pass": theirs["seam_pass"],
    }
    for key in KEYS:
        a = mine[key]
        b = theirs_named[key]
        if isinstance(a, bool):
            same = a is b
        else:
            same = abs(float(a) - float(b)) <= 1e-6
        if not same:
            failures.append(f"{label}: {key} mine={a} pbrlab={b}")
    if mine["pass"] is not theirs_named["seam_pass"]:
        failures.append(f"{label}: seam_pass mine={mine['pass']} pbrlab={theirs_named['seam_pass']}")
    print(
        f"{label:32} {theirs['wrap']:>10.6f} {theirs['wrap_max']:>10.6f} "
        f"{theirs['interior_ref']:>10.6f} {theirs['wrap_ratio']:>9.4f}  {theirs['seam_pass']}"
    )

# The calibration the pack documents, re-derived here on this host.
expect = {
    "exactly periodic field": lambda m: m["wrap"] <= 0.02 and m["pass"],
    "circular-blurred periodic": lambda m: m["pass"],
    "white noise": lambda m: not m["pass"] and m["hard_seam"],
    "periodic content + hard seam": lambda m: m["hard_seam"] and not m["pass"],
    "flat constant": lambda m: m["pass"],
}
for label, predicate in expect.items():
    got = seam_metrics(CASES[label])
    if not predicate(got):
        failures.append(f"{label}: calibration predicate failed -> {got}")

if failures:
    print("\nFAIL")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("\nPASS — metric parity with PBRLabTileValidator, and the documented calibration holds")
