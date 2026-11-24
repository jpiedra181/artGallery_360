"""Where each point of a painting is in its world: the crossing between the
two starts from this, so that what is painted turns into what is there.

    python scripts/registration.py

For each room a few things are named twice: where they are on the picture (in
pixels of a copy of the given width and height) and their direction in the
world (yaw and Mercator height, degrees). A thin-plate spline through them is
sampled on a grid, left to right and top to bottom, which the viewer
interpolates. Writes src/data/registration.json.
"""

import json
import math
import os

import numpy as np

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
NX, NY = 9, 7


def merc(pitch):
    return math.degrees(math.asinh(math.tan(math.radians(pitch))))


def seen(x, y, z, eye):
    """Direction of a point of the world (x right, y forward, z up)."""
    return math.degrees(math.atan2(x, y)), merc(math.degrees(math.atan2(z - eye, math.hypot(x, y))))


def spline(size, pairs, smooth=0.0):
    W, H = size
    p = np.array([[u / W, v / H * H / W] for (u, v), _ in pairs], float)
    y = np.array([d for _, d in pairs], float)
    n = len(p)
    r = np.linalg.norm(p[:, None] - p[None], axis=2)
    k = np.where(r > 0, r * r * np.log(np.maximum(r, 1e-9)), 0) + smooth * np.eye(n)
    q = np.hstack([np.ones((n, 1)), p])
    a = np.block([[k, q], [q.T, np.zeros((3, 3))]])
    w = np.linalg.solve(a, np.vstack([y, np.zeros((3, 2))]))
    grid = []
    for j in range(NY):
        for i in range(NX):
            g = np.array([i / (NX - 1), j / (NY - 1) * H / W])
            d = np.linalg.norm(p - g, axis=1)
            phi = np.where(d > 0, d * d * np.log(np.maximum(d, 1e-9)), 0)
            grid.append(phi @ w[:n] + np.array([1, *g]) @ w[n:])
    return [round(float(v), 2) for v in np.array(grid).ravel()]


# ── the wave: drawn in the print's own pixels (PLACE in worlds/great-wave.ts) ──

def wave():
    return [round(v, 2) for j in range(NY) for i in range(NX) for v in ((1800 * i / (NX - 1) - 990) / 16.5, (885 - 1210 * j / (NY - 1)) / 16.5)]


# ── the rain: layout of blender/scripts/rain.py ──

def rain():
    eye, al, st = 22, (0.848, 0.53), (-9, 22)
    deck = lambda s: 5.6 + 3.2 * (1 - ((s - 55) / 78) ** 2)
    on = lambda s, t, z=0.0: seen(st[0] + al[0] * s + al[1] * t, st[1] + al[1] * s - al[0] * t, deck(s) + z, eye)
    far = lambda f, z: seen(0.871 * f + 0.491 * 129, -0.491 * f + 0.871 * 129, z, eye)
    return spline((1100, 1572), [
        ((295, 1105), on(4.6, 0.1, 0.9)), ((460, 1035), on(9, -0.9, 0.9)), ((648, 960), on(13.4, -1.7, 0.9)), ((775, 925), on(18.2, -2, 0.9)),
        ((225, 800), seen(-19.5, 75.5, 1, eye)), ((540, 850), seen(-4, 71, 0, eye)),
        ((140, 510), far(-165, 6)), ((258, 520), far(-128, 6)), ((380, 527), far(-96, 6)),
        ((75, 555), far(-190, 0)), ((1035, 715), far(30, 0)),
        ((75, 1115), on(-7, -3.2, 0.8)), ((1030, 870), on(27, -3.2, 0.8)), ((1030, 985), on(25, 3.2, 0.8)), ((75, 1330), on(-4, 3.2, 0.8)),
        ((550, 1480), seen(-2, 26, 0, eye)), ((1000, 1430), seen(17, 32, 0, eye)), ((400, 150), (-6, 22)), ((900, 150), (14, 22)),
    ], 0.0006)


# ── the pond: layout of blender/scripts/stillness.py ──

def stillness():
    eye = 1.75
    deck = lambda x: 1.0 + 1.55 * (1 - ((x - 2.3) / 6.9) ** 2)
    rail = lambda x, dz: seen(x, 7.05, deck(x) + dz, eye)
    water = lambda x, y: seen(x, y, 0, eye)
    return spline((1500, 1334), [
        ((330, 385), rail(-4.3, 1.1)), ((700, 275), rail(-0.6, 1.25)), ((1075, 245), rail(2.3, 1.25)), ((1490, 290), rail(6.2, 1.25)),
        ((400, 590), rail(-4.2, 0)), ((800, 500), rail(-0.2, -0.1)), ((1100, 485), rail(2.3, -0.1)), ((1490, 525), rail(6.2, -0.1)),
        ((500, 690), water(-3.2, 13)), ((900, 655), water(1.5, 16.5)), ((1400, 740), water(8, 13)),
        ((450, 840), water(-2.6, 8.6)), ((900, 850), water(1.5, 8.6)), ((1400, 850), water(6, 8.6)),
        ((300, 990), water(-2.4, 4.9)), ((700, 1000), water(0, 4.9)), ((1300, 1000), water(3.4, 4.9)),
        ((300, 1250), water(-1.3, 2.8)), ((900, 1180), water(0.9, 3.1)), ((1400, 1260), water(2.2, 2.8)),
        ((120, 330), seen(-6.4, 5.4, 3.0, eye)), ((200, 600), seen(-4.6, 4.8, 1.4, eye)),
        ((700, 60), (-3, 34)), ((60, 60), (-46, 36)), ((1200, 90), (33, 34)), ((1480, 60), (50, 36)),
    ], 0.0012)


# ── the river: hung in the picture's own pixels (blender/scripts/moonlight.py) ──

def moonlight():
    return [round(v, 2) for j in range(NY) for i in range(NX) for v in ((1500 * i / (NX - 1) - 700) / 16, (745 - 1114 * j / (NY - 1)) / 16)]


def main():
    out = {"nx": NX, "ny": NY, "rooms": {}}
    for name, fn in (("wave", wave), ("rain", rain), ("stillness", stillness), ("moonlight", globals().get("moonlight"))):
        if fn:
            out["rooms"][name] = fn()
    with open(os.path.join(ROOT, "src", "data", "registration.json"), "w", encoding="utf-8") as f:
        json.dump(out, f)
    print({k: len(v) for k, v in out["rooms"].items()})


if __name__ == "__main__":
    main()
