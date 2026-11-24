"""Pictures for the making-of page: the same view of a world at each stage of
the pipeline, cut from the render passes.

    python scripts/make_process.py

Reads blender/renders/<scene>/*.png and writes blender/renders/process/*.png;
`node scripts/build-assets.mjs process` then encodes them for the web.
Passes that have not been rendered are skipped.
"""

import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import looks  # noqa: E402
from drawing import hang  # noqa: E402
from pano_views import perspective  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
RENDERS = os.path.join(ROOT, "blender", "renders")
OUT = os.path.join(RENDERS, "process")
SIZE = (1600, 1000)
FOV = 92

# yaw, pitch of the view shown for each scene
VIEWS = {
    "wave": (-18, 14),
    "rain": (-2, -14),
    "moonlight": (22, 3),
    "stillness": (3, -2),
}


def read(scene, name):
    path = os.path.join(RENDERS, scene, f"{name}.png")
    if not os.path.exists(path):
        return None
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    return img.astype(np.float32) / (65535.0 if img.dtype == np.uint16 else 255.0)


def view(pano, scene):
    yaw, pitch = VIEWS[scene]
    return perspective(pano, yaw, pitch, FOV, *SIZE)


def save(name, img):
    os.makedirs(OUT, exist_ok=True)
    cv2.imwrite(os.path.join(OUT, f"{name}.png"), (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
    print("wrote", name)


def over(img, background):
    """Composite a BGRA pass over a flat colour."""
    if img.shape[2] < 4:
        return img
    a = img[..., 3:4]
    return img[..., :3] * a + np.array(background, np.float32) * (1 - a)


def distance(depth):
    """Metres from the depth pass (see blender/scripts/common.py); inf on the sky."""
    v = depth[..., 0]
    linear = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    d = 20.0 * (1.0 / np.maximum(linear, 1e-6) - 1.0)
    return np.where(depth[..., 3] > 0.5, d, np.inf)


def depth_picture(depth):
    """Near is light, far is dark: the disparity the viewer uses for parallax."""
    d = distance(depth)
    near = np.percentile(d[np.isfinite(d)], 0.5)
    disparity = np.clip(near / np.maximum(d, near), 0, 1) ** 0.45
    return np.repeat(disparity[..., None], 3, axis=2)


def colour_passes(scene, names):
    for name in names:
        img = read(scene, name)
        if img is not None:
            save(f"{scene}-{name}", view(img[..., :3], scene))


def save_mask(scene):
    """Red water, green sky, blue lights. The sky is wherever the mask render
    saw nothing: green, as scripts/build-assets.mjs encodes it."""
    mask = read(scene, "mask")
    if mask is None:
        return
    m = mask[..., :3].copy()
    if mask.shape[2] == 4:
        m[..., 1] = np.maximum(m[..., 1], 1 - mask[..., 3])
    save(f"{scene}-mask", view(m, scene))


def strokes_read(scene):
    """The painting as scripts/strokes_from_picture.py reads it: the first brushes, then finer ones."""
    path = os.path.join(RENDERS, scene, "strokes.npz")
    if not os.path.exists(path):
        return
    with np.load(path) as f:  # read once: every access to the archive unpacks the whole array again
        s = {k: f[k] for k in f.files}
    w, h = 2000, int(np.ceil(s["y"].max()))
    canvas = np.full((h, w, 3), 168, np.uint8)
    last = int(s["layer"].max())
    cut = {0: "broad", 2: "middle", last: "fine"}
    for n in range(last + 1):
        for i in np.flatnonzero(s["layer"] == n):
            dx, dy = np.cos(s["angle"][i]) * s["length"][i] / 2, np.sin(s["angle"][i]) * s["length"][i] / 2
            a = (int((s["x"][i] - dx) * 8), int((s["y"][i] - dy) * 8))
            b = (int((s["x"][i] + dx) * 8), int((s["y"][i] + dy) * 8))
            colour = [float(v) * 255 for v in s["colour"][i][::-1]]
            cv2.line(canvas, a, b, colour, max(1, int(round(s["width"][i] * 0.9))), cv2.LINE_AA, 3)
        if n in cut:
            # the fires and the colliers, large enough for the marks to be seen
            part = canvas[int(h * 0.36):int(h * 0.36) + 625, 1000:2000]
            save(f"{scene}-{cut[n]}", cv2.resize(part, SIZE, interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255.0)


def main():
    # ── a woodblock world: flat colour, three data passes, ink lines, paper ──
    colour_passes("rain", ["beauty", "final"])
    for name, background in (("id", (0.06, 0.06, 0.06)), ("normal", (0.5, 0.5, 0.5))):
        img = read("rain", name)
        if img is not None:
            save(f"rain-{name}", view(over(img, background), "rain"))
    depth = read("rain", "depth")
    if depth is not None:
        save("rain-depth", view(depth_picture(depth), "rain"))
        # the outlines on their own, as the print would look before colour
        h, w = depth.shape[:2]
        lines = looks.ink_lines(os.path.join(RENDERS, "rain"), (w, h), 3.0 * w / 8192)
        paper = np.array([0.80, 0.87, 0.90], np.float32)  # BGR
        ink = np.array([0.14, 0.13, 0.11], np.float32)
        save("rain-lines", view(paper * (1 - lines[..., None]) + ink * lines[..., None], "rain"))

    first = read("rain-old", "final")
    if first is not None:
        save("rain-first", perspective(first[..., :3], 0, -8, FOV, *SIZE))
    folder = os.path.join(RENDERS, "rain")
    plate = read("rain", "final")
    if plate is not None and os.path.exists(os.path.join(folder, "drawing-0.png")):
        printed = hang((plate[..., :3] * 255 + 0.5).astype(np.uint8), folder)
        save("rain-print", view(printed.astype(np.float32) / 255.0, "rain"))
        save("rain-people", perspective(printed.astype(np.float32) / 255.0, 0, -21, 34, *SIZE))

    # ── the great wave: the first one, the plate, and the drawing over it through one cycle ──
    first = read("wave-old", "final")
    if first is not None:
        save("wave-first", view(first[..., :3], "wave"))
    plate = read("wave", "final")
    if plate is not None:
        plate = plate[..., :3]
        save("wave-plate", view(plate, "wave"))
        for name, t in (("final", "0"), ("falling", "0.18"), ("breaking", "0.36"), ("rising", "0.82")):
            folder = os.path.join(RENDERS, "wave")
            if not os.path.exists(os.path.join(folder, f"drawing-{t}.png")):
                print(f"skip wave-{name}: run node scripts/draw-sheet.mjs")
                continue
            printed = hang((plate * 255 + 0.5).astype(np.uint8), folder, t)
            save(f"wave-{name}", view(printed.astype(np.float32) / 255.0, "wave"))

    # ── the river: the two before it, and the painting read as strokes, from broad to fine ──
    colour_passes("moonlight", ["final"])
    second = read("moonlight-second", "final")
    if second is not None:
        save("moonlight-second", perspective(second[..., :3], *VIEWS["moonlight"], FOV, *SIZE))
    strokes_read("moonlight")
    depth = read("moonlight", "depth")
    if depth is not None:
        save("moonlight-depth", view(depth_picture(depth), "moonlight"))
    save_mask("moonlight")
    first = read("moonlight-old", "final")
    if first is not None:
        save("moonlight-first", perspective(first[..., :3], *VIEWS["moonlight"], FOV, *SIZE))

    # ── the pond: the first one, filtered, and the one made of strokes; then close to ──
    first = read("stillness-old", "final")
    if first is not None:
        save("stillness-first", perspective(first[..., :3], 0, -6, FOV, *SIZE))
    pond = read("stillness", "final")
    if pond is not None:
        save("stillness-final", view(pond[..., :3], "stillness"))
        save("stillness-close", perspective(pond[..., :3], -2, -12, 34, *SIZE))

    # ── what the browser receives: the whole panorama, unrolled ──
    pano = read("moonlight", "final")
    if pano is not None:
        save("moonlight-pano", cv2.resize(pano[..., :3], (2400, 1200), interpolation=cv2.INTER_AREA))


if __name__ == "__main__":
    main()
