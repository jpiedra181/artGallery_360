"""Render flat "stills" from each panorama: the poster shown before WebGL is
ready, the no-WebGL fallback, and the Open Graph image.

    python scripts/make_stills.py [scene ...]

Reads blender/renders/<scene>/final.png (or beauty.png) and writes
still.png (1920×1200) next to it; the hub also gets og.png (1200×630).
"""

import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from pano_views import perspective  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
RENDERS = os.path.join(ROOT, "blender", "renders")

# yaw, pitch, horizontal fov — keep in sync with the initial views in src/data/rooms.ts
VIEWS = {
    "hub": (0, 0, 92),
    "wave": (-18, 14, 92),
    "rain": (0, -8, 92),
    "stillness": (0, -6, 92),
    "moonlight": (-4, 5, 92),
}


def load(scene):
    for name in ("final.png", "beauty.png"):
        path = os.path.join(RENDERS, scene, name)
        if os.path.exists(path):
            img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
            if img.dtype == np.uint16:
                img = (img.astype(np.float32) / 257.0).round().astype(np.uint8)
            return img[..., :3]
    return None


def main(scenes):
    for scene in scenes:
        pano = load(scene)
        if pano is None:
            print(f"skip {scene}: no render")
            continue
        yaw, pitch, fov = VIEWS[scene]
        still = perspective(pano, yaw, pitch, fov, 1920, 1200)
        cv2.imwrite(os.path.join(RENDERS, scene, "still.png"), still)
        if scene == "hub":
            og = perspective(pano, yaw, pitch, 78, 1200, 630)
            cv2.imwrite(os.path.join(RENDERS, scene, "og.png"), og)
        print(f"{scene}: still written")


if __name__ == "__main__":
    main(sys.argv[1:] or list(VIEWS))
