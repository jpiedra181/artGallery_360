"""Room IV — Moonlight. Inside Turner's "Keelmen Heaving in Coals by Moonlight".

What the painting shows is painted again, stroke by stroke, from broad to
fine (scripts/strokes_from_picture.py reads the strokes off the picture), and
hung around the viewer where each thing stands. What it does not show — the
sky going over and down behind, the river either side, more ships, the boat we
sit in — is laid with the same brush, in colours taken from it.

Every stroke hangs on one sphere, in the order it was laid: a painting has no
other depth. How far things are, what is water, sky or fire is told to the
passes by plain proxies that the picture itself never shows.

Mask pass
  R  water      G  sky      B  fires
"""

import math
import os

import bmesh
import bpy
import numpy as np

import common as C
import printmaking as P
from strokes import EYE, K, RAD, Layer, Palette, along, frame, load_painting, mood, reseed, rng, scatter, srgb_to_linear

PICTURE = "turner-keelmen.jpg"
SCALE = 16.0            # picture pixels (1500 wide) per degree
X0, HORIZON = 700.0, 745.0
W, H = 1500.0, 1114.0
MOON = ((540 - X0) / SCALE, math.degrees(math.atan(math.sinh(math.radians((HORIZON - 408) / SCALE)))))
HEIGHT = 1.5            # of the eye over the water (m)
FAR = 30.0              # radius the strokes hang at (m)


def sheet_dir(px, py):
    """Yaw and pitch (degrees) of a point of the picture."""
    yaw = (np.asarray(px) - X0) / SCALE
    pitch = np.degrees(np.arctan(np.sinh(np.radians((HORIZON - np.asarray(py)) / SCALE))))
    return yaw, pitch


def vec(yaw, pitch):
    y, p = np.radians(yaw), np.radians(pitch)
    return np.stack(np.broadcast_arrays(np.sin(y) * np.cos(p), np.cos(y) * np.cos(p), np.sin(p)), -1)


class Ordered(Layer):
    """Strokes kept in the order they are added, on a sphere that shrinks a hair with each."""

    def __init__(self, name, radius0, radius1):
        super().__init__(name)
        self.r0, self.r1 = radius0, radius1

    def lay(self, dirs, widths_deg, colours, body=0.9):
        """dirs: n×K×3 unit directions; widths in degrees."""
        n = len(dirs)
        self.paths.append(np.asarray(dirs, float))
        self.widths.append(np.broadcast_to(widths_deg, n) * RAD)
        self.colours.append(np.asarray(colours, float))
        self.bodies.append(np.clip(np.broadcast_to(body, n) + rng.normal(0, 0.06, n), 0.15, 1))
        self.lifts.append(np.zeros(n))

    def build(self, coll):
        n = sum(len(p) for p in self.paths)
        r = np.linspace(self.r0, self.r1, n)
        at = 0
        for i, p in enumerate(self.paths):
            ri = r[at:at + len(p)]
            self.paths[i] = EYE + p * ri[:, None, None]
            self.widths[i] = self.widths[i] * ri
            at += len(p)
        obj = super().build(coll)
        for kind in ("mask", "depth"):
            obj[f"skip_{kind}"] = True
        return obj


def arcs(yaw, pitch, angle_deg, length_deg, bend=0.0):
    """Directions along strokes centred at bearings; angle 0 is level, 90 upright."""
    right, up = frame(yaw, pitch)
    a = np.radians(angle_deg)[:, None]
    d = right * np.cos(a) + up * np.sin(a)
    c = vec(yaw, pitch)
    t = np.linspace(-0.5, 0.5, K)[None, :, None] * (np.asarray(length_deg) * RAD)[:, None, None]
    side = np.cross(c, d)
    b = np.broadcast_to(bend, len(yaw))[:, None, None]
    p = c[:, None] + d[:, None] * t + side[:, None] * b * (0.25 * (np.asarray(length_deg) * RAD)[:, None, None] - t * t / np.maximum((np.asarray(length_deg) * RAD)[:, None, None], 1e-6))
    return p / np.linalg.norm(p, axis=2, keepdims=True)


# ─── Colours ──────────────────────────────────────────────────────────────────

class Colours:
    def __init__(self):
        self.img = load_painting(PICTURE, 0.94, 1.1)
        blue = lambda h, s, v: (h > 190) & (h < 235)
        self.pal = Palette(self.img, {
            "deep": (0.12, 0.0, 0.5, 0.12, lambda h, s, v: (h > 195) & (h < 235) & (s > 0.3)),
            "blue": (0.1, 0.0, 1.0, 0.4, blue),
            "cloud": (0.1, 0.1, 0.55, 0.36, lambda h, s, v: v > 0.55),
            "grey": (0.55, 0.15, 0.9, 0.45),
            "haze": (0.5, 0.45, 0.62, 0.66),
            "smoke": (0.63, 0.4, 0.95, 0.64, lambda h, s, v: (s < 0.35) & (v < 0.5)),
            "dark": (0.7, 0.66, 0.95, 0.8, lambda h, s, v: v < 0.28),
            "sail": (0.0, 0.36, 0.1, 0.62, lambda h, s, v: (s < 0.25) & (v < 0.6)),
            "fire": (0.84, 0.56, 1.0, 0.72, lambda h, s, v: (v > 0.45) & (s > 0.35) & (h < 45)),
            "flame": (0.76, 0.62, 1.0, 0.72, lambda h, s, v: (v > 0.7)),
            "rig": (0.9, 0.2, 1.0, 0.6, lambda h, s, v: (h < 50) & (s > 0.3) & (v < 0.6)),
            "wood": (0.6, 0.82, 0.76, 0.9, lambda h, s, v: (h < 50) & (s > 0.25)),
            "water": (0.05, 0.75, 0.6, 0.98),
            "water_blue": (0.2, 0.68, 0.55, 0.78, lambda h, s, v: (h > 80) & (h < 230)),
            "silt": (0.1, 0.85, 0.7, 1.0, lambda h, s, v: (h > 30) & (h < 90)),
            "glint": (0.3, 0.7, 0.42, 1.0, lambda h, s, v: v > 0.75),
        })

        self.smoke = self.pal.pick("smoke", 600).mean(0) * 0.95 + 0.07
        self.ember = self.pal.pick("fire", 600).mean(0)
        r = self.img.shape[1] // 90
        soft = self.img.astype(np.float32)
        for axis in (0, 1, 0, 1):
            pad = [(0, 0)] * 3
            pad[axis] = (r + 1, r)
            c = np.cumsum(np.pad(soft, pad, "edge"), axis)
            m = c.shape[axis]
            soft = (np.take(c, range(2 * r + 1, m), axis) - np.take(c, range(0, m - 2 * r - 1), axis)) / (2 * r + 1)
        self.soft = soft

    def margin(self, x0, reach, py):
        """The picture from a column to a little further in, without its small things: folded over its edge, it goes on from there."""
        Hh, Ww = self.soft.shape[:2]
        n = len(py)
        x = (np.clip(x0 + rng.random(n) * reach, 4, W - 4) / W * Ww).astype(int)
        y = np.clip((py + rng.normal(0, 8, n)) / H * Hh, 0, Hh - 1).astype(int)
        return self.soft[y, x]

    def at(self, px, py):
        Hh, Ww = self.img.shape[:2]
        x = np.clip(np.asarray(px) / W * Ww, 0, Ww - 1).astype(int)
        y = np.clip(np.asarray(py) / H * Hh, 0, Hh - 1).astype(int)
        return self.img[y, x]

    def outside(self, yaw, pitch):
        """Colour of sky or water beyond the picture: what its edge has at that height, going over to its blues."""
        n = len(yaw)
        water = pitch < 0
        py = HORIZON - np.degrees(np.arcsinh(np.tan(np.radians(np.clip(pitch, -80, 80))))) * SCALE
        x = X0 + yaw * SCALE
        # columns of the picture that hold no ship
        r = rng.random(n)
        right = np.where(py < 300, 1300 + r * 170, np.where(py < HORIZON, 850 + r * 60, 880 + r * 90))
        left = np.where(py < 330, 20 + r * 150, np.where(py < HORIZON, 150 + r * 70, 130 + r * 80))
        edge = np.where(yaw > 0, right, left)
        edge = np.where((x > 40) & (x < 1460) & ((py < 0) | (py > 1090)), x, edge)
        base = self.at(edge + rng.normal(0, 1, n) * (14 + np.maximum(0, -py) * 0.55), np.clip(py + rng.normal(0, 14, n), 4, 1100))
        off = np.maximum(np.maximum(-x, x - W), 0) / SCALE
        off = np.maximum(off, np.maximum(0, -py) / SCALE * 1.5)
        back = P.smoothstep(2, 62, off)
        m, g = mood(yaw, pitch, 5), mood(yaw * 1.7, pitch * 1.7, 23)
        u = m + rng.normal(0, 0.1, n)
        pick = np.where((u > 0.74)[:, None], self.pal.pick("cloud", n, 0.05 + 0.4 * g), np.where((u > 0.36)[:, None], self.pal.pick("blue", n, 0.15 + 0.6 * g), self.pal.pick("deep", n, 0.15 + 0.6 * g)))
        low = P.smoothstep(16, 1, np.abs(pitch))
        sky = pick * (1 - low)[:, None] + (self.pal.pick("blue", n, 0.5) * 0.7 + self.pal.pick("grey", n, 0.4) * 0.25) * low[:, None]
        # the water carries the sky, browner
        wet = sky * 0.62 + self.pal.pick("silt", n, 0.3) * 0.26
        far = np.where(water[:, None], wet, sky)
        dim = 1 - 0.36 * P.smoothstep(50, 170, np.abs(np.where(yaw > 180, yaw - 360, yaw) - MOON[0]))
        c = base * (1 - back)[:, None] + far * back[:, None]
        # against the picture itself, what its margin has: the picture goes on before it changes
        side = np.where(yaw[:, None] > 0, self.margin(W - 6 - off * 9, -44, py), self.margin(6 + off * 7, 44, py))
        near = np.exp(-(off / np.where(yaw > 0, 14, 8)) ** 2) * ((py > 0) & (py < 1100))
        c = c * (1 - near)[:, None] + (side * 0.85 + c * 0.15) * near[:, None]
        # the smoke of the fires, lying over the river to the right
        s = mood(yaw * 2.2 - pitch * 1.6, pitch * 4, 77) * 0.6 + mood(yaw * 6 - pitch * 4, pitch * 11, 78) * 0.4
        top = 17 * np.exp(-((yaw - 48) / 22) ** 2) + 5.5 * np.exp(-((yaw - 74) / 12) ** 2) + 2
        thick = np.clip(P.smoothstep(top * 1.15, top * 0.2, pitch + (s - 0.5) * 9) * (0.7 + 0.7 * s), 0, 0.92)
        thick = thick * (pitch > -0.5) * P.smoothstep(40, 47, yaw) * P.smoothstep(108, 78, yaw)
        tint = self.smoke * (0.82 + 0.5 * (s - 0.5))[:, None]
        for fy, fp, fr in ((54, 3.5, 4.5), (65.5, 3, 4), (80.5, 2.2, 3.2)):
            glow = np.exp(-(((yaw - fy) / fr) ** 2 + ((pitch - fp) / fr / 1.1) ** 2))
            tint = tint * (1 - 0.55 * glow)[:, None] + self.ember * (0.55 * glow)[:, None]
        c = c * (1 - thick)[:, None] + tint * thick[:, None]
        return np.clip(c * dim[:, None], 0, 1)


# ─── Sky and river all round ──────────────────────────────────────────────────

def around_moon(yaw, pitch):
    """The way clouds are swept: round the moon. Degrees from level."""
    m = vec(MOON[0], MOON[1])
    c = vec(yaw, pitch)
    tangent = np.cross(c, m)
    right, up = frame(yaw, pitch)
    return np.degrees(np.arctan2((tangent * up).sum(1), (tangent * right).sum(1)))


def surround(col, layer):
    for count, w, l, body in ((15000, 2.6, 8.0, 0.95), (36000, 1.35, 5.2, 0.8), (52000, 0.7, 3.4, 0.62), (34000, 0.36, 2.4, 0.6)):
        yaw, pitch = scatter(count, (-180, 180), (-84, 90))
        c = col.outside(yaw, pitch)
        sky = pitch > 0
        # swept round the moon near it, and lying down as they go from it
        turn = around_moon(yaw, pitch)
        turn = (turn + 90) % 180 - 90
        away = np.degrees(np.arccos(np.clip((vec(yaw, pitch) * vec(MOON[0], MOON[1])).sum(1), -1, 1)))
        angle = np.where(sky, turn * (1 - 0.86 * P.smoothstep(34, 80, away)) + rng.normal(0, 10, count), rng.normal(0, 3, count))
        # towards the horizon everything lies level
        near = P.smoothstep(14, 2, np.abs(pitch)) * sky
        angle = angle * (1 - near)
        length = l * rng.uniform(0.6, 1.4, count) * np.where(sky, 1, 0.8 + 0.8 * np.clip(-pitch / 40, 0, 1))
        width = w * rng.uniform(0.6, 1.3, count) * np.where(sky, 1, np.clip(0.35 + -pitch / 30, 0.35, 1))
        c = np.clip(c + rng.normal(0, 0.014, (count, 3)) + rng.normal(0, 0.02, (count, 1)), 0, 1)
        layer.lay(arcs(yaw, pitch, angle, length, rng.normal(0, 0.25, count)), width, c, body)


# ─── What the painting does not reach ─────────────────────────────────────────

def line(a, b, n, jitter=0.0):
    """Directions of n strokes along the straight line between two points of the world."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    t = np.sort(rng.random(n))
    c = a + (b - a) * t[:, None] + rng.normal(0, jitter, (n, 3))
    L = np.linalg.norm(b - a) * rng.uniform(0.5, 1.2, n) / max(1, n ** 0.55)
    return dirs(along(c, np.tile(b - a, (n, 1)), np.minimum(L, np.linalg.norm(b - a)), rng.normal(0, 0.05, n)))


def dirs(paths):
    d = paths - EYE
    return d / np.linalg.norm(d, axis=2, keepdims=True)


def width_at(p, metres):
    return np.degrees(metres / np.maximum(np.linalg.norm(np.asarray(p) - EYE, axis=-1), 0.1))


def ship(col, layer, proxies, yaw, dist, heading, length=26.0, sails=True, warm=0.0, haze=0.0, masts=3):
    """A ship from strokes: hull, masts, yards, sails or bare rigging, and all of it again in the water."""
    at = EYE + vec(yaw, 0) * dist
    at[2] = 0
    ax = np.array([math.sin(heading * RAD), math.cos(heading * RAD), 0])
    tint = np.array([0.36, 0.47, 0.56])

    def paint(paths, metres, colours, body=0.85):
        colours = np.clip(colours * (1 - haze) + tint * haze, 0, 1)
        n = len(paths)
        widths = width_at(paths.mean(1), metres)
        layer.lay(dirs(paths), widths, colours, body)
        # in the water: level touches, broken more the further down they are
        keep = rng.random(n) < 0.8
        low = paths.mean(1)[keep] * np.array([1, 1, -0.9])
        depth = -low[:, 2]
        m = int(keep.sum())
        across = np.array([math.cos(yaw * RAD), -math.sin(yaw * RAD), 0])
        low = low + across * (rng.normal(0, 0.02, m) * depth)[:, None] + np.array([0, 0, 1]) * rng.normal(0, 0.15, m)[:, None]
        long = np.maximum(metres if np.isscalar(metres) else metres[keep], 0.12) * rng.uniform(1.6, 3.4, m)
        wet = colours[keep] * 0.5 + col.outside(np.full(m, float(yaw)), np.degrees(np.arctan2(low[:, 2] - EYE[2], dist))) * 0.5
        layer.lay(dirs(along(low, np.tile(across, (m, 1)), long)), widths[keep] * 0.6, np.clip(wet, 0, 1), body * 0.62 * (1 - 0.5 * haze) * np.exp(-depth / (length * 0.7)))

    h = length * 0.13
    n = 120
    t, z = rng.uniform(-0.46, 0.46, n), rng.uniform(0.05, 0.9, n)
    c = at + ax * (t * length * 0.9)[:, None] + np.array([0, 0, 1]) * (z * h)[:, None]
    paint(along(c, np.tile(ax, (n, 1)), length * rng.uniform(0.08, 0.16, n)), h * 0.26, col.pal.pick("dark", n) * 0.85, 0.95)
    n = 800
    t, z = rng.uniform(-0.5, 0.5, n), rng.uniform(0, 1, n)
    # the hull narrows below and rises at its ends
    t = t * (0.84 + 0.16 * z)
    sheer = 1 + 0.42 * (2 * np.abs(t)) ** 2.4
    c = at + ax * (t * length)[:, None] + np.array([0, 0, 1]) * (z * h * sheer)[:, None]
    paint(along(c, np.tile(ax, (n, 1)), length * rng.uniform(0.03, 0.08, n)), h * 0.085, col.pal.pick("dark", n) * (0.9 + 0.5 * warm) + col.pal.pick("fire", n) * 0.28 * warm * (z > 0.4)[:, None], 0.92)
    for k in range(masts):
        f = (k + 0.5) / masts - 0.5
        foot = at + ax * f * length * 0.78 + np.array([0, 0, h])
        top = foot + np.array([0, 0, length * (0.95 - 0.16 * abs(k - 1))])
        n = 46
        tt = rng.random(n)
        c = foot + (top - foot) * tt[:, None]
        paint(along(c, np.tile([0.0, 0, 1], (n, 1)), length * rng.uniform(0.04, 0.1, n)), 0.24 * (1.25 - tt), col.pal.pick("rig", n) * (0.6 + 0.6 * warm), 0.9)
        for lv, w in ((0.34, 0.36), (0.58, 0.28), (0.8, 0.2)):
            y = foot + (top - foot) * lv
            n = 18
            c = y + ax * (rng.uniform(-0.5, 0.5, n) * w * length * 0.62)[:, None]
            paint(along(c, np.tile(ax, (n, 1)), length * rng.uniform(0.04, 0.09, n)), 0.16, col.pal.pick("rig", n) * (0.55 + 0.6 * warm), 0.9)
            # one or two are furled
            if sails and rng.random() > 0.16:
                lit = math.sin((MOON[0] - yaw) * RAD) * np.sign(ax @ np.array([math.cos(yaw * RAD), -math.sin(yaw * RAD), 0]))
                cloth = lambda u, v, m: np.clip(col.pal.pick("sail", m, 0.3 + 0.4 * rng.random(m)) * (0.74 + 0.16 * v + 0.46 * lit * u + 0.1 * np.cos(u * 9))[:, None] + np.array([0.07, 0.065, 0.045]) * (0.5 + lit * u)[:, None], 0, 1)
                n = 40
                u, v = rng.uniform(-0.46, 0.46, n), rng.random(n) * 0.92 + 0.04
                c = y + ax * (u * w * length * 0.56 * (1 + 0.12 * v))[:, None] - np.array([0, 0, 1]) * (v * length * 0.17)[:, None]
                paint(along(c, np.tile([0.0, 0, 1], (n, 1)), length * rng.uniform(0.05, 0.08, n)), length * 0.034, cloth(u, v, n), 0.85)
                n = 240
                u, v = rng.uniform(-0.5, 0.5, n), rng.random(n)
                c = y + ax * (u * w * length * 0.56 * (1 + 0.12 * v))[:, None] - np.array([0, 0, 1]) * (v * length * 0.17)[:, None]
                paint(along(c, np.tile([0.0, 0, 1], (n, 1)) + ax * rng.normal(0, 0.08, (n, 1)), length * rng.uniform(0.025, 0.055, n)), length * 0.012, cloth(u, v, n), 0.72)
        # stays: a few single hairs
        for side in (-1, 1):
            for e in (0.16, 0.3):
                n = 10
                a = top - (top - foot) * 0.12
                b = foot + ax * side * length * e
                cc = a + (b - a) * rng.random(n)[:, None]
                paint(along(cc, np.tile(b - a, (n, 1)), length * 0.1 * np.ones(n)), 0.05, col.pal.pick("rig", n) * 0.55, 0.6)
    proxies.append((at - ax * length * 0.5, at + ax * length * 0.5, length * 1.05))


def fire(col, layer, glow, yaw, dist, size=1.0, z=1.6):
    """A brazier: smoke, the glow on it, the flame, and its path on the water."""
    c0 = EYE + vec(yaw, 0) * dist
    c0[2] = z
    n = 150
    r = rng.random(n) ** 0.6 * 2.6 * size
    a = rng.uniform(0, 2 * math.pi, n)
    side = np.array([math.cos(yaw * RAD), -math.sin(yaw * RAD), 0])
    c = c0 + side * (np.cos(a) * r)[:, None] + np.array([0, 0, 1]) * (np.abs(np.sin(a)) * r * 1.2 + r * 0.3)[:, None]
    p = along(c, side * np.cos(a + 1.2)[:, None] + np.array([0, 0, 1]) * np.sin(a + 1.2)[:, None], rng.uniform(0.4, 1.1, n) * size, rng.normal(0, 0.8, n))
    layer.lay(dirs(p), width_at(c, 0.34 * size), col.pal.pick("smoke", n) * 0.62 + col.pal.pick("fire", n) * np.exp(-r / (2.1 * size))[:, None] * 0.85, 0.34)
    n = 60
    r = rng.random(n) ** 1.2 * 0.75 * size
    a = rng.uniform(0, 2 * math.pi, n)
    c = c0 + side * (np.cos(a) * r * 0.7)[:, None] + np.array([0, 0, 1]) * (r * 1.5)[:, None]
    layer.lay(dirs(along(c, np.tile([0.0, 0, 1], (n, 1)) + rng.normal(0, 0.3, (n, 3)), rng.uniform(0.2, 0.5, n) * size, rng.normal(0, 0.6, n))), width_at(c, 0.16 * size), col.pal.pick("flame", n) * 1.06, 0.95)
    n = 46
    zz = -rng.random(n) ** 0.8 * 5.0 * size - 0.3
    c = c0 * np.array([1, 1, 0]) + side * rng.normal(0, 0.3 * size, n)[:, None] + np.array([0, 0, 1]) * zz[:, None]
    layer.lay(dirs(along(c, np.tile(side, (n, 1)), rng.uniform(0.4, 1.1, n) * size)), width_at(c, 0.2 * size), col.pal.pick("flame", n) * 0.85 + col.pal.pick("fire", n) * 0.1, 0.6)
    glow.append((yaw, math.degrees(math.atan2(z + 0.6 - EYE[2], dist)), math.degrees(2.4 * size / dist)))


def beyond(col, layer, proxies, glow):
    # the far shores, low in the haze
    n = 2600
    yaw = rng.uniform(50, 316, n)
    pitch = np.abs(rng.normal(0, 0.5, n)) * (0.6 + 0.9 * mood(yaw * 3, np.zeros(n), 61))
    layer.lay(arcs(yaw, pitch, rng.normal(0, 8, n), rng.uniform(0.6, 2.4, n)), rng.uniform(0.2, 0.5, n), col.pal.pick("blue", n, 0.1) * 0.62 + col.pal.pick("smoke", n) * 0.2, 0.6)
    for yaw, dist, heading, length, sails, warm, haze in (
        (60, 30, 138, 30, False, 0.5, 0.1), (78, 44, 160, 27, False, 0.22, 0.34), (99, 62, 198, 26, False, 0.08, 0.52),
        (126, 88, 228, 26, True, 0, 0.66), (152, 74, 232, 24, True, 0, 0.6), (198, 96, 300, 28, True, 0, 0.7), (230, 66, 308, 24, True, 0, 0.58), (264, 44, 372, 26, True, 0, 0.4), (307.5, 21, 385, 17, True, 0.0, 0.06),
    ):
        ship(col, layer, proxies, yaw, dist, heading, length, sails, warm, haze)
    # the brown that the fires of the painting lay on the water (their smoke is in the sky: Colours.outside)
    yaw = 45 + np.abs(rng.normal(0, 13, n))
    pitch = -rng.uniform(0.6, 19, n)
    thin = np.exp(-((yaw - 45) / 17) ** 2)
    layer.lay(arcs(yaw, pitch, rng.normal(0, 3, n), rng.uniform(1.0, 3.4, n)), rng.uniform(0.25, 0.8, n), col.at(W - 10 - np.clip(yaw - 49, 0, 30) * 10 - rng.random(n) * 60, np.clip(HORIZON + np.degrees(np.arcsinh(np.tan(np.radians(-pitch)))) * SCALE, 0, 1100)), 0.12 + 0.6 * thin)
    for yaw, dist, size in ((55, 24, 0.9), (66, 30, 1.0), (81, 38, 0.8)):
        fire(col, layer, glow, yaw, dist, size)
    # keels lying low with their heaps of coal, and men on them
    for yaw, dist in ((53, 22), (63, 26), (73, 34)):
        at = EYE + vec(yaw, 0) * dist
        side = np.array([math.cos(yaw * RAD), -math.sin(yaw * RAD), 0])
        n = 130
        u = rng.uniform(-0.5, 0.5, n)
        c = at * np.array([1, 1, 0]) + side * (u * 10)[:, None] + np.array([0, 0, 1]) * (rng.random(n) * (0.55 + 0.5 * np.cos(u * 3)))[:, None]
        layer.lay(dirs(along(c, np.tile(side, (n, 1)), rng.uniform(0.5, 1.3, n))), width_at(c, 0.24), col.pal.pick("dark", n) * 0.8, 0.95)
        for _ in range(5):
            x = at * np.array([1, 1, 0]) + side * rng.uniform(-4, 4)
            m = 12
            c = x + side * rng.normal(0, 0.12, m)[:, None] + np.array([0, 0, 1]) * rng.uniform(0.8, 2.1, m)[:, None]
            layer.lay(dirs(along(c, np.tile([0.0, 0, 1], (m, 1)) + rng.normal(0, 0.25, (m, 3)), rng.uniform(0.3, 0.6, m))), width_at(c, 0.24), col.pal.pick("dark", m) * 0.75, 0.95)
    # lights on the shore
    n = 60
    yaw = rng.uniform(95, 300, n)
    layer.lay(arcs(yaw, rng.uniform(0.2, 0.8, n), rng.uniform(0, 180, n), rng.uniform(0.2, 0.4, n)), 0.16, col.pal.pick("flame", n), 0.9)


# ─── The boat ─────────────────────────────────────────────────────────────────

def hull(u, v):
    """Inside of the rowing boat: u 0 stern .. 1 stem, v -1 port rail .. 0 keel .. 1 starboard rail."""
    y = -2.1 + 5.2 * u
    half = 0.86 * np.clip(1 - np.clip((u - 0.42) / 0.58, 0, 1) ** 2.3, 0, 1) * (0.82 + 0.18 * np.clip(u / 0.3, 0, 1))
    rail = 0.5 + 0.3 * np.clip((u - 0.5) / 0.5, 0, 1) ** 2
    keel = 0.06 + 0.36 * np.clip((u - 0.72) / 0.28, 0, 1) ** 1.6
    a = np.abs(v)
    return np.stack([np.sign(v) * half * a ** 0.62, y, keel + (rail - keel) * a ** 2.2], -1)


def rowboat(col, coll):
    layer = Ordered("boat", 1.0, 1.0)
    paths, widths, colours, bodies = [], [], [], []

    def put(p, w, c, b=0.9):
        paths.append(p); widths.append(np.broadcast_to(w, len(p)).astype(float)); colours.append(np.clip(c, 0, 1)); bodies.append(np.broadcast_to(b, len(p)).astype(float))

    for count, w, gain in ((900, 0.12, 0.6), (1500, 0.06, 0.85), (900, 0.03, 1.15)):
        u, v = rng.random(count) ** 0.9, rng.uniform(-1, 1, count)
        L = rng.uniform(0.06, 0.16, count)
        t = np.linspace(-0.5, 0.5, K)
        uu = np.clip(u[:, None] + t * L[:, None], 0, 0.998)
        # planks: colour runs along them in strakes
        strake = np.floor(np.abs(v) * 5)
        light = 0.5 + 0.5 * np.abs(v) ** 2 + 0.16 * np.sin(strake * 2.4 + np.sign(v))
        c = col.pal.pick("wood", count, 0.35 + 0.3 * rng.random(count)) * 0.62 + col.pal.pick("dark", count) * 0.4
        # moonlight on the port rail's inside, fire on the starboard's
        warm = np.clip(-v, 0, 1)
        c = c * (light * gain * 0.8)[:, None] + col.pal.pick("fire", count) * (0.16 * warm * np.abs(v) ** 3)[:, None] + col.pal.pick("haze", count) * (0.1 * np.clip(v, 0, 1) ** 4)[:, None]
        put(hull(uu, np.repeat(v[:, None], K, 1)), w, c)
    for sg in (-1, 1):  # the rails, lit on top
        for count, w, name, z in ((160, 0.085, "wood", 0.02), (90, 0.04, "haze", 0.045)):
            u = rng.random(count)
            uu = np.clip(u[:, None] + np.linspace(-0.05, 0.05, K), 0, 0.998)
            p = hull(uu, np.full_like(uu, sg * 1.0))
            p[..., 2] += z
            put(p, w, col.pal.pick(name, count, 0.6) * (0.95 if name == "wood" else 0.62))
    for y, z, d in ((1.35, 0.3, 0.26), (-0.75, 0.3, 0.3)):  # thwarts
        u0 = (y + 2.1) / 5.2
        half = float(hull(np.array(u0), np.array(1.0))[0])
        n = 130
        c = np.stack([rng.uniform(-half, half, n) * 0.92, y + rng.uniform(-d, d) * 0 + rng.uniform(-d / 2, d / 2, n), np.full(n, z)], -1)
        put(along(c, np.tile([1.0, 0, 0], (n, 1)), rng.uniform(0.15, 0.5, n)), rng.uniform(0.03, 0.07, n), col.pal.pick("wood", n, 0.6) * rng.uniform(0.6, 0.95, (n, 1)))
    for sg in (-1, 1):  # oars laid along the boat
        n = 70
        a, b = np.array([sg * 0.46, -1.6, 0.4]), np.array([sg * 0.2, 2.1, 0.44])
        c = a + (b - a) * rng.random(n)[:, None]
        put(along(c, np.tile(b - a, (n, 1)), rng.uniform(0.2, 0.5, n)), 0.045, col.pal.pick("wood", n, 0.8) * rng.uniform(0.75, 1.05, (n, 1)))
    p = np.concatenate(paths)
    d = p - EYE
    r = np.linalg.norm(d, axis=2)
    layer.lay(d / r[..., None], np.degrees(np.concatenate(widths) / r.mean(1)), np.concatenate(colours), np.concatenate(bodies))
    layer.r0, layer.r1 = FAR * 0.82, FAR * 0.8
    layer.build(coll)

    # under the strokes, and for the passes, the plain hull
    n, m = 70, 33
    uu, vv = np.meshgrid(np.linspace(0, 0.999, n), np.linspace(-1, 1, m), indexing="ij")
    verts = hull(uu, vv).reshape(-1, 3)
    solid = P.mesh_from_arrays("hull", EYE + (verts - EYE) / np.linalg.norm(verts - EYE, axis=1, keepdims=True) * FAR * 0.825, P.grid_faces(n, m), coll)
    dark = col.pal.pick("dark", 300).mean(0) * 0.8
    C.assign(solid, C.emission_material("hull", tuple(srgb_to_linear(dark)), 1.0))
    for kind in ("mask", "depth"):
        solid[f"skip_{kind}"] = True
    # a little larger than the hull: the strokes of its rail stand out from it
    proxy(P.mesh_from_arrays("hull_proxy", verts * [1.1, 1.0, 1.0] + [0, 0.06, 0.05], P.grid_faces(n, m), coll), (0, 0, 0))


# ─── Proxies: what the passes see ─────────────────────────────────────────────

def proxy(obj, mask):
    C.set_mask(obj, mask)
    obj["only_passes"] = True
    obj.hide_render = True
    C.assign(obj, C.emission_material("proxy", (0, 0, 0), 1.0))
    return obj


def outline(name, points, dist, mask, coll):
    """A flat shape of the picture, standing at a distance."""
    yaw, pitch = sheet_dir([p[0] for p in points], [p[1] for p in points])
    d = vec(yaw, pitch)
    flat = np.linalg.norm(d[:, :2], axis=1)
    v = EYE + d * (dist / flat)[:, None]
    obj = P.mesh_from_arrays(name, v, [list(range(len(v)))], coll)
    return proxy(obj, mask)


def proxies(coll, ships, glow):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=420)
    mesh = bpy.data.meshes.new("sky_proxy")
    bm.to_mesh(mesh)
    bm.free()
    sky = bpy.data.objects.new("sky_proxy", mesh)
    sky.location = EYE
    coll.objects.link(sky)
    proxy(sky, (0, 1, 0))
    water = P.mesh_from_arrays("water_proxy", [(-400, -400, 0), (400, -400, 0), (400, 400, 0), (-400, 400, 0)], [(0, 1, 2, 3)], coll)
    proxy(water, (1, 0, 0))
    none = (0, 0, 0)
    outline("ship_left", [(-30, 345), (20, 350), (60, 380), (120, 470), (215, 640), (110, 735), (112, 800), (60, 850), (-30, 860)], 20, none, coll)
    outline("ship_mid", [(250, 590), (300, 575), (335, 680), (332, 765), (262, 765)], 46, none, coll)
    outline("skiff", [(218, 775), (260, 762), (306, 782), (296, 806), (235, 806)], 24, none, coll)
    outline("buoy", [(258, 850), (300, 828), (340, 860), (332, 905), (300, 940), (290, 985), (245, 975), (248, 912)], 10, none, coll)
    outline("colliers", [(846, 760), (870, 690), (970, 640), (1060, 540), (1130, 300), (1160, 300), (1200, 470), (1290, 340), (1320, 350), (1370, 420), (1430, 180), (1530, 180), (1530, 880), (1330, 880), (1060, 830), (850, 800)], 27, none, coll)
    outline("raft", [(912, 960), (960, 938), (1060, 905), (1140, 935), (1150, 965), (1010, 1000), (930, 990)], 7.2, none, coll)
    for i, (a, b, h) in enumerate(ships):
        up = np.array([0, 0, h])
        proxy(P.mesh_from_arrays(f"ship_proxy_{i}", [tuple(a), tuple(b), tuple(b + up), tuple(a + up)], [(0, 1, 2, 3)], coll), none)
    # the fires: discs just in front
    fires = [(sheet_dir(1170, 765), 1.5), (sheet_dir(1326, 722), 2.4), (sheet_dir(1446, 735), 1.9), (sheet_dir(1008, 722), 0.9)]
    fires = [(float(y), float(p), r) for (y, p), r in fires] + glow
    for i, (yaw, pitch, r) in enumerate(fires):
        a = np.linspace(0, 2 * np.pi, 20, endpoint=False)
        c = vec(np.array(yaw), np.array(pitch))
        right, up = frame(np.array([yaw]), np.array([pitch]))
        v = EYE + (c + (right * np.cos(a)[:, None] + up * np.sin(a)[:, None]) * math.tan(r * RAD)) * 21
        proxy(P.mesh_from_arrays(f"fire_proxy_{i}", v, [list(range(20))], coll), (0, 0, 1))


# ─── Build ────────────────────────────────────────────────────────────────────

def front(layer):
    """The painting, laid again."""
    d = np.load(os.path.join(C.RENDERS_DIR, "moonlight", "strokes.npz"))
    k = W / float(d["size"][0])
    x, y, a, L, w = d["x"] * k, d["y"] * k, d["angle"], d["length"] * k, d["width"] * k
    n = len(x)
    # ragged at its rim, so it runs into what is round it
    rim = np.minimum.reduce([x, W - x, y * 1.2, (H - y) * 1.2])
    keep = rng.random(n) < P.smoothstep(-10, 150, rim) ** 0.8
    x, y, a, L, w, n = x[keep], y[keep], a[keep], L[keep], w[keep], int(keep.sum())
    t = np.linspace(-0.5, 0.5, K)[None]
    px, py = x[:, None] + np.cos(a)[:, None] * L[:, None] * t, y[:, None] + np.sin(a)[:, None] * L[:, None] * t
    yaw, pitch = sheet_dir(px, py)
    _, pc = sheet_dir(x, y)
    # opened a little, as in the other rooms
    c = d["colour"][keep] ** 0.94
    lum = (c @ np.array([0.3, 0.59, 0.11]))[:, None]
    c = np.clip(lum + (c - lum) * 1.1, 0, 1)
    body = np.where(d["layer"][keep] < 2, 0.96, 0.9)
    layer.lay(vec(yaw, pitch), w / SCALE * np.cos(pc * RAD), c, body)
    # the moon itself: a last touch of thick, pale paint
    m = 46
    r, t = np.sqrt(rng.random(m)) * 1.08, rng.uniform(0, 2 * math.pi, m)
    my, mp = MOON[0] + np.cos(t) * r, MOON[1] + np.sin(t) * r * 0.95
    layer.lay(arcs(my, mp, np.degrees(t) + 90, rng.uniform(0.4, 0.8, m), rng.normal(0, 0.8, m)), 0.34, np.clip(np.array([1.0, 0.985, 0.92]) + rng.normal(0, 0.012, (m, 1)), 0, 1), 0.97)


def build(preview=True):
    reseed(1835)
    EYE[:] = (0.0, 0.0, HEIGHT)
    scene = C.clear_scene()
    P.setup_render(scene, samples=24 if preview else 64)
    scene.cycles.transparent_max_bounces = 64
    coll = C.collection("Paint")
    col = Colours()

    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=32, radius=FAR * 1.05)
    mesh = bpy.data.meshes.new("prime")
    bm.to_mesh(mesh)
    bm.free()
    prime = bpy.data.objects.new("prime", mesh)
    prime.location = EYE
    coll.objects.link(prime)
    C.assign(prime, C.emission_material("prime", tuple(srgb_to_linear(col.pal.pick("grey", 400).mean(0) * 0.7)), 1.0))
    for kind in ("mask", "depth"):
        prime[f"skip_{kind}"] = True

    ships, glow = [], []
    layer = Ordered("paint", FAR, FAR * 0.86)
    surround(col, layer)
    beyond(col, layer, ships, glow)
    front(layer)
    layer.build(coll)
    rowboat(col, coll)
    proxies(coll, ships, glow)
    cam = C.pano_camera(EYE[2])
    cam.location = EYE
    C.set_resolution(1024 if preview else 8192)
    return scene


if __name__ == "__main__":
    build()
