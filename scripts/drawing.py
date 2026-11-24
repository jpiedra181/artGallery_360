"""Hang a drawn sheet (scripts/draw-sheet.mjs) in a panorama, as the viewer does."""

import json
import math
import os

import cv2
import numpy as np


def hang(pano, folder, t="0"):
    """The panorama (BGR, 8-bit) with the drawing of moment `t` laid over it,
    behind whatever the mask's blue channel holds in front."""
    src = os.path.join(folder, f"drawing-{t}.png")
    if not os.path.exists(src):
        raise SystemExit(f"{src} is missing: run node scripts/draw-sheet.mjs")
    sheet = cv2.imread(src, cv2.IMREAD_UNCHANGED).astype(np.float32) / 255.0
    sheet[..., :3] *= sheet[..., 3:]
    with open(os.path.join(folder, "drawing.json")) as f:
        place = json.load(f)
    H, W = pano.shape[:2]
    k = sheet.shape[1] / (place["right"] - place["left"])
    yaw = ((np.arange(W, dtype=np.float32) + 0.5) / W - 0.5) * 360
    lat = (0.5 - (np.arange(H, dtype=np.float32) + 0.5) / H) * math.pi
    merc = np.degrees(np.arcsinh(np.tan(np.clip(lat, -1.5, 1.5))))
    x = (place["x0"] + yaw * place["scale"] - place["left"]) * k - 0.5
    y = (place["horizon"] - merc * place["scale"] - place["top"]) * k - 0.5
    mx, my = np.meshgrid(x.astype(np.float32), y.astype(np.float32))
    ink = cv2.remap(sheet, mx, my, cv2.INTER_AREA if k > W / 360 / place["scale"] else cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT)
    mask = cv2.imread(os.path.join(folder, "mask.png"), cv2.IMREAD_UNCHANGED)[..., 0].astype(np.float32) / 255.0
    front = cv2.resize(mask, (W, H), interpolation=cv2.INTER_LINEAR)
    ink *= (1 - np.clip((front - 0.4) / 0.35, 0, 1))[..., None]
    out = pano.astype(np.float32) * (1 - ink[..., 3:]) + ink[..., :3] * 255
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)
