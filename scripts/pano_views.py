"""Preview an equirectangular panorama as rectilinear views (what the web
viewer shows), laid out in a contact sheet.

    python scripts/pano_views.py <pano.png> <out.jpg> [--fov 75] [--size 640x400]
        [--views "0,0 90,0 180,0 270,0 0,-60 0,70"]

Also importable: `perspective(img, yaw, pitch, fov, w, h)` returns a view.
Conventions match the viewer: yaw 0 = image centre, positive yaw turns right,
positive pitch looks up.
"""

import argparse
import math

import cv2
import numpy as np


def perspective(pano, yaw, pitch, fov, w, h):
    H, W = pano.shape[:2]
    f = 0.5 * w / math.tan(math.radians(fov) / 2)
    xs = (np.arange(w) - w / 2 + 0.5) / f
    ys = (h / 2 - np.arange(h) - 0.5) / f
    x, y = np.meshgrid(xs, ys)
    # camera space: x right, y up, z forward
    d = np.stack([x, y, np.ones_like(x)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    # pitch around x, then yaw around y
    dy = d[..., 1] * cp + d[..., 2] * sp
    dz = -d[..., 1] * sp + d[..., 2] * cp
    dx = d[..., 0]
    wx = dx * cy + dz * sy
    wz = -dx * sy + dz * cy
    lon = np.arctan2(wx, wz)              # 0 = forward, + = right
    lat = np.arcsin(np.clip(dy, -1, 1))
    u = (lon / (2 * math.pi) + 0.5) * W - 0.5
    v = (0.5 - lat / math.pi) * H - 0.5
    return cv2.remap(pano, u.astype(np.float32), v.astype(np.float32), cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pano")
    ap.add_argument("out")
    ap.add_argument("--fov", type=float, default=75)
    ap.add_argument("--size", default="640x400")
    ap.add_argument("--views", default="0,0 90,0 180,0 270,0 0,-65 0,70")
    ap.add_argument("--cols", type=int, default=3)
    a = ap.parse_args()
    pano = cv2.imread(a.pano, cv2.IMREAD_UNCHANGED)
    if pano.dtype == np.uint16:
        pano = (pano / 257).astype(np.uint8)
    if pano.ndim == 3 and pano.shape[2] == 4:
        pano = pano[..., :3]
    w, h = map(int, a.size.split("x"))
    views = [tuple(map(float, v.split(","))) for v in a.views.split()]
    tiles = []
    for yaw, pitch in views:
        t = perspective(pano, yaw, pitch, a.fov, w, h)
        cv2.putText(t, f"yaw {yaw:.0f} pitch {pitch:.0f}", (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(t)
    while len(tiles) % a.cols:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i:i + a.cols]) for i in range(0, len(tiles), a.cols)]
    cv2.imwrite(a.out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])


if __name__ == "__main__":
    main()
