"""
Variants of the Klein material edit, to pick the best one.

Why: step 1 works (object photo -> flat material, verified). Step 2 (pixel-space
MakeSeamless) makes it tile at wrap_ratio 0.00 but leaves the known mirror
symmetry, which is more visible when the material has a few distinctive large
features. Two levers are tested:

  * different seeds -> different chip distributions, some more uniform
  * an explicit "must tile seamlessly, edges match" instruction in the prompt

Also writes each result's 2x2 tiling so the seam cost is judged per variant.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request

UNET = "flux-2-klein-base-4b-fp8.safetensors"
CLIP = "qwen_3_4b.safetensors"
VAE = "flux2-vae.safetensors"

BASE = (
    "Extract ONLY the surface material from the supplied photo and re-render it as "
    "a flat, front-facing material texture.\n"
    "ORTHOGRAPHIC flat view: surface plane parallel to the image plane, camera "
    "exactly perpendicular, no perspective, no foreshortening.\n"
    "Remove ALL object structure: no ridges, no embossed X, no seams, no rivets, "
    "no edges, no silhouette, no handle, no cap, no background, no shadow.\n"
    "Keep the material identity exactly: heavily worn pale yellow-cream paint on "
    "metal, flakes of paint chipped off revealing dark brown and black bare metal, "
    "fine scratches, dust and grime, matte aged finish.\n"
    "Even diffuse lighting. "
)
TILE_CLAUSE = (
    "The image MUST tile seamlessly: the left edge matches the right edge and the "
    "top edge matches the bottom edge exactly. Uniform, evenly spread chip density "
    "across the whole frame so no feature repeats noticeably. No single dominant "
    "feature, no large isolated shape, no text, no watermark, no border."
)
PLAIN_CLAUSE = (
    "Uniform, finely and evenly spread chip density across the whole frame, many "
    "small chips rather than a few large ones. No single dominant feature, no "
    "large isolated shape, no text, no watermark, no border."
)
NEG = ("perspective, foreshortening, oblique angle, object, container, can, handle, "
       "cap, ridge, embossed cross, edges, silhouette, background, ground, shadow, "
       "highlight, vignette, glossy, reflection, text, watermark, border, "
       "few large patches, single dominant feature, gradient")

VARIANTS = [
    ("tile_seed7", 7, BASE + TILE_CLAUSE),
    ("plain_seed21", 21, BASE + PLAIN_CLAUSE),
    ("plain_seed33", 33, BASE + PLAIN_CLAUSE),
]


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def wait(port, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/system_stats", timeout=5)
            return True
        except Exception:
            time.sleep(2)
    return False


def build(image: str, steps: int, size: int) -> dict:
    p = {
        "1": {"class_type": "LoadImage", "inputs": {"image": image, "upload": "image"}},
        "2": {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": ["1", 0], "upscale_method": "lanczos",
            "megapixels": 1.0, "resolution_steps": 1}},
        "4": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "flux2", "device": "default"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 0], "text": NEG}},
        "9": {"class_type": "VAEEncode", "inputs": {"pixels": ["2", 0], "vae": ["6", 0]}},
        "13": {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": size, "height": size}},
        "14": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "15": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": size, "height": size, "batch_size": 1}},
    }
    nid = 100
    for label, seed, prompt in VARIANTS:
        pe, r1, r2, gu, nz, sa, dec, sv = (str(nid + i) for i in range(8))
        nid += 8
        p[pe] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 0], "text": prompt}}
        p[r1] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": [pe, 0], "latent": ["9", 0]}}
        p[r2] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["8", 0], "latent": ["9", 0]}}
        p[gu] = {"class_type": "CFGGuider", "inputs": {
            "model": ["4", 0], "positive": [r1, 0], "negative": [r2, 0], "cfg": 5.0}}
        p[nz] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
        p[sa] = {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": [nz, 0], "guider": [gu, 0], "sampler": ["14", 0],
            "sigmas": ["13", 0], "latent_image": ["15", 0]}}
        p[dec] = {"class_type": "VAEDecode", "inputs": {"samples": [sa, 0], "vae": ["6", 0]}}
        p[sv] = {"class_type": "SaveImage", "inputs": {"images": [dec, 0],
                                                       "filename_prefix": f"pbrlab/kv_{label}"}}
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8288)
    ap.add_argument("--image", default="jerry.png")
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--size", type=int, default=1024)
    a = ap.parse_args()
    if not wait(a.port):
        print("server not up")
        return 1
    t0 = time.time()
    r = post(f"http://127.0.0.1:{a.port}/prompt", {"prompt": build(a.image, a.steps, a.size)})
    pid = r.get("prompt_id")
    print("queued", pid, f"({len(VARIANTS)} variants)")
    if not pid:
        print(json.dumps(r)[:1000])
        return 1
    while time.time() - t0 < 3600:
        with urllib.request.urlopen(f"http://127.0.0.1:{a.port}/history/{pid}", timeout=30) as h:
            hist = json.loads(h.read().decode())
        if pid in hist:
            st = hist[pid]["status"]
            print(f"done in {time.time()-t0:.0f}s: {st.get('status_str')}")
            for m in st.get("messages", []):
                if m[0] in ("execution_error", "execution_interrupted"):
                    print("ERROR:", json.dumps(m, ensure_ascii=False)[:900])
            break
        time.sleep(4)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
