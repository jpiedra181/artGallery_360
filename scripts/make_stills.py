"""Render flat "stills" from each panorama: the poster shown before WebGL is
ready, the no-WebGL fallback, and the Open Graph image.

    python scripts/make_stills.py [scene ...]

Reads blender/renders/<scene>/final.png (or beauty.png) and writes
still.png (1920×1200) next to it; the hub also gets og.png (1200×630): the
four paintings on the gallery wall, and under them the exhibition's label
(scripts/og/label.png, made from label.html beside it).
"""

import os
import sys

import cv2
import numpy as np
from math import atan, pi, radians, tan

sys.path.insert(0, os.path.dirname(__file__))
from drawing import hang  # noqa: E402
from pano_views import perspective  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
RENDERS = os.path.join(ROOT, "blender", "renders")
OG_LABEL = os.path.join(ROOT, "scripts", "og", "label.png")
OG_SIZE = (1200, 630)
OG_SPAN = 164  # degrees of the gallery across it

# yaw, pitch, horizontal fov — keep in sync with the initial views in src/data/rooms.ts
VIEWS = {
    "hub": (0, -3, 112),
    "wave": (-18, 14, 92),
    "rain": (-6, -19, 75),
    "stillness": (3, -2, 92),
    "moonlight": (0, 4, 92),
}

# the gallery for tall screens, as a phone opens on it: pitch, zoom (hallZoom in app.ts), and the tallest shape of phone
TALL = {"hub_tall": (5, 1.0)}
TALL_SIZE = (1200, 2600)
TALL_SOFTEN = 0.62


def tall_view(pano, pitch, zoom):
    """The viewer's own projection (engine/math.ts): part straight, part stereographic."""
    w, h = TALL_SIZE
    fov = min(min(2 * atan(tan(radians(38)) * h / w), radians(122)) * zoom, radians(125))
    t = min(max((fov - radians(85)) / radians(40), 0), 1)
    stereo = max(t * t * (3 - 2 * t) * 0.75, TALL_SOFTEN)
    x, y = np.meshgrid(((np.arange(w) + 0.5) / w * 2 - 1) * w / h, 1 - (np.arange(h) + 0.5) / h * 2)
    r = np.hypot(x, y)
    theta = (1 - stereo) * np.arctan(r * tan(fov / 2)) + stereo * 2 * np.arctan(r * tan(fov / 4))
    s = np.sin(theta) / np.maximum(r, 1e-6)
    x, y, z = x * s, y * s, np.cos(theta)
    c, n = np.cos(radians(pitch)), np.sin(radians(pitch))
    y, z = y * c + z * n, z * c - y * n
    ph, pw = pano.shape[:2]
    u = (np.arctan2(x, z) / (2 * pi) + 0.5) * pw - 0.5
    v = (0.5 - np.arcsin(np.clip(y, -1, 1)) / pi) * ph - 0.5
    return cv2.remap(pano, u.astype(np.float32), v.astype(np.float32), cv2.INTER_AREA, borderMode=cv2.BORDER_WRAP)


def load(scene):
    for name in ("final.png", "beauty.png"):
        path = os.path.join(RENDERS, scene, name)
        if os.path.exists(path):
            img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
            if img.dtype == np.uint16:
                img = (img.astype(np.float32) / 257.0).round().astype(np.uint8)
            return img[..., :3]
    return None


def share_card(pano, yaw, pitch):
    """The Open Graph image: a view of the painting with the label of the exhibition under it."""
    w, h = OG_SIZE
    label = cv2.imread(OG_LABEL, cv2.IMREAD_COLOR)
    if label is None or label.shape[1] != w:
        raise SystemExit(f"{OG_LABEL} is missing or not {w} px wide")
    # all four walls unrolled, so that the paintings at the sides are no wider than the others, and a
    # touch lower than the middle of them: some of their reflection, clear of the label
    vh = h - label.shape[0]
    x, y = np.meshgrid((np.arange(w) + 0.5) / w - 0.5, (np.arange(vh) + 0.5) / vh - 0.5)
    lon = np.radians(yaw) + x * np.radians(OG_SPAN)
    lat = np.arctan(np.tan(np.radians(pitch)) - y * np.radians(OG_SPAN) * vh / w)
    ph, pw = pano.shape[:2]
    src = cv2.resize(pano, (pw // 2, ph // 2), interpolation=cv2.INTER_AREA)
    ph, pw = src.shape[:2]
    view = cv2.remap(src, ((lon / (2 * np.pi) + 0.5) * pw - 0.5).astype(np.float32), ((0.5 - lat / np.pi) * ph - 0.5).astype(np.float32), cv2.INTER_CUBIC)
    return np.vstack([view, label])


def main(scenes):
    for scene in scenes:
        pano = load(scene)
        if pano is None:
            print(f"skip {scene}: no render")
            continue
        if scene in ("wave", "rain"):
            pano = hang(pano, os.path.join(RENDERS, scene))  # what moves is drawn, not rendered
        if scene in TALL:
            cv2.imwrite(os.path.join(RENDERS, scene, "still.png"), tall_view(pano, *TALL[scene]))
            print(f"{scene}: tall still written")
            continue
        yaw, pitch, fov = VIEWS[scene]
        still = perspective(pano, yaw, pitch, fov, 1920, 1200)
        cv2.imwrite(os.path.join(RENDERS, scene, "still.png"), still)
        if scene == "hub":
            cv2.imwrite(os.path.join(RENDERS, scene, "og.png"), share_card(pano, yaw, pitch))
        print(f"{scene}: still written")


if __name__ == "__main__":
    main(sys.argv[1:] or [*VIEWS, *TALL])
