#!/usr/bin/env python3
"""生成 pushover-sender 的 128x128 应用图标：深红渐变圆角底 + 三道弯曲爪痕。"""

import math

from PIL import Image, ImageDraw

S = 128
OUT = str(Path(__file__).parent.parent / "assets" / "icon_128.png")


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
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 背景垂直渐变（深红）
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bot = (176, 40, 40), (88, 14, 14)
    for y in range(S):
        t = y / (S - 1)
        col = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (S, y)], fill=col)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=30, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    bone = (245, 238, 226, 255)
    shadow = (40, 6, 6, 110)

    # 三道爪痕：倾斜收钩，中间一道更深
    claws = [
        ((46, 30), (33, 96), 11.5, 13),
        ((68, 26), (57, 105), 12.5, 15),
        ((90, 30), (83, 96), 11.5, 13),
    ]
    # 投影
    for base, tip, w, bend in claws:
        claw(d, (base[0] + 3, base[1] + 4), (tip[0] + 3, tip[1] + 4), w, bend, shadow)
    # 本体
    for base, tip, w, bend in claws:
        claw(d, base, tip, w, bend, bone)

    img.save(OUT)
    print(f"saved {OUT} ({S}x{S})")


if __name__ == "__main__":
    main()
