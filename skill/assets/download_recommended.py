"""
⚠️ 历史脚本 —— 不要用它来装这个插件。

这是当初研究阶段「pbr-lab 推荐模型包」的下载器，里面混着 Z-Image / BiRefNet 等
**当前管线完全不用**的权重。现在这条管线的模型由插件自己下：

    pbr_setup_status     看缺什么、多大、磁盘够不够、实测速度
    pbr_setup_install    下载（可续传、带镜像回退）

保留它是因为它记录了当时实测出来的下载经验（代理必须显式传、要续传、要 .part），
  这些经验已经移植进 lib/fetch-util.js 与 lib/models.js。
真要跑它，必须显式给出目标模型库，避免写错机器：

    python download_recommended.py --models-root <path>      （或用 PBR_MATERIAL_MODELS_DIR）

用法:
  python download_recommended.py --models-root <path> --dry-run
  python download_recommended.py --models-root <path> --only klein
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request

# 以前这里是写死的作者机器路径。现在必须显式给：一个写死的路径在别人机器上
# 只会把 17 GB 下到不存在的地方，或者更糟——下到错误的盘上。
MODELS_ROOT = os.environ.get("PBR_MATERIAL_MODELS_DIR", "")

# 小文件优先：最快拿到能用的东西
FILES = [
    dict(tag="flux2-vae", name="flux2-vae.safetensors", sub="vae", gb=0.34,
         url="https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b"
             "/resolve/main/split_files/vae/flux2-vae.safetensors"),
    dict(tag="birefnet", name="birefnet.safetensors", sub="background_removal", gb=0.44,
         url="https://huggingface.co/Comfy-Org/BiRefNet"
             "/resolve/main/background_removal/birefnet.safetensors"),
    dict(tag="klein", name="flux-2-klein-base-4b-fp8.safetensors", sub="diffusion_models", gb=4.09,
         url="https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4b-fp8"
             "/resolve/main/flux-2-klein-base-4b-fp8.safetensors"),
    dict(tag="zimage", name="z_image_turbo_nvfp4.safetensors", sub="diffusion_models", gb=4.51,
         url="https://huggingface.co/Comfy-Org/z_image_turbo"
             "/resolve/main/split_files/diffusion_models/z_image_turbo_nvfp4.safetensors"),
    dict(tag="qwen3-4b", name="qwen_3_4b.safetensors", sub="text_encoders", gb=8.04,
         url="https://huggingface.co/Comfy-Org/z_image_turbo"
             "/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors"),
]


def read_proxy(explicit: str | None) -> str:
    if explicit:
        return explicit
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                           r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        enabled, _ = winreg.QueryValueEx(k, "ProxyEnable")
        server, _ = winreg.QueryValueEx(k, "ProxyServer")
        if enabled and server:
            return server if server.startswith("http") else f"http://{server}"
    except Exception:
        pass
    raise SystemExit("没有代理，且 --proxy 未指定。本机直连 HF 不通。")


def opener_for(proxy: str) -> urllib.request.OpenerDirector:
    h = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    return urllib.request.build_opener(h)


def verify_safetensors(path: str) -> str | None:
    """返回 None 表示 OK，否则返回错误原因。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(8)
            if len(head) < 8:
                return "文件太短"
            (hlen,) = struct.unpack("<Q", head)
            if hlen <= 0 or hlen > 200_000_000:
                return f"头长度异常 {hlen}"
            if size < 8 + hlen:
                return f"文件被截断（头声明 {hlen}，实际 {size}）"
            js = f.read(hlen).decode("utf-8", errors="replace")
        if not any(k in js for k in ("__metadata__", "weight", "model", "embed")):
            return "头部 JSON 不像 safetensors"
        return None
    except Exception as e:  # noqa: BLE001
        return f"读取失败 {e}"


def head_size(op, url: str) -> int:
    """取文件的精确字节数（Content-Length）。

    为什么必须这样做：我一开始把 HF API 返回的 GB 数四舍五入后写死当预期值，
    结果 flux2-vae 的 336211292 字节被当成"0.34GB 里的 0.336GB"，
    0.336 < 0.34*0.995 → 误判为下载不全。更糟的是文件其实已完整，重试时发
    Range 会拿到 HTTP 416，于是 5 次重试全废。精确值只能从 Content-Length 拿。
    """
    req = urllib.request.Request(url, method="HEAD", headers={
        "User-Agent": "pbr-lab-downloader/1.0",
        "Accept-Encoding": "identity",
    })
    with op.open(req, timeout=60) as r:
        n = r.headers.get("Content-Length")
        return int(n) if n else 0


def download(op, url: str, dst: str, expect_gb: float) -> bool:
    """.part + Range 续传，多次重试。成功返回 True。"""
    part = dst + ".part"

    # 精确大小；拿不到就退回估算值（并放宽判据）
    exact = 0
    try:
        exact = head_size(op, url)
        print(f"        精确大小 {exact/1e9:.4f} GB")
    except Exception as e:  # noqa: BLE001
        print(f"        取 Content-Length 失败（{e}），用估算值 {expect_gb} GB")
    total = exact or (expect_gb * 1e9)

    have = os.path.getsize(part) if os.path.exists(part) else 0

    # 【关键】已经下完的情况：不要再发 Range（会 416），直接收尾
    if exact and have == exact:
        print("        已下满（.part 与 Content-Length 一致），直接收尾")
        os.replace(part, dst)
        return True
    if exact and have > exact:
        print(f"        .part 比目标大（{have} > {exact}），丢弃重下")
        os.remove(part)
        have = 0

    for attempt in range(1, 6):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "pbr-lab-downloader/1.0",
                "Accept-Encoding": "identity",
            })
            if have:
                req.add_header("Range", f"bytes={have}-")
            t0 = time.time()
            last_report = 0.0
            with op.open(req, timeout=120) as r:
                code = r.getcode()
                if have and code == 206:
                    mode = "ab"
                elif code == 200:
                    mode = "wb"
                    have = 0
                else:
                    raise urllib.error.HTTPError(url, code, "unexpected", r.headers, None)

                with open(part, mode) as f:
                    while True:
                        chunk = r.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                        now = time.time()
                        if now - last_report >= 5:
                            last_report = now
                            pct = (have / total * 100) if total else 0
                            spd = have / max(now - t0, 1e-6) / 1e6
                            sys.stdout.write(
                                f"\r        {have/1e9:6.2f}/{total/1e9:.2f} GB  "
                                f"{pct:5.1f}%  {spd:5.2f} MB/s   ")
                            sys.stdout.flush()
            print()
            got = os.path.getsize(part)
            if exact and got != exact:
                raise IOError(f"大小不符：{got} != {exact}（差 {exact-got} 字节）")
            os.replace(part, dst)
            return True
        except Exception as e:  # noqa: BLE001
            print(f"\n        尝试 {attempt} 失败：{type(e).__name__}: {e}")
            have = os.path.getsize(part) if os.path.exists(part) else 0
            if exact and have == exact:      # 差最后一步时容错
                os.replace(part, dst)
                return True
            if attempt < 5:
                time.sleep(5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="历史下载脚本；当前管线请用插件的 pbr_setup_install。")
    ap.add_argument("--models-root", default=None,
                    help="目标模型库根目录（也可用环境变量 PBR_MATERIAL_MODELS_DIR）。必填。")
    ap.add_argument("--proxy", default=None)
    ap.add_argument("--only", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    global MODELS_ROOT
    root = a.models_root or MODELS_ROOT
    if not root:
        print("拒绝运行：没有给出目标模型库。")
        print("  这个脚本下的是历史模型组合，不是当前管线要的东西。")
        print("  要装这个插件请用 pbr_setup_status / pbr_setup_install。")
        print("  真要跑它：--models-root <path> 或环境变量 PBR_MATERIAL_MODELS_DIR。")
        return 2
    MODELS_ROOT = root
    if not os.path.isdir(MODELS_ROOT):
        print(f"拒绝运行：模型库目录不存在：{MODELS_ROOT}")
        return 2

    files = [f for f in FILES if not a.only or f["tag"] == a.only]
    if not files:
        print(f"没有匹配 --only {a.only} 的条目：{[f['tag'] for f in FILES]}")
        return 1

    proxy = read_proxy(a.proxy)
    op = opener_for(proxy)
    total = sum(f["gb"] for f in files)

    print("=== pbr-lab 推荐模型下载 ===")
    print(f"  代理     : {proxy}")
    print(f"  目标     : {MODELS_ROOT}")
    print(f"  计划     : {len(files)} 个文件 / {total:.2f} GB")
    print()

    t_start = time.time()
    done, failed = 0, []
    for i, f in enumerate(files, 1):
        d = os.path.join(MODELS_ROOT, f["sub"])
        os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, f["name"])
        print(f"[{i}/{len(files)}] {f['name']}  ({f['gb']} GB)")

        if os.path.exists(dst):
            err = verify_safetensors(dst)
            if err is None:
                print("       已存在且校验通过，跳过")
                done += 1
                continue
            print(f"       已存在但校验失败（{err}），重新下载")
            os.remove(dst)

        if a.dry_run:
            print(f"       [dry-run] {f['url']}")
            done += 1
            continue

        if download(op, f["url"], dst, f["gb"]):
            err = verify_safetensors(dst)
            if err is None:
                print(f"       OK  {os.path.getsize(dst)/1e9:.2f} GB  校验通过")
                done += 1
            else:
                print(f"       下载完成但校验失败：{err}")
                print(f"       .part 已改名，文件在 {dst}")
                failed.append(f["name"])
        else:
            print(f"       失败：{f['name']}")
            failed.append(f["name"])

    mins = (time.time() - t_start) / 60
    print()
    print(f"=== 完成  成功 {done}/{len(files)}  用时 {mins:.1f} 分钟 ===")
    if failed:
        print(f"  失败: {', '.join(failed)}")
        return 1
    print()
    print("接下来：重启 ComfyUI，然后打开模板")
    print("   文生图 -> Text to Image (Z-Image-Turbo)  [下拉选 z_image_turbo_nvfp4.safetensors]")
    print("   编辑   -> Image Edit (Flux.2 Klein 4B)   [下拉选 flux-2-klein-base-4b-fp8.safetensors]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
