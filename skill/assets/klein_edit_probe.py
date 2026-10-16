"""
用 FLUX.2 Klein 4B 做指令式编辑：把一张"物体的照片"变成"平面材质图"。

这是两步式流程的第一步（外部/本地编辑模型产出干净正面材质），
第二步是本地确定性流程（MakeSeamless -> PBRSynth）出 PBR。

图结构照抄用户 ComfyUI 自带的蓝图 `Image Edit (Flux.2 Klein 4B).json`，
节点签名已从 comfy_extras 源码核对：
  Flux2Scheduler(steps,width,height) -> SIGMAS      （无 model 输入）
  ReferenceLatent(conditioning, latent?) -> CONDITIONING   设 reference_latents
  CFGGuider(model,positive,negative,cfg) -> GUIDER
  ImageScaleToTotalPixels(image,upscale_method,megapixels,resolution_steps)
  SamplerCustomAdvanced(noise,guider,sampler,sigmas,latent_image) -> (output, denoised)
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import time
import urllib.request

OUTDIR = r"D:\dsh-workspace\pbr-lab\_e2e\comfy_root\output\pbrlab"
UNET = "flux-2-klein-base-4b-fp8.safetensors"
CLIP = "qwen_3_4b.safetensors"
VAE = "flux2-vae.safetensors"

POSITIVE = (
    "Extract ONLY the surface material from the supplied photo and re-render it as "
    "a flat, front-facing, seamless material texture.\n"
    "ORTHOGRAPHIC flat view: the surface plane parallel to the image plane, camera "
    "exactly perpendicular, no perspective, no foreshortening, no vanishing point.\n"
    "Remove ALL object structure: no ridges, no embossed X, no seams, no rivets, no "
    "edges, no silhouette, no handle, no cap, no background, no ground, no shadow.\n"
    "Keep the material identity exactly: heavily worn pale yellow-cream paint on "
    "metal, large flakes of paint chipped off revealing dark brown and black bare "
    "metal underneath, fine scratches, dust and grime, matte aged finish.\n"
    "Even diffuse lighting across the whole frame, uniform detail density edge to "
    "edge so it can tile. No single dominant feature, no large isolated shape, no "
    "text, no watermark, no border."
)
NEGATIVE = (
    "perspective, foreshortening, oblique angle, object, container, can, handle, "
    "cap, ridge, embossed cross, edges, silhouette, background, ground, shadow, "
    "cast shadow, highlight, vignette, glossy, reflection, text, watermark, border"
)


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


def build(image: str, seed: int, cfg: float, steps: int, size: int,
          prefix: str) -> dict:
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image, "upload": "image"}},
        "2": {"class_type": "ImageScaleToTotalPixels", "inputs": {
            "image": ["1", 0], "upscale_method": "lanczos",
            "megapixels": 1.0, "resolution_steps": 1}},
        "3": {"class_type": "GetImageSize", "inputs": {"image": ["2", 0]}},
        "4": {"class_type": "UNETLoader", "inputs": {
            "unet_name": UNET, "weight_dtype": "default"}},
        "5": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": CLIP, "type": "flux2", "device": "default"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 0], "text": POSITIVE}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["5", 0], "text": NEGATIVE}},
        "9": {"class_type": "VAEEncode", "inputs": {"pixels": ["2", 0], "vae": ["6", 0]}},
        "10": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["7", 0], "latent": ["9", 0]}},
        "11": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["8", 0], "latent": ["9", 0]}},
        "12": {"class_type": "CFGGuider", "inputs": {
            "model": ["4", 0], "positive": ["10", 0], "negative": ["11", 0], "cfg": cfg}},
        "13": {"class_type": "Flux2Scheduler", "inputs": {
            "steps": steps, "width": size, "height": size}},
        "14": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "15": {"class_type": "EmptyFlux2LatentImage", "inputs": {
            "width": size, "height": size, "batch_size": 1}},
        "16": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "17": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["16", 0], "guider": ["12", 0], "sampler": ["14", 0],
            "sigmas": ["13", 0], "latent_image": ["15", 0]}},
        "18": {"class_type": "VAEDecode", "inputs": {"samples": ["17", 0], "vae": ["6", 0]}},
        "19": {"class_type": "SaveImage", "inputs": {"images": ["18", 0], "filename_prefix": prefix}},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8288)
    ap.add_argument("--image", default="jerry.png")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--cfg", type=float, default=5.0)
    ap.add_argument("--steps", type=int, default=20)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--prefix", default="pbrlab/klein_edit")
    ap.add_argument("--material", default=None,
                    help="替换材质描述段（英文）。不传则用罐子那套默认描述。")
    ap.add_argument("--extra", default="",
                    help="追加到提示词末尾的额外要求")
    a = ap.parse_args()

    global POSITIVE
    if a.material:
        # 只替换"Keep the material identity exactly"那一段，几何/去物体要求保持不变
        head = POSITIVE.split("Keep the material identity exactly")[0]
        POSITIVE = head + "Keep the material identity exactly: " + a.material + "\n" \
            "Even diffuse lighting across the whole frame, uniform detail density " \
            "edge to edge so it can tile. Uniform, finely and evenly spread chip " \
            "density, many small chips rather than a few large ones. No single " \
            "dominant feature, no large isolated shape, no text, no watermark, " \
            "no border. " + a.extra

    if not wait(a.port):
        print("server not up")
        return 1
    print(f"model={UNET}\nclip={CLIP} (type=flux2)\nvae={VAE}")
    print(f"size={a.size} steps={a.steps} cfg={a.cfg} seed={a.seed}\n")
    t0 = time.time()
    r = post(f"http://127.0.0.1:{a.port}/prompt",
             {"prompt": build(a.image, a.seed, a.cfg, a.steps, a.size, a.prefix)})
    pid = r.get("prompt_id")
    print("queued", pid)
    if not pid:
        print(json.dumps(r)[:1200])
        return 1
    while time.time() - t0 < 3600:
        with urllib.request.urlopen(f"http://127.0.0.1:{a.port}/history/{pid}", timeout=30) as h:
            hist = json.loads(h.read().decode())
        if pid in hist:
            st = hist[pid]["status"]
            print(f"done in {time.time()-t0:.0f}s: {st.get('status_str')}")
            for m in st.get("messages", []):
                if m[0] in ("execution_error", "execution_interrupted"):
                    print("ERROR:", json.dumps(m, ensure_ascii=False)[:1200])
            break
        time.sleep(4)

    files = sorted(f for f in os.listdir(OUTDIR) if f.startswith(os.path.basename(a.prefix)))
    for f in files[-3:]:
        with open(os.path.join(OUTDIR, f), "rb") as fh:
            head = fh.read(33)
        try:
            w, h = struct.unpack(">II", head[16:24])
            print(f"  {f}  {w}x{h}")
        except Exception:
            print(f"  {f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
