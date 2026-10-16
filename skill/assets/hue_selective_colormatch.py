"""
色相选择性的颜色匹配 —— 修掉"灰白剥落被染成青色"的问题。

问题：PBRLabColorMatch 用的是 Reinhard 逐通道均值/标准差迁移，它对**每个像素**
都做通道缩放。于是当参考图的漆色偏暖时，生成图里的中性灰白剥落处也被缩放，
结果蓝通道相对抬高 → 原本的白斑变成青色。而剥落露出的裸金属本来就该是中性灰白。

正确做法：只调整**彩色**像素（饱和度高于阈值），**中性**像素（裸金属、白斑、灰尘）
原样保留。同时用色相掩码从参考图里稳健地估计真实漆色，而不是靠手挑一块干净的
裁块（手挑很容易把框架/背景/阴影一起框进去，我这轮就框错了）。

输出：与输入同分辨率的调色结果。
"""

from __future__ import annotations

import numpy as np
import torch

# 目标漆色的色相范围（度）：橙红
HUE_LO, HUE_HI = 5.0, 35.0


def rgb_to_hsv_np(rgb: np.ndarray) -> np.ndarray:
    """rgb float [0,1] HxWx3 -> hsv（h 单位度 0-360, s/v 0-1）"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); mn = rgb.min(-1); d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-8
    idx = nz & (mx == r); h[idx] = (60 * ((g - b) / np.where(d == 0, 1, d)))[idx] % 360
    idx = nz & (mx == g); h[idx] = (60 * ((b - r) / np.where(d == 0, 1, d)) + 120)[idx]
    idx = nz & (mx == b); h[idx] = (60 * ((r - g) / np.where(d == 0, 1, d)) + 240)[idx]
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


def paint_stats(rgb: np.ndarray, hue_lo=HUE_LO, hue_hi=HUE_HI,
                min_sat=0.25, min_val=0.10):
    """从参考图里稳健估计漆色：只取色相落在橙红区间、且有足够饱和度的像素。"""
    hsv = rgb_to_hsv_np(rgb)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = (h >= hue_lo) & (h <= hue_hi) & (s >= min_sat) & (v >= min_val)
    n = int(m.sum())
    if n < 50:
        return None, n
    px = rgb[m]
    return dict(mean=px.mean(0), std=px.std(0), n=n), n


def apply_selective(src: np.ndarray, tgt: dict, strength=1.0,
                    sat_gate=0.18) -> np.ndarray:
    """
    src: 生成图 float HxWx3
    tgt: paint_stats 的结果（目标漆色）
    只对饱和度 > sat_gate 的像素做色相/饱和度/明度迁移；中性像素原样保留。
    """
    hsv = rgb_to_hsv_np(src)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]

    # 生成图里漆色像素的统计
    st, n = paint_stats(src)
    if st is None or tgt is None:
        return src

    # 色相：向目标色相旋转（环形最短路径）
    th, ts, tv = rgb_to_hsv_np(tgt["mean"][None, None, :])[0, 0]
    sh, ss, sv = rgb_to_hsv_np(st["mean"][None, None, :])[0, 0]
    dh = ((th - sh + 180) % 360) - 180
    h2 = (h + dh * strength) % 360
    # 饱和度 / 明度：按目标均值比例缩放，并夹在合理范围
    s2 = np.clip(s * (ts / max(ss, 1e-3)) ** strength, 0, 1)
    v2 = np.clip(v * (tv / max(sv, 1e-3)) ** strength, 0, 1)

    out_hsv = np.stack([h2, s2, v2], -1)
    out = hsv_to_rgb_np(out_hsv)

    # 软掩码：彩色像素用调色结果，中性像素保留原样
    w = np.clip((s - sat_gate) / 0.12, 0, 1)[..., None] * strength
    return np.clip(src * (1 - w) + out * w, 0, 1)


def run_torch(src_bhwc: torch.Tensor, ref_bhwc: torch.Tensor, strength=1.0) -> torch.Tensor:
    s = src_bhwc[0].detach().cpu().numpy().astype(np.float64)
    r = ref_bhwc[0].detach().cpu().numpy().astype(np.float64)
    tgt, n = paint_stats(r)
    print(f"  参考图里识别到漆色像素 {n} 个"
          + (f"，漆色均值 [{tgt['mean'][0]:.3f} {tgt['mean'][1]:.3f} {tgt['mean'][2]:.3f}]" if tgt else "（太少，放弃调色）"))
    if tgt is None:
        return src_bhwc
    out = apply_selective(s, tgt, strength)
    return torch.from_numpy(out).to(src_bhwc.dtype).unsqueeze(0)
