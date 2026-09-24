#!/usr/bin/env python3
"""生成 pushover-toolkit 的应用图标：深红渐变圆角底 + 三道弯曲爪痕。

用法：python3 make_icon.py [尺寸] [输出路径]
默认 128px 输出到 assets/icon_128.png。所有几何参数按 128px 设计稿等比缩放。
"""

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BASE = 128  # 设计稿基准尺寸


def qbez(p0, p1, p2, n=28):
    """二次贝塞尔采样点。"""
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return pts


def claw(draw, base, tip, w, bend, color):
    """一道爪痕：底部圆钝、向 bend 方向弯钩、尖端收拢的多边形。"""
    bx, by = base
    tx, ty = tip
    dx, dy = tx - bx, ty - by
    L = math.hypot(dx, dy)
    px, py = -dy / L, dx / L          # 垂直于爪痕方向的单位向量
    mx, my = (bx + tx) / 2, (by + ty) / 2

    # 两条边：外侧弯得少、内侧弯得多 -> 形成钩状；宽度向尖端收窄
    c_out = (mx + px * bend + px * w * 0.18, my + py * bend + py * w * 0.18)
    c_in = (mx - px * bend * 0.55 - px * w * 0.18, my - py * bend * 0.55 - py * w * 0.18)
    edge_out = qbez((bx + px * w / 2, by + py * w / 2), c_out, (tx, ty))
    edge_in = qbez((bx - px * w / 2, by - py * w / 2), c_in, (tx, ty))

    draw.polygon(edge_out + edge_in[::-1], fill=color)
    r = w / 2 + 1
    draw.ellipse([bx - r, by - r, bx + r, by + r], fill=color)  # 圆钝的爪根


def main():
    size = int(sys.argv[1]) if len(sys.argv) > 1 else 128
    out = (sys.argv[2] if len(sys.argv) > 2
           else str(Path(__file__).parent.parent / "assets" / "icon_128.png"))
    k = size / BASE  # 等比缩放系数

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 背景垂直渐变（深红）
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    top, bot = (176, 40, 40), (88, 14, 14)
    for y in range(size):
        t = y / (size - 1)
        col = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (size, y)], fill=col)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(30 * k), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    bone = (245, 238, 226, 255)
    shadow = (40, 6, 6, 110)

    # 三道爪痕（128px 设计稿坐标）：倾斜收钩，中间一道更深
    claws_128 = [
        ((46, 30), (33, 96), 11.5, 13),
        ((68, 26), (57, 105), 12.5, 15),
        ((90, 30), (83, 96), 11.5, 13),
    ]
    claws = [(tuple(v * k for v in base), tuple(v * k for v in tip),
              w * k, bend * k) for base, tip, w, bend in claws_128]

    # 投影（偏移量同样按比例）
    ox, oy = 3 * k, 4 * k
    for base, tip, w, bend in claws:
        claw(d, (base[0] + ox, base[1] + oy), (tip[0] + ox, tip[1] + oy),
             w, bend, shadow)
    for base, tip, w, bend in claws:
        claw(d, base, tip, w, bend, bone)

    img.save(out)
    print(f"saved {out} ({size}x{size})")


if __name__ == "__main__":
    main()
