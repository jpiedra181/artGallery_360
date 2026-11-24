"""Room III — Stillness. Inside Monet's "Water Lily Pond" (1900).

A world made of brush strokes. Nothing here is modelled and then filtered to
look painted: every mark is a ribbon of paint hung in space, facing the
viewer, and its colour is taken from the part of the painting it stands for
(blender/sources/monet-water-lily-pond.jpg). What the painting leaves out it
leaves out here too: there is no sky, only dark foliage closing overhead and
its reflection closing underneath.

The viewer stands on a small landing at the edge of the pond. The footbridge
crosses close ahead; pads crowd the water in front of it and a band of
blossom lies beyond; reeds lean in from the left bank; yellow-green streamers
of willow hang through the dark. Lit by nothing (emission only).

Mask pass
  R  open water (ripples)
  G  what the wind moves: leaves wholly, reeds and flowers less
  B  what floats: pads and flowers
"""

import math

import bpy
import numpy as np

import common as C
import printmaking as P
from strokes import EYE, K, RAD, Layer, Palette, along, fbm, frame, load_painting, mood, on_dome, reseed, rng, scatter, srgb_to_linear, toward, vnoise

# the eye is 1.75 m over the water, which is at z = 0
BANK = 0.16
BRIDGE_X, BRIDGE_Y, BRIDGE_HALF = 2.3, 8.0, 6.9


# ─── The palette: regions of the painting ─────────────────────────────────────

yellowgreen = lambda h, s, v: (h > 50) & (h < 105) & (s > 0.42) & (v > 0.36)
russet = lambda h, s, v: ((h < 32) | (h > 340)) & (s > 0.18)
teal = lambda h, s, v: (h > 125) & (h < 230) & (s > 0.14)
green = lambda h, s, v: (h > 75) & (h < 175) & (s > 0.16)


def palette():
    return Palette(load_painting("monet-water-lily-pond.jpg"), {
        "shade": (0.02, 0.0, 0.6, 0.3),
        "russet": (0.2, 0.0, 1, 0.45, russet),
        "willow": (0.36, 0.02, 0.58, 0.5, yellowgreen),
        "willow_dark": (0.36, 0.02, 0.58, 0.5, green),
        "light_tree": (0.6, 0.0, 1, 0.17, lambda h, s, v: v > 0.4),
        "lilac": (0.0, 0.0, 0.1, 0.22, lambda h, s, v: v > 0.45),
        "bridge": (0.28, 0.18, 1, 0.42, lambda h, s, v: (h > 120) & (h < 290) & (v < 0.55)),
        "bridge_light": (0.28, 0.17, 1, 0.34, lambda h, s, v: (v > 0.52) & (((h > 170) & (h < 320)) | (s < 0.2))),
        "bridge_under": (0.28, 0.32, 1, 0.42, russet),
        "reeds": (0.0, 0.2, 0.28, 0.62, green),
        "reeds_light": (0.0, 0.2, 0.28, 0.75, lambda h, s, v: v > 0.5),
        "reeds_dark": (0.02, 0.4, 0.3, 0.68),
        "grass": (0.66, 0.38, 1, 0.56, green),
        "grass_light": (0.6, 0.36, 1, 0.52, lambda h, s, v: v > 0.46),
        "band": (0.3, 0.5, 1, 0.64),
        "band_light": (0.3, 0.5, 1, 0.64, lambda h, s, v: v > 0.6),
        "band_pink": (0.3, 0.48, 1, 0.64, lambda h, s, v: ((h < 30) | (h > 310)) & (s > 0.12) & (v > 0.48)),
        "band_green": (0.3, 0.5, 1, 0.64, green),
        "water": (0.3, 0.62, 0.95, 0.68, russet),
        "water_dark": (0.5, 0.82, 0.95, 0.98, lambda h, s, v: v < 0.5),
        "water_gold": (0.3, 0.62, 0.7, 0.9, yellowgreen),
        "pads_far": (0.15, 0.67, 1, 0.78, lambda h, s, v: (h > 150) & (h < 300)),
        "pads": (0.0, 0.76, 1, 1.0, teal),
        "pads_light": (0.0, 0.76, 1, 1.0, lambda h, s, v: (h > 125) & (h < 230) & (v > 0.55)),
        "pads_green": (0.0, 0.7, 1, 1.0, green),
        "bloom": (0.1, 0.74, 1, 1.0, lambda h, s, v: (v > 0.6) & ((h > 220) | (h < 30) | (s < 0.15))),
        "gold": (0.0, 0.5, 0.2, 0.75, yellowgreen),
    })


# ─── Where things are ─────────────────────────────────────────────────────────

def ell(x, y, cx, cy, rx, ry):
    return np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) - 1


def pond(x, y):
    """Negative on the water."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    d = np.minimum(ell(x, y, 2.0, 5.2, 10.5, 4.9), ell(x, y, 3.4, 11.5, 11.0, 6.0))
    # the left bank leans in, as in the painting
    d = np.maximum(d, -ell(x, y, -6.6, 4.6, 4.3, 3.4) * 0.8)
    return d


def reflect(paths):
    p = paths.copy()
    p[..., 2] = -p[..., 2]
    return p


# ─── The foliage that closes the picture ──────────────────────────────────────

def light_tree(yaw, pitch):
    """Where the pale flowering tree of the painting's upper right stands, and others like it round about."""
    s = np.zeros(np.shape(yaw))
    for cy, cp, ry, rp, k in ((33, 33, 23, 13, 1.0), (-58, 36, 17, 10, 0.55), (112, 30, 26, 15, 0.8), (-135, 27, 24, 13, 0.75), (178, 38, 18, 12, 0.6)):
        dy = (yaw - cy + 180) % 360 - 180
        s = np.maximum(s, k * np.exp(-((dy / ry) ** 2 + ((pitch - cp) / rp) ** 2)))
    return s


def depth_of(yaw, pitch):
    """Light and dark in big masses: darkest straight ahead behind the bridge and overhead."""
    big = mood(np.asarray(yaw) * 0.6, np.asarray(pitch) * 0.6, 201)
    up = P.smoothstep(38, 80, np.asarray(pitch))
    return (0.66 + 0.46 * big) * (1 - 0.34 * up)


def foliage(pal, layers):
    dome, mirror = layers["foliage"], layers["mirror"]

    def lay(yaw, pitch, dist, angle, length, width, colours, bend, lift=0.0, mirrored=True, dim=0.8, body=0.75):
        paths, w = on_dome(yaw, pitch, dist, angle, length, width, bend)
        dome.add(paths, w, colours, lift, body)
        if mirrored:
            # what stands above the water stands in it too: darker, warmer, and drawn downwards
            low = (pitch > -2) & (rng.random(len(yaw)) < 0.85)
            r = reflect(paths[low])
            mid = r.mean(1, keepdims=True)
            r = mid + (r - mid) * np.array([0.75, 0.75, 1.5])
            warm = pal.pick("water", int(low.sum()), 0.3)
            mirror.add(r, w[low] * 1.25, colours[low] * dim * 0.5 + warm * 0.45, lift, body * 0.85)

    # underpainting: russet and umber, broad and upright
    for density, (lw, ll), dist, val in ((26000, (1.7, 6.5), 34, 0.3), (30000, (1.2, 5.0), 31, 0.42)):
        yaw, pitch = scatter(density, (-180, 180), (-4, 90))
        m = mood(yaw, pitch, 5)
        col = np.where((m > 0.52)[:, None], pal.pick("shade", density, val * m * 1.4), pal.pick("russet", density, val * (1 - m)))
        col = col * depth_of(yaw, pitch)[:, None]
        angle = 90 + rng.normal(0, 13 + 60 * P.smoothstep(50, 78, pitch), density)
        lay(yaw, pitch, np.full(density, float(dist)), angle, ll * rng.uniform(0.6, 1.4, density), lw * rng.uniform(0.7, 1.3, density), col, rng.normal(0, 0.25, density))

    # body: broken greens, violets and reds over it, finer
    n = 74000
    yaw, pitch = scatter(n, (-180, 180), (-3, 88))
    m, g = mood(yaw, pitch, 17), mood(yaw, pitch, 31)
    # each passage has its own colour; the others only break it
    own = np.where((m > 0.6)[:, None], pal.mixed({"willow_dark": 1, "reeds_dark": 3, "shade": 2}, n), np.where((m < 0.38)[:, None], pal.mixed({"russet": 4, "shade": 2}, n), pal.pick("shade", n)))
    other = pal.mixed({"willow_dark": 2, "russet": 2, "bridge": 1, "lilac": 0.12, "grass": 0.6}, n)
    col = np.where((rng.random(n) < 0.72)[:, None], own, other)
    col = col * (0.62 + 0.5 * g)[:, None] * depth_of(yaw, pitch)[:, None]
    dist = 25 + 5 * m
    angle = 90 + rng.normal(0, 16 + 55 * P.smoothstep(50, 78, pitch), n) + (m - 0.5) * 40
    lay(yaw, pitch, dist, angle, rng.uniform(1.4, 4.0, n), rng.uniform(0.4, 1.0, n), col, rng.normal(0, 0.4, n), body=0.55)

    # hanging threads: the upright streaks that make the dark read as a curtain of willow
    n = 11000
    yaw, pitch = scatter(n, (-180, 180), (2, 66))
    curtain = mood(yaw * 1.0, pitch * 0.2, 47)
    keep = curtain > 0.42
    yaw, pitch = yaw[keep], pitch[keep]
    n = len(yaw)
    col = pal.mixed({"willow_dark": 3, "reeds_dark": 1.5, "shade": 2.5, "lilac": 0.25, "gold": 0.35}, n) * rng.uniform(0.7, 1.1, (n, 1)) * depth_of(yaw, pitch)[:, None]
    lay(yaw, pitch, rng.uniform(19, 23, n), 90 + rng.normal(0, 5, n), rng.uniform(2.5, 6.5, n), rng.uniform(0.2, 0.5, n), col, rng.normal(0, 0.12, n), body=0.5)

    # the pale trees: curling dabs of cream, rose and grey-green
    n = 74000
    yaw, pitch = scatter(n, (-180, 180), (8, 62))
    s = light_tree(yaw, pitch) * (0.55 + 0.9 * mood(yaw * 2.4, pitch * 2.4, 71))
    keep = rng.random(n) < np.clip((s - 0.3) * 1.25, 0, 0.85)
    yaw, pitch = yaw[keep], pitch[keep]
    n = len(yaw)
    clump = mood(yaw * 5, pitch * 5, 73)
    col = np.where((clump > 0.5)[:, None], pal.pick("light_tree", n, 0.25 + 0.65 * clump), pal.mixed({"grass": 2, "shade": 1.4, "willow_dark": 1.2}, n))
    lay(yaw, pitch, 17 + 3 * rng.random(n), rng.uniform(0, 180, n), rng.uniform(0.6, 1.7, n), rng.uniform(0.28, 0.7, n), col, rng.normal(0, 1.3, n), body=0.75)

    # willow streamers: the yellow-green falls through the middle of the picture, and round about
    groups = [(-4.5, 4.6, 30, 0.95), (3.4, 2.2, 22, 1.0), (-13, 3.0, 9, 0.5), (-74, 7, 34, 0.7), (69, 5, 24, 0.7), (126, 7, 30, 0.65), (-120, 7, 34, 0.7), (163, 5, 20, 0.5), (-158, 5, 24, 0.55), (98, 4, 10, 0.5)]
    for cy, spread, threads, strength in groups:
        for _ in range(threads):
            y0 = cy + rng.normal(0, spread * 0.5)
            top, low = rng.uniform(26, 62), rng.uniform(-1.5, 9)
            m = max(2, int((top - low) / 2.6))
            pitch = np.linspace(top, low, m) + rng.normal(0, 0.7, m)
            keep = rng.random(m) < 0.5
            pitch = pitch[keep]
            m = len(pitch)
            if not m:
                continue
            yaw = y0 + rng.normal(0, 0.35, m) + np.linspace(0, rng.normal(0, 1.2), m)
            bright = np.clip(strength * (0.95 - np.abs(pitch - 20) / 70) + rng.normal(0, 0.2, m), 0, 1)
            pick = rng.random(m) < 0.6 * strength
            col = np.where(pick[:, None], pal.pick("willow", m, bright), pal.mixed({"willow_dark": 3, "russet": 1, "gold": 1}, m))
            lay(yaw, pitch, np.full(m, rng.uniform(14.5, 17.5)), 90 + rng.normal(0, 4, m), rng.uniform(1.8, 4.4, m), rng.uniform(0.3, 0.66, m), col, rng.normal(0, 0.14, m), dim=1.2, body=0.8)

    # the few places where light comes through: lilac, low on the left and here and there above
    n = 340
    spots = np.array([(-45, 30), (-47, 22), (-25, 26), (-23, 22), (64, 40), (-95, 44), (140, 46), (-170, 48), (88, 24)])
    s = spots[rng.integers(0, len(spots), n)]
    yaw, pitch = s[:, 0] + rng.normal(0, 1.9, n), s[:, 1] + rng.normal(0, 4.0, n)
    lay(yaw, pitch, np.full(n, 16.5), 90 + rng.normal(0, 8, n), rng.uniform(1.2, 3.4, n), rng.uniform(0.35, 0.7, n), pal.pick("lilac", n), rng.normal(0, 0.2, n))


# ─── The bridge ───────────────────────────────────────────────────────────────

def deck(x):
    return 1.0 + 1.55 * (1 - ((x - BRIDGE_X) / BRIDGE_HALF) ** 2)


def bridge(pal, layers):
    out, mirror = layers["bridge"], layers["mirror"]

    def lay(paths, widths, colours, lift=0.0, reflected=0.8):
        out.add(paths, widths, colours, lift)
        keep = rng.random(len(paths)) < reflected
        r = reflect(paths[keep])
        r[..., 2] += rng.normal(0, 0.05, len(r))[:, None]
        mirror.add(r, np.broadcast_to(widths, len(paths))[keep], colours[keep] * 0.6 + pal.pick("water_dark", int(keep.sum())) * 0.28, 0.02)

    def beam(y, dz, width, count, names, value, lift=0.0, length=(0.7, 1.6), jitter=0.035):
        """Strokes running along the arch."""
        x = rng.uniform(BRIDGE_X - BRIDGE_HALF, BRIDGE_X + BRIDGE_HALF, count)
        L = rng.uniform(*length, count)
        t = np.linspace(-0.5, 0.5, K)
        px = np.clip(x[:, None] + t[None] * L[:, None], BRIDGE_X - BRIDGE_HALF, BRIDGE_X + BRIDGE_HALF)
        pz = deck(px) + dz + rng.normal(0, jitter, count)[:, None]
        paths = np.stack([px, np.full_like(px, y) + rng.normal(0, 0.02, count)[:, None], pz], -1)
        w = width * rng.uniform(0.6, 1.15, count)
        col = pal.mixed(names, count) * (value * rng.uniform(0.85, 1.15, (count, 1)))
        lay(paths, w, np.clip(col, 0, 1), lift)

    for y, far in ((BRIDGE_Y + 0.95, True), (BRIDGE_Y - 0.95, False)):
        k = 0.72 if far else 1.0
        # the body of the arch, dark green over red, then blue
        beam(y, -0.16, 0.2, 260, {"bridge_under": 2, "bridge": 2}, 0.8 * k, 0.0)
        beam(y, -0.08, 0.15, 300, {"bridge": 3, "reeds_dark": 1.5, "grass": 0.4}, 0.8 * k, 0.004)
        beam(y, -0.26, 0.09, 130, {"bridge_under": 3, "russet": 1}, 1.05 * k, 0.006)
        # rails: each a few strokes thick, blue-green with a violet side and a lit edge
        for dz, w in ((0.62, 0.13), (1.2, 0.2)):
            beam(y, dz, w * 1.2, 240, {"bridge": 4, "bridge_under": 1.2, "shade": 1}, 0.62 * k, 0.004)
            beam(y, dz + 0.012, w * 0.6, 170, {"bridge": 5, "bridge_under": 0.8}, 0.84 * k, 0.009)
            if not far:
                beam(y, dz + w * 0.46, w * 0.26, 74 if dz > 1 else 30, {"bridge_light": 3, "lilac": 1}, 1.0, 0.013, (0.25, 0.9), 0.012)
        # posts
        for x in np.arange(BRIDGE_X - BRIDGE_HALF + 0.5, BRIDGE_X + BRIDGE_HALF, 2.45):
            n = 15
            z0, z1 = deck(x) - 0.3, deck(x) + 1.26
            c = np.stack([x + rng.normal(0, 0.04, n), np.full(n, y - 0.02), rng.uniform(z0 + 0.2, z1 - 0.2, n)], -1)
            p = along(c, np.tile([0.0, 0, 1], (n, 1)), rng.uniform(0.4, 0.8, n), rng.normal(0, 0.1, n))
            lay(p, rng.uniform(0.09, 0.16, n), pal.mixed({"bridge": 4, "bridge_under": 1.4, "shade": 1}, n) * 0.74 * k, 0.012)
    # planks seen from below and along
    n = 520
    x = rng.uniform(BRIDGE_X - BRIDGE_HALF, BRIDGE_X + BRIDGE_HALF, n)
    y0 = rng.uniform(BRIDGE_Y - 0.9, BRIDGE_Y + 0.9, n)
    c = np.stack([x, y0, deck(x) - 0.05], -1)
    lay(along(c, np.tile([0.0, 1, 0.02], (n, 1)), rng.uniform(0.5, 1.0, n)), 0.12, pal.mixed({"bridge_under": 2, "bridge": 1, "russet": 2}, n) * 0.75, 0.0)
    # piers
    for x in (BRIDGE_X - 4.6, BRIDGE_X + 4.2):
        for y in (BRIDGE_Y - 0.85, BRIDGE_Y + 0.85):
            n = 16
            c = np.stack([x + rng.normal(0, 0.04, n), np.full(n, y), rng.uniform(0.1, deck(x) - 0.4, n)], -1)
            lay(along(c, np.tile([0.0, 0, 1], (n, 1)), rng.uniform(0.4, 0.9, n)), 0.13, pal.mixed({"bridge": 3, "russet": 2}, n) * 0.7, 0.004)


# ─── The water ────────────────────────────────────────────────────────────────

def on_water(n, yaw=(-100, 100), pitch=(-82, -5.2), power=1.0):
    """Points of the pond, evenly over the view, with their distance along the water."""
    y, p = scatter(n, yaw, pitch)
    r = EYE[2] / np.tan(-p * RAD)
    x, yy = np.sin(y * RAD) * r, np.cos(y * RAD) * r
    keep = pond(x, yy) < -0.015
    return x[keep], yy[keep], r[keep], p[keep]


def flat_strokes(x, y, r, size, aspect, wander=0.16):
    """Marks lying on the water, across the view: paths and widths, foreshortened."""
    n = len(x)
    c = np.stack([x, y, np.full(n, 0.004)], -1)
    across = np.stack([y, -x, np.zeros(n)], -1) / np.maximum(np.hypot(x, y), 1e-6)[:, None]
    away = np.stack([x, y, np.zeros(n)], -1) / np.maximum(np.hypot(x, y), 1e-6)[:, None]
    side = P.smoothstep(34, 85, np.abs(np.degrees(np.arctan2(x, y))))[:, None]
    level = np.array([1.0, 0, 0]) * (1 - side) + across * side * np.sign(across[:, :1] + 1e-9)
    d = level + away * rng.normal(0, wander, n)[:, None]
    dist = np.hypot(r, EYE[2])
    w = np.maximum(size * aspect * (EYE[2] / dist) * 1.25, 0.0042 * dist)
    return along(c, d, size, rng.normal(0, 0.22, n)), w


def cover(x, y):
    """How crowded with pads the water is, 0..1: drifts lying across the view, open water between them."""
    drift = fbm(np.stack([x * 0.16 + 3.1, y * 0.62], -1), 3, 7)
    c = np.clip((drift - 0.5) * 4.2 + 0.56, 0, 1)
    # the open, russet water in front of and under the bridge, and a dark pool by the landing on the right
    c *= 1 - 0.96 * np.exp(-(((y - 7.9 + 0.5 * np.sin(x * 0.9) + 0.3 * np.sin(x * 2.3 + 1)) / 0.6) ** 2))
    c *= 1 - 0.97 * np.exp(-(((x - 1.5) / 1.35) ** 2 + ((y - 3.0) / 0.5) ** 2))
    c *= 1 - 0.9 * np.exp(-(((x + 0.1) / 1.1) ** 2 + ((y - 5.1) / 0.45) ** 2))
    c *= 1 - 0.5 * np.exp(-(((x + 2.6) / 0.8) ** 2 + ((y - 3.4) / 0.4) ** 2))
    # ragged edges
    c = c + 0.5 * (fbm(np.stack([x * 1.1 + 9, y * 3.4], -1), 2, 13) - 0.5)
    # beyond the bridge the pads close up
    far = P.smoothstep(8.4, 9.4, y)
    return c * (1 - far) + far * np.clip(0.7 + 0.5 * drift, 0, 1)


def lilies(pal, layers):
    glaze, pads, blooms = layers["glaze"], layers["pads"], layers["blooms"]

    # open water: thin russet and green drawn across, broken so the reflections show
    for count, names, long, thick, body in ((26000, {"water": 5, "water_dark": 1.5, "russet": 1}, (0.05, 0.15), 0.02, 0.5), (9000, {"water": 4, "band_pink": 0.6, "pads_far": 0.8, "lilac": 0.2}, (0.03, 0.09), 0.009, 0.45)):
        x, y, r, _ = on_water(count)
        n = len(x)
        # the reflections keep to the pools where the willow falls; elsewhere the surface is closed
        willow = np.exp(-(((np.degrees(np.arctan2(x, y)) + 1) / 7.5) ** 2))
        keep = rng.random(n) < 0.62 - 0.46 * willow
        x, y, r = x[keep], y[keep], r[keep]
        n = len(x)
        dist = np.hypot(r, 1.75)
        p, _ = flat_strokes(x, y, r, dist * rng.uniform(*long, n), 0.2, 0.04)
        light = 0.82 + 0.3 * np.exp(-(((y - 7.6) / 1.0) ** 2))
        glaze.add(p, dist * thick * rng.uniform(0.5, 1.2, n) * np.clip(1.75 / dist * 2.2, 0.35, 1.2), pal.mixed(names, n) * (light * rng.uniform(0.85, 1.08, n))[:, None], 0.0, body)

    # pads: first their shadows, then the turquoise and violet dabs, then the lights
    for kind, count, scale in (("under", 90000, 1.12), ("body", 190000, 1.0), ("light", 80000, 0.72)):
        x, y, r, pitch = on_water(count)
        c = cover(x, y)
        n = len(x)
        want = {"under": 0.5, "body": 0.62, "light": 0.36}[kind]
        # fewer towards us: single marks with the dark water between them
        close = 1 - 0.34 * P.smoothstep(4.4, 1.6, y) * (kind != "under")
        keep = rng.random(n) < np.clip((c - 0.34) * 1.5, 0, 1) * want * close
        x, y, r, c = x[keep], y[keep], r[keep], c[keep]
        n = len(x)
        dist = np.hypot(r, 1.75)
        far = P.smoothstep(8.0, 9.6, y)
        # the same hand near and far: marks shrink, but never below what the brush can do
        size = np.maximum(rng.uniform(0.1, 0.34, n) * scale * (1 + 0.5 * far), dist * rng.uniform(0.01, 0.022, n))
        # at our feet the brush is no bigger than it is further off
        size = np.minimum(size, dist * rng.uniform(0.028, 0.062, n))
        p, w = flat_strokes(x, y, r, size, rng.uniform(0.26, 0.54, n) * (1 - 0.35 * far))
        mid = P.smoothstep(3.2, 4.8, y) * (1 - far)
        near_c = {"under": {"water_dark": 2, "pads_green": 3, "reeds_dark": 1}, "body": {"pads": 6, "pads_green": 1.2, "pads_light": 1.4, "water_dark": 0.8, "pads_far": 1}, "light": {"pads_light": 5, "bloom": 0.35}}[kind]
        mid_c = {"under": {"water_dark": 3, "bridge": 2}, "body": {"pads_far": 8, "pads": 1.2, "lilac": 1.2, "pads_green": 1, "russet": 0.6}, "light": {"pads_far": 2, "pads_light": 2, "lilac": 1}}[kind]
        far_c = {"under": {"band_green": 3, "band": 2, "russet": 1}, "body": {"band": 2.5, "band_green": 2, "band_light": 4, "band_pink": 1.4}, "light": {"band_light": 5, "band_pink": 3}}[kind]
        roll = rng.random(n)
        pick = np.where(roll < far, 2, np.where(roll < far + mid * 0.8, 1, 0))
        col = np.empty((n, 3))
        for i, weights in enumerate((near_c, mid_c, far_c)):
            m = pick == i
            col[m] = pal.mixed(weights, int(m.sum()))
        col *= rng.uniform(0.82, 1.05, (n, 1)) * (0.74 if kind == "under" else 1.0)
        col[far > 0.5] *= 1.28
        pads.add(p, w, np.clip(col, 0, 1), {"under": 0.0, "body": 0.008, "light": 0.016}[kind], {"under": 0.6, "body": 0.78, "light": 0.85}[kind])

    # single strokes of young leaf: the light green notes of the painting
    x, y, r, _ = on_water(2600)
    keep = (cover(x, y) > 0.4) & (rng.random(len(x)) < 0.16)
    x, y, r = x[keep], y[keep], r[keep]
    n = len(x)
    p, w = flat_strokes(x, y, r, np.maximum(rng.uniform(0.14, 0.26, n), np.hypot(r, 1.75) * 0.018), 0.45)
    pads.add(p, w, pal.mixed({"gold": 2, "grass_light": 1, "willow": 1}, n), 0.018)

    # water lilies: a loose rosette of petals, lit from above
    x, y, r, _ = on_water(1500, yaw=(-75, 80))
    c = cover(x, y)
    keep = (c > 0.5) & (rng.random(len(x)) < np.where(y > 8.5, 0.6, 0.2))
    x, y, r = x[keep], y[keep], r[keep]
    for bx, by, br in zip(x, y, r):
        dist = math.hypot(br, 1.75)
        far = by > 8.5
        s = min(max(rng.uniform(0.07, 0.12), dist * (0.011 if far else 0.014)), dist * 0.04)
        m = 5 if far else int(rng.integers(9, 15))
        a = rng.uniform(0, math.pi * 2, m)
        rad = s * rng.uniform(0.1, 0.75, m)
        c3 = np.stack([bx + np.cos(a) * rad, by + np.sin(a) * rad * 0.8, 0.03 + rng.uniform(0.0, 0.75, m) * s], -1)
        d = np.stack([np.cos(a), np.sin(a) * 0.6, 0.3 + 0.5 * rng.random(m)], -1)
        col = pal.mixed({"band_pink": 3, "band_light": 2} if far else ({"bloom": 5, "lilac": 1} if rng.random() < 0.62 else {"band_pink": 3, "bloom": 2}), m)
        blooms.add(along(c3, d, s * rng.uniform(0.6, 1.0, m), rng.normal(0, 0.7, m)), s * rng.uniform(0.34, 0.6, m), col, 0.02, 0.95)
        if not far:
            # its heart, and its reflection
            blooms.add(along(c3[:2] + [0, 0, s * 0.2], d[:2], np.full(2, s * 0.35)), s * 0.22, pal.pick("gold", 2), 0.024)
            k = 3
            cr = np.stack([bx + rng.normal(0, s * 0.3, k), by - s * 0.55 + rng.normal(0, s * 0.1, k), np.full(k, 0.006)], -1)
            pads.add(along(cr, np.tile([1.0, 0, 0], (k, 1)), np.full(k, s * 0.9)), s * 0.12, pal.pick("bloom", k) * 0.7, 0.02)


# ─── Banks, reeds and flowers ─────────────────────────────────────────────────

def blades(pal, layer, mirror, x, y, height, names, hook=(0.2, 1.1), width=0.02, lean_to=None, lift=0.0, value=1.0, base=None):
    """Blades that rise and hook over."""
    n = len(x)
    if not n:
        return
    a = rng.uniform(0, math.pi * 2, n) if lean_to is None else lean_to + rng.normal(0, 0.6, n)
    h = height * rng.uniform(0.6, 1.25, n)
    bend = rng.uniform(*hook, n)
    t = np.linspace(0, 1, K)[None, :]
    # a curve from the root, through a knee, to a tip that falls the more it bends
    b = bend[:, None]
    up = 2 * t * (1 - t) * (0.95 + 0.1 * b) + t * t * (1.0 - 0.62 * np.minimum(b, 1.6))
    out = 2 * t * (1 - t) * 0.16 * b + t * t * 0.55 * b
    z0 = BANK - 0.08 if base is None else base
    p = np.stack([x[:, None] + np.cos(a)[:, None] * out * h[:, None], y[:, None] + np.sin(a)[:, None] * out * h[:, None], np.broadcast_to(z0, n)[:, None] + up * h[:, None]], -1)
    dist = np.hypot(x, y)
    w = np.maximum(width * rng.uniform(0.7, 1.4, n), dist * 0.0042)
    col = np.clip(pal.mixed(names, n) * value * rng.uniform(0.85, 1.12, (n, 1)), 0, 1)
    layer.add(p, w, col, lift)
    near = (pond(x, y) < 0.12) & (rng.random(n) < 0.5)
    mirror.add(reflect(p[near]), w[near], col[near] * 0.55 + pal.pick("water_dark", int(near.sum())) * 0.25)


def banks(pal, layers):
    ground, reeds, mirror = layers["ground"], layers["reeds"], layers["mirror"]

    # the ground: short marks lying on it, dark near the water
    for density, value, size in ((26000, 0.8, 1.0), (34000, 1.0, 0.7)):
        yaw, pitch = scatter(density, (-180, 180), (-62, -2.6))
        r = (EYE[2] - BANK) / np.tan(-pitch * RAD)
        x, y = np.sin(yaw * RAD) * r, np.cos(yaw * RAD) * r
        keep = (pond(x, y) > 0.0) & ~((np.abs(x) < 1.15) & (y > -1.7) & (y < 0.85)) & (r < 30)
        x, y, r = x[keep], y[keep], r[keep]
        n = len(x)
        dist = np.hypot(r, 1.6)
        c = np.stack([x, y, np.full(n, BANK)], -1)
        across = np.stack([y, -x, np.zeros(n)], -1) / np.maximum(np.hypot(x, y), 1e-6)[:, None]
        d = across + rng.normal(0, 0.45, (n, 3)) * [1, 1, 0.6]
        path = np.abs(np.hypot(x * 1.05, y + 7.5) - 4.6) < 0.8  # a walk that goes round behind us
        tone = fbm(np.stack([x, y], -1) * 0.5, 3, 91)
        green = pal.mixed({"reeds_dark": 3, "grass": 3, "pads_green": 1.4, "russet": 1.2, "gold": 0.4}, n) * (0.55 + 0.85 * tone)[:, None]
        walk = pal.mixed({"water": 4, "band_light": 1.2, "lilac": 1.2, "russet": 1}, n) * (0.75 + 0.4 * tone)[:, None]
        col = np.where(path[:, None], walk, green) * value
        ground.add(along(c, d, dist * rng.uniform(0.03, 0.09, n) * size, rng.normal(0, 0.4, n)), dist * rng.uniform(0.009, 0.02, n) * size, np.clip(col, 0, 1), 0.0 if value < 1 else 0.004, 0.6)

    # reeds of the left bank, as in the painting: a dark mass, then pale blades hooking over it
    def ring(n, lo=-0.03, hi=0.2, box=(-26, 26, -9, 22)):
        x, y = rng.uniform(box[0], box[1], n * 6), rng.uniform(box[2], box[3], n * 6)
        d = pond(x, y)
        ok = (d > lo) & (d < hi) & (np.hypot(x, y) > 2.1)
        ok &= ~((np.abs(y - BRIDGE_Y) < 1.5) & (x > BRIDGE_X - BRIDGE_HALF - 0.4) & (x < BRIDGE_X + BRIDGE_HALF + 0.4))
        return x[ok][:n], y[ok][:n]

    left = (-8.2, -2.3, 1.7, 7.0)
    x, y = ring(5200, -0.02, 0.9, left)
    blades(pal, reeds, mirror, x, y, 1.5, {"reeds_dark": 5, "russet": 2, "bridge": 0.6}, (0.1, 0.9), 0.05, 0.2, 0.0, 0.72)
    # a rounded mass, higher away from the water: short hooked touches all through it
    for n, names, ht, w, lift, val in ((6500, {"reeds_dark": 4, "reeds": 1.5, "russet": 1}, 0.6, 0.045, 0.004, 0.85), (5200, {"reeds": 5, "grass": 1}, 0.55, 0.03, 0.008, 1.0), (3600, {"reeds_light": 4, "grass_light": 1, "gold": 0.5}, 0.5, 0.026, 0.012, 1.05)):
        x, y = ring(n, -0.02, 0.8, left)
        m = len(x)
        rise = np.clip(pond(x, y) * 3.6, 0.1, 1) * (2.1 + 0.6 * np.sin(x * 2.1 + y * 1.3)) * (0.55 + 0.45 * P.smoothstep(-2.4, -4.2, x))
        blades(pal, reeds, mirror, x, y, ht, names, (0.9, 1.9), w, rng.choice([0.1, 0.5, 2.6], m), lift, val, BANK + rise * np.sqrt(rng.random(m)))
    # the few large curling leaves at the near corner
    x, y = ring(150, -0.02, 0.5, (-4.2, -1.9, 1.2, 3.2))
    blades(pal, reeds, mirror, x, y, 1.0, {"gold": 3, "reeds_light": 2, "willow": 1}, (1.1, 1.9), 0.03, 0.5, 0.014)

    # the far right bank: a bright tuft of grass under the bridge
    for n, names, h, w, lift, val in ((4200, {"grass": 4, "reeds_dark": 2, "willow_dark": 1}, 1.2, 0.03, 0, 0.75), (3800, {"grass": 4, "gold": 0.8, "reeds": 1}, 1.4, 0.028, 0.004, 1.0), (1500, {"grass_light": 4, "gold": 0.6}, 1.5, 0.022, 0.008, 1.0)):
        x, y = ring(n, -0.05, 0.32, (4.6, 16, 9.8, 19))
        h = h * (0.7 + 1.0 * np.sin(x * 0.55 + 0.6) ** 2 + 0.3 * np.sin(x * 2.9) ** 2)
        blades(pal, reeds, mirror, x, y, h, names, (0.1, 0.8), w, None, lift, val)

    # everywhere else along the shore
    for n, names, h, lift, val in ((9000, {"reeds_dark": 3, "reeds": 2, "grass": 2, "russet": 1}, 1.0, 0, 0.8), (7500, {"reeds": 3, "grass": 3, "pads_green": 1}, 1.1, 0.004, 1.0), (2400, {"reeds_light": 3, "grass_light": 2, "gold": 1}, 1.2, 0.008, 1.0)):
        x, y = ring(n)
        # straight ahead the far shore stays dark under the bridge
        shade = 1 - 0.5 * np.exp(-((x / 4.2) ** 2)) * (y > 10)
        blades(pal, reeds, mirror, x, y, h * (0.45 + 0.45 * shade + 0.5 * vnoise(np.stack([x, y], -1) * 0.8, 66)), names, (0.15, 1.1), 0.024, None, lift, val * shade[:, None])

    # the garden behind us: beds of flowers in drifts, shrubs, and irises by the water
    beds = layers["flowers"]
    spots = []
    for _ in range(260):
        a, r = rng.uniform(0, math.pi * 2), rng.uniform(4.2, 15)
        x, y = math.cos(a) * r, math.sin(a) * r - 1.5
        if pond(np.array(x), np.array(y)) < 0.18 or abs(math.hypot(x * 1.05, y + 7.5) - 4.6) < 1.1 or math.hypot(x, y) < 3.4:
            continue
        spots.append((x, y, rng.uniform(0.55, 1.5)))
    mixes = [{"band_pink": 4, "band_light": 1}, {"lilac": 3, "pads_far": 2, "bloom": 2}, {"light_tree": 4, "grass_light": 1}, {"russet": 2, "band_pink": 2}, {"gold": 3, "light_tree": 2}, {"bloom": 4, "band_light": 2}]
    for x, y, s in spots:
        dist = math.hypot(x, y)
        tall = s * rng.uniform(0.7, 1.7) * (1 + 0.05 * dist)
        m = int(230 * s)
        u = rng.random(m) ** 0.5
        th = rng.uniform(0, math.pi * 2, m)
        ph = rng.random(m)
        c = np.stack([x + np.cos(th) * s * u * np.cos(ph), y + np.sin(th) * s * u * np.cos(ph), BANK + tall * np.sin(ph * 1.4) * rng.uniform(0.35, 1, m)], -1)
        shade = 0.5 + 0.6 * (c[:, 2] - BANK) / tall
        col = pal.mixed({"reeds_dark": 2, "grass": 3, "willow_dark": 1, "shade": 1.5}, m) * shade[:, None]
        d = rng.normal(0, 1, (m, 3)) + [0, 0, 1.1]
        beds.add(along(c, d, dist * rng.uniform(0.022, 0.05, m), rng.normal(0, 0.6, m)), dist * rng.uniform(0.008, 0.015, m), np.clip(col, 0, 1))
        if rng.random() < 0.72:
            f = int(m * rng.uniform(0.25, 0.7))
            top = np.argsort(-(c[:, 2] + rng.normal(0, tall * 0.25, m)))[:f]
            mixw = mixes[int(fbm(np.array([[x * 0.19 + 5, y * 0.19]]), 2, 55)[0] * 2.2 * len(mixes)) % len(mixes)]
            beds.add(along(c[top] + [0, 0, 0.03], rng.normal(0, 1, (f, 3)), dist * rng.uniform(0.012, 0.028, f), rng.normal(0, 0.9, f)), dist * rng.uniform(0.008, 0.015, f), pal.mixed(mixw, f) * rng.uniform(0.85, 1.1, (f, 1)), 0.02)
    x, y = ring(420, 0.0, 0.16, (-9, 12, -2, 6))
    n = len(x)
    c = np.stack([x, y, BANK + rng.uniform(0.55, 1.0, n)], -1)
    for _ in range(3):
        beds.add(along(c + rng.normal(0, 0.03, (n, 3)), rng.normal(0, 1, (n, 3)) + [0, 0, 0.6], rng.uniform(0.07, 0.13, n), rng.normal(0, 0.8, n)), 0.045, pal.mixed({"lilac": 2, "pads_far": 3, "bloom": 1}, n), 0.03)


def landing(pal, layers):
    out = layers["landing"]
    for i in range(8):
        x0 = -1.12 + i * 0.28
        for lift, count, width, names, value in ((0.0, 70, 0.13, {"russet": 3, "shade": 4}, 0.8), (0.004, 120, 0.055, {"russet": 3, "water": 2, "shade": 3}, 0.95), (0.008, 60, 0.03, {"water": 3, "shade": 1, "band_light": 0.5, "lilac": 0.8}, 0.95)):
            c = np.stack([x0 + 0.14 + rng.uniform(-0.1, 0.1, count), rng.uniform(-1.6, 0.75, count), np.full(count, BANK + 0.1)], -1)
            out.add(along(c, np.tile([0.0, 1, 0], (count, 1)) + rng.normal(0, 0.02, (count, 3)) * [1, 1, 0], rng.uniform(0.2, 0.55, count)), width * rng.uniform(0.6, 1.1, count), (pal.mixed(names, count) * 0.45 + np.array([0.44, 0.34, 0.31]) * 0.55) * value * rng.uniform(0.82, 1.12, (count, 1)) * (0.9 + 0.16 * (i % 2)), lift, 0.8)
        # the gap between two boards
        m = 7
        c = np.stack([np.full(m, x0), np.linspace(-1.5, 0.65, m), np.full(m, BANK + 0.1)], -1)
        out.add(along(c, np.tile([0.0, 1, 0], (m, 1)), np.full(m, 0.42)), 0.022, pal.pick("shade", m, 0.02) * 0.55, 0.012)


def underpaint(coll, pal):
    """The ground the strokes are laid on: no bare holes between them."""
    import bmesh

    def flat(name, colour):
        return C.emission_material(name, tuple(srgb_to_linear(np.asarray(colour))), 1.0)

    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=44)
    for f in bm.faces:
        f.material_index = 0 if f.calc_center_median().z > -0.5 else 1
    mesh = bpy.data.meshes.new("prime")
    bm.to_mesh(mesh)
    bm.free()
    dome = bpy.data.objects.new("prime", mesh)
    dome.location = EYE
    coll.objects.link(dome)
    mesh.materials.append(flat("prime_dark", pal.pick("shade", 400, 0.25).mean(0) * 0.8))
    mesh.materials.append(flat("prime_water", pal.pick("water", 400, 0.2).mean(0) * 0.62))
    C.set_mask(dome, (1, 0, 0))  # seen only through the water: above it the strokes are solid

    # the banks: a sheet with the pond cut out of it
    n = 420
    xs, ys = np.linspace(-32, 32, n), np.linspace(-32, 32, n)
    X, Y = np.meshgrid(xs, ys, indexing="ij")
    Z = np.full_like(X, BANK - 0.02)
    verts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1)
    faces = P.grid_faces(n, n)
    mid = verts[faces].mean(1)
    faces = faces[pond(mid[:, 0], mid[:, 1]) > 0.0]
    obj = P.mesh_from_arrays("bank", verts, faces, coll)
    C.assign(obj, flat("bank", pal.pick("reeds_dark", 400, 0.2).mean(0) * 0.75))
    boards = P.mesh_from_arrays("boards", [(-1.15, -1.65, BANK + 0.09), (1.15, -1.65, BANK + 0.09), (1.15, 0.8, BANK + 0.09), (-1.15, 0.8, BANK + 0.09)], [(0, 1, 2, 3)], coll)
    C.assign(boards, flat("boards", pal.pick("russet", 400, 0.2).mean(0) * 0.7))


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    reseed(1900)
    EYE[:] = (0.0, 0.0, 1.75)
    scene = C.clear_scene()
    P.setup_render(scene, samples=24 if preview else 64)
    scene.cycles.transparent_max_bounces = 48
    scene.world.use_nodes = True
    for node in scene.world.node_tree.nodes:
        if node.type == "BACKGROUND":
            node.inputs[0].default_value = (0.01, 0.01, 0.01, 1)
    coll = C.collection("Paint")
    pal = palette()
    underpaint(coll, pal)
    layers = {
        "mirror": Layer("mirror", "water"),
        "glaze": Layer("glaze", "water"),
        **{k: Layer(k) for k in ("foliage", "bridge", "pads", "blooms", "ground", "reeds", "flowers", "landing")},
    }
    foliage(pal, layers)
    bridge(pal, layers)
    lilies(pal, layers)
    banks(pal, layers)
    landing(pal, layers)
    moves = {"foliage": (0, 1, 0), "reeds": (0, 0.75, 0), "flowers": (0, 0.6, 0), "pads": (0, 0, 1), "blooms": (0, 0, 1)}
    for name, layer in layers.items():
        obj = layer.build(coll)
        if obj and name in moves:
            C.set_mask(obj, moves[name])
    cam = C.pano_camera(EYE[2])
    cam.location = EYE
    C.set_resolution(1024 if preview else 8192)
    return scene


if __name__ == "__main__":
    build()
