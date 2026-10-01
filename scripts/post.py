"""Finish a raw Blender render: per-scene look, then a dithered 16 → 8-bit
conversion (dark gradients band badly without it).

    python scripts/post.py <scene> [--preview]

Reads blender/renders/<scene>/beauty.png, writes final.png. Scene-specific
stylisation lives in scripts/looks.py.
"""

import argparse
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
RENDERS = os.path.join(ROOT, "blender", "renders")


def to_float(img):
    if img.dtype == np.uint16:
        return img.astype(np.float32) / 65535.0
    return img.astype(np.float32) / 255.0


def dither_to_8bit(img, seed=7):
    """Triangular-PDF dither (±1 LSB) before quantising."""
    rng = np.random.default_rng(seed)
    noise = (rng.random(img.shape, dtype=np.float32) - rng.random(img.shape, dtype=np.float32))
    return np.clip(img * 255.0 + noise + 0.5, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scene")
    a = ap.parse_args()
    src = os.path.join(RENDERS, a.scene, "beauty.png")
    img = to_float(cv2.imread(src, cv2.IMREAD_UNCHANGED)[..., :3])[..., ::-1]  # BGR -> RGB
    try:
        import looks
        fn = getattr(looks, a.scene.replace("-", "_"), None)
    except ImportError:
        fn = None
    if fn:
        img = fn(img, os.path.join(RENDERS, a.scene))
    cv2.imwrite(os.path.join(RENDERS, a.scene, "final.png"), dither_to_8bit(np.ascontiguousarray(img[..., ::-1])))
    print(f"{a.scene}: final.png written ({img.shape[1]}x{img.shape[0]})")


if __name__ == "__main__":
    main()
