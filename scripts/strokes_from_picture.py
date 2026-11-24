"""Read a painting as brush strokes: from broad to fine, each laid along the
forms of the picture, the fine ones only where the broad ones have not yet
said enough.

    python scripts/strokes_from_picture.py moonlight

Reads blender/sources/<picture>, writes blender/renders/<scene>/strokes.npz
(centre x y, angle, length, width in pixels of a copy WIDTH wide; colour; the
layer each belongs to). blender/scripts/<scene>.py hangs them in space.
"""

import os
import sys

import cv2
import numpy as np

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
PICTURES = {"moonlight": "turner-keelmen.jpg"}
WIDTH = 2000
# brush width (px), how far apart, how wrong the picture must still be there (0..1), longest stroke in brush widths
LAYERS = [(52, 0.62, 0.0, 5.0), (27, 0.6, 0.0, 5.0), (14, 0.6, 0.028, 5.5), (7.5, 0.62, 0.034, 6.5), (4.2, 0.7, 0.045, 8.0), (2.6, 0.85, 0.06, 9.0)]

rng = np.random.default_rng(1835)


def orientation(grey, sigma):
    """Direction along the forms (radians) and how definite it is (0..1)."""
    g = cv2.GaussianBlur(grey, (0, 0), max(0.8, sigma * 0.35))
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    b = lambda a: cv2.GaussianBlur(a, (0, 0), max(1.2, sigma))
    xx, xy, yy = b(gx * gx), b(gx * gy), b(gy * gy)
    root = np.sqrt((xx - yy) ** 2 + 4 * xy * xy)
    return 0.5 * np.arctan2(2 * xy, xx - yy) + np.pi / 2, root / np.maximum(xx + yy, 1e-9)


def main(scene):
    img = cv2.imread(os.path.join(ROOT, "blender", "sources", PICTURES[scene]), cv2.IMREAD_COLOR)
    h = round(img.shape[0] * WIDTH / img.shape[1])
    img = cv2.resize(img, (WIDTH, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    canvas = np.full_like(img, np.median(img, axis=(0, 1)))
    out = {k: [] for k in ("x", "y", "angle", "length", "width", "colour", "layer")}
    for n, (w, apart, wrong, longest) in enumerate(LAYERS):
        ref = cv2.GaussianBlur(img, (0, 0), w * 0.32)
        angle, sure = orientation(grey, w * 0.8)
        step = w * apart
        ys, xs = np.mgrid[step / 2:h:step, step / 2:WIDTH:step]
        # a little past the edge, so the picture is closed at its rim
        xs = np.clip(xs.ravel() + rng.uniform(-0.5, 0.5, xs.size) * step, 0, WIDTH - 1)
        ys = np.clip(ys.ravel() + rng.uniform(-0.5, 0.5, ys.size) * step, 0, h - 1)
        miss = cv2.GaussianBlur(np.abs(canvas - ref).mean(2), (0, 0), w * 0.4)
        order = rng.permutation(len(xs))
        kept = 0
        for i in order:
            x, y = xs[i], ys[i]
            xi, yi = int(x), int(y)
            if miss[yi, xi] < wrong:
                continue
            s = float(sure[yi, xi])
            # no clear form: level strokes on the water, arcs left to the sky's own faint gradients
            a = float(angle[yi, xi])
            if s < 0.22 and y > h * 0.67:
                a = rng.normal(0, 0.06)
            a += rng.normal(0, 0.10 + 0.25 * (1 - s))
            length = w * (1.6 + (longest - 1.6) * min(1, s * 1.15)) * rng.uniform(0.75, 1.2)
            # stop where the colour changes
            c = ref[yi, xi]
            reach = length / 2
            for sign in (-1, 1):
                for t in np.linspace(0.3, 1, 5) * length / 2:
                    px, py = int(x + sign * np.cos(a) * t), int(y + sign * np.sin(a) * t)
                    if not (0 <= px < WIDTH and 0 <= py < h) or np.abs(ref[py, px] - c).mean() > 0.075:
                        reach = min(reach, max(t, w * 0.9))
                        break
            length = reach * 2
            c = np.clip(c + rng.normal(0, 0.008, 3) + rng.normal(0, 0.012), 0, 1)
            dx, dy = np.cos(a) * length / 2, np.sin(a) * length / 2
            cv2.line(canvas, (int(x - dx), int(y - dy)), (int(x + dx), int(y + dy)), [float(v) for v in c], max(1, int(round(w * 0.9))), cv2.LINE_AA)
            for k, v in zip(out, (x, y, a, length, w * rng.uniform(0.85, 1.15), c[::-1], n)):
                out[k].append(v)
            kept += 1
        print(f"brush {w:>4}: {kept} strokes, still off by {np.abs(canvas - img).mean():.4f}")
    folder = os.path.join(ROOT, "blender", "renders", scene)
    os.makedirs(folder, exist_ok=True)
    np.savez_compressed(os.path.join(folder, "strokes.npz"), size=np.array([WIDTH, h]), **{k: np.array(v, np.float32) for k, v in out.items()})
    cv2.imwrite(os.path.join(folder, "strokes-preview.jpg"), (canvas * 255).astype(np.uint8))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "moonlight")
