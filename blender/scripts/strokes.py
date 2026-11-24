"""A world made of brush strokes: ribbons of paint hung in space, facing the
viewer, coloured from the painting they stand for. Used by the two oil rooms
(stillness.py, moonlight.py).
"""

import math
import os

import bpy
import numpy as np

import common as C
import printmaking as P

K = 9  # points along a stroke
EYE = np.array([0.0, 0.0, 1.75])  # where they all face; a scene sets it in place (EYE[:] = ...)
rng = np.random.default_rng(1900)


def reseed(seed):
    """Start the hand again, so each scene is the same however it was reached."""
    rng.bit_generator.state = np.random.default_rng(seed).bit_generator.state


# ─── The palette: regions of a painting ─────────────────────────────────────

def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def load_painting(name, gamma=0.74, saturation=1.34):
    img = bpy.data.images.load(os.path.join(C.ROOT, "blender", "sources", name), check_existing=True)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)[::-1, :, :3]
    # one pixel per dab of the brush, so a stroke takes a mixed colour and not a speck
    f = max(1, w // 600)
    a = a[: h // f * f, : w // f * f].reshape(h // f, f, w // f, f, 3).mean((1, 3))
    # what hangs in a dark gallery is seen closer to than a photograph of it: open the shadows a little
    a = np.clip(a, 0, 1) ** gamma
    lum = a @ np.array([0.3, 0.59, 0.11])
    return np.clip(lum[..., None] + (a - lum[..., None]) * saturation, 0, 1)


def hsv(a):
    mx, mn = a.max(-1), a.min(-1)
    d = np.maximum(mx - mn, 1e-6)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return h, d / np.maximum(mx, 1e-6), mx


class Palette:
    """Pools of colour from boxes of a painting (x0, y0, x1, y1 in 0..1), each
    kept to the pixels a test of hue, saturation and value lets through."""

    def __init__(self, image, boxes):
        H, W = image.shape[:2]
        self.pools = {}
        for name, (x0, y0, x1, y1, *keep) in boxes.items():
            a = image[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)].reshape(-1, 3)
            if keep:
                a = a[keep[0](*hsv(a))]
            if len(a) < 40:
                raise SystemExit(f"palette pool {name!r} is nearly empty ({len(a)})")
            self.pools[name] = a

    def pick(self, name, n, value=None, spread=0.02):
        """n colours from a pool; with `value` (0..1 per colour), darker or
        lighter ones within it (0 = its darkest)."""
        pool = self.pools[name]
        if value is None:
            c = pool[rng.integers(0, len(pool), n)]
        else:
            order = np.argsort(pool @ np.array([0.3, 0.59, 0.11]))
            q = np.clip(np.asarray(value) + rng.normal(0, 0.12, n), 0, 0.999)
            c = pool[order[(q * len(pool)).astype(int)]]
        return np.clip(c + rng.normal(0, spread, (n, 3)), 0, 1)

    def mixed(self, weights, n):
        """n colours from several pools, {name: weight}."""
        names = list(weights)
        w = np.array([weights[k] for k in names], float)
        which = rng.choice(len(names), n, p=w / w.sum())
        out = np.empty((n, 3))
        for i, name in enumerate(names):
            m = which == i
            out[m] = self.pick(name, int(m.sum()))
        return out


# ─── Noise ────────────────────────────────────────────────────────────────────

def vnoise(p, seed=0):
    """Smooth value noise in 0..1 at points N×d."""
    p = np.asarray(p, float)
    i = np.floor(p).astype(np.int64)
    f = p - i
    u = f * f * (3 - 2 * f)
    d = p.shape[1]
    total = np.zeros(len(p))
    primes = np.array([73856093, 19349663, 83492791])[:d]
    for corner in range(1 << d):
        off = np.array([(corner >> k) & 1 for k in range(d)])
        h = ((i + off) * primes).sum(1) ^ (seed * 2654435761)
        h = (h ^ (h >> 13)) * 1274126177 & 0x7FFFFFFF
        v = ((h ^ (h >> 16)) & 0xFFFF) / 65535.0
        total += v * np.prod(np.where(off, u, 1 - u), axis=1)
    return total


def fbm(p, octaves=3, seed=0):
    p = np.asarray(p, float)
    return sum(vnoise(p * 2 ** o, seed + o) * 0.5 ** o for o in range(octaves)) / sum(0.5 ** o for o in range(octaves))


# ─── Strokes ──────────────────────────────────────────────────────────────────

BRUSHES = 8


def brush_atlas():
    """One brush mark per row: R how thick the paint lies, A where it lies."""
    w, h = 512, 96
    r = np.random.default_rng(4)
    out = np.zeros((h * BRUSHES, w, 4), np.float32)
    x = np.linspace(0, 1, w)[None, :]
    y = np.linspace(-1, 1, h)[:, None]
    for b in range(BRUSHES):
        bristle = r.random(h)
        bristle = np.convolve(np.pad(bristle, 4, mode="edge"), np.ones(5) / 5, "same")[4:-4]
        bristle = (bristle - bristle.min()) / (np.ptp(bristle) + 1e-6)
        wander = np.cumsum(r.normal(0, 1, (h, w)), 1)
        wander = (wander - wander.mean(1, keepdims=True)) / (wander.std(1, keepdims=True) + 1e-6)
        kern = np.ones(9) / 9
        wander = np.apply_along_axis(lambda m: np.convolve(m, kern, "same"), 0, wander)
        thick = np.clip(0.55 * bristle[:, None] + 0.5 + 0.16 * wander, 0, 1)
        # the ends: each bristle lands and lifts a little before or after its neighbours
        start = 0.02 + 0.07 * bristle + 0.03 * r.random(h)
        end = 0.98 - 0.05 * (1 - bristle) - (0.06 + 0.2 * (b % 4) / 3) * r.random(h) ** 1.5
        alpha = np.clip((x - start[:, None]) / 0.015, 0, 1) * np.clip((end[:, None] - x) / 0.03, 0, 1)
        # the sides: ragged
        edge = 0.84 + 0.13 * np.sin(x * (9 + b) + b) * np.sin(x * 23 + b * 2)
        # fuller in the middle of the mark than at its ends
        edge *= 0.72 + 0.28 * np.sin(np.pi * np.clip(x * 0.94 + 0.04, 0, 1)) ** 0.6
        alpha *= np.clip((edge - np.abs(y)) / 0.2, 0, 1)
        # dry brush: towards the end of some marks the paint runs out between bristles
        dry = (0.15 + 0.5 * (b % 3) / 2) * np.clip((x - 0.45) / 0.55, 0, 1)
        alpha *= np.clip((bristle[:, None] + 0.35 * wander - dry + 0.25) / 0.12, 0, 1)
        skip = r.random((h // 3 + 1, w // 5 + 1)).repeat(3, 0).repeat(5, 1)[:h, :w]
        reach = 1 - np.clip((np.abs(y) - 0.25) / 0.6, 0, 1) * 0.75 - np.clip((x - 0.55) / 0.45, 0, 1) * 0.45
        alpha *= np.clip((reach - skip * 0.62 + 0.18) / 0.3, 0.08, 1)
        out[b * h:(b + 1) * h, :, 0] = out[b * h:(b + 1) * h, :, 1] = out[b * h:(b + 1) * h, :, 2] = thick
        out[b * h:(b + 1) * h, :, 3] = np.clip(alpha, 0, 1)
    img = bpy.data.images.new("brushes", w, h * BRUSHES, alpha=True, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    img.alpha_mode = "CHANNEL_PACKED"
    img.pixels.foreach_set(out.ravel())
    img.pack()
    return img


class Layer:
    """Strokes that become one mesh: paths (n×K×3), widths, colours."""

    def __init__(self, name, klass="paint"):
        self.name, self.klass = name, klass
        self.paths, self.widths, self.colours, self.lifts, self.bodies = [], [], [], [], []

    def add(self, paths, widths, colours, lift=0.0, body=0.85):
        """body: how much the paint covers, from a glaze (0) to thick paint (1)."""
        paths = np.asarray(paths, float)
        n = len(paths)
        if not n:
            return
        self.paths.append(paths)
        self.widths.append(np.broadcast_to(widths, n).astype(float))
        self.colours.append(np.asarray(colours, float))
        self.bodies.append(np.clip(np.broadcast_to(body, n) + rng.normal(0, 0.1, n), 0.2, 1))
        # strokes of one layer overlap in no particular order
        self.lifts.append(np.broadcast_to(lift, n) + rng.random(n) * 0.006)

    def build(self, coll):
        if not self.paths:
            return None
        paths = np.concatenate(self.paths)
        widths, colours = np.concatenate(self.widths), np.concatenate(self.colours)
        lifts = np.concatenate(self.lifts)
        n, k = paths.shape[:2]
        paths = EYE + (paths - EYE) * (1 - lifts)[:, None, None]
        tangent = np.gradient(paths, axis=1)
        view = paths - EYE
        side = np.cross(view, tangent)
        side /= np.maximum(np.linalg.norm(side, axis=2, keepdims=True), 1e-9)
        half = side * (widths * 0.5)[:, None, None]
        verts = np.stack([paths - half, paths + half], 2).reshape(-1, 3)  # n·k·2
        base = (np.arange(n) * k * 2)[:, None] + (np.arange(k - 1) * 2)[None, :]
        faces = np.stack([base, base + 1, base + 3, base + 2], -1).reshape(-1, 4)
        obj = P.mesh_from_arrays(self.name, verts, faces, coll)
        row = rng.integers(0, BRUSHES, n)
        flip = rng.random(n) < 0.5
        u = np.linspace(0.004, 0.996, k)[None, :, None]
        u = np.where(flip[:, None, None], 1 - u, u)
        v = (row[:, None, None] + np.array([0.02, 0.98])[None, None, :]) / BRUSHES
        uv = np.stack(np.broadcast_arrays(u, v), -1).reshape(-1, 2)
        P.add_uv(obj, uv)
        col = np.concatenate([srgb_to_linear(np.clip(colours, 0, 1)), np.concatenate(self.bodies)[:, None]], 1)
        attr = obj.data.attributes.new("paint", "FLOAT_COLOR", "POINT")
        attr.data.foreach_set("color", np.repeat(col, k * 2, axis=0).astype(np.float32).ravel())
        C.assign(obj, paint_material())
        if self.klass == "water":
            C.set_mask(obj, (1, 0, 0))
        print(f"  {self.name}: {n} strokes")
        return obj


def paint_material():
    if "paint" in bpy.data.materials:
        return bpy.data.materials["paint"]
    mat, nt, out = C.new_material("paint")
    tex = C.node(nt, "ShaderNodeTexImage", -700, 0)
    tex.image = brush_atlas()
    tex.interpolation = "Cubic"
    tex.extension = "EXTEND"
    uv = C.node(nt, "ShaderNodeUVMap", -900, 0)
    nt.links.new(uv.outputs[0], tex.inputs["Vector"])
    attr = C.node(nt, "ShaderNodeAttribute", -700, 300)
    attr.attribute_name = "paint"
    # paint is lighter along the ridges the bristles leave, darker in the grooves
    ridge = C.node(nt, "ShaderNodeMapRange", -400, 0)
    ridge.inputs["From Min"].default_value = 0.2
    ridge.inputs["From Max"].default_value = 1.0
    ridge.inputs["To Min"].default_value = 0.66
    ridge.inputs["To Max"].default_value = 1.24
    nt.links.new(tex.outputs["Color"], ridge.inputs["Value"])
    mul = C.node(nt, "ShaderNodeVectorMath", -150, 200, operation="SCALE")
    nt.links.new(attr.outputs["Color"], mul.inputs[0])
    nt.links.new(ridge.outputs["Result"], mul.inputs["Scale"])
    em = C.node(nt, "ShaderNodeEmission", 100, 200)
    nt.links.new(mul.outputs[0], em.inputs["Color"])
    clear = C.node(nt, "ShaderNodeBsdfTransparent", 100, -100)
    cut = C.node(nt, "ShaderNodeMapRange", -150, -150)
    cut.inputs["From Min"].default_value = 0.1
    cut.inputs["From Max"].default_value = 0.85
    nt.links.new(tex.outputs["Alpha"], cut.inputs["Value"])
    covers = C.node(nt, "ShaderNodeMath", 100, -250, operation="MULTIPLY")
    nt.links.new(cut.outputs["Result"], covers.inputs[0])
    nt.links.new(attr.outputs["Alpha"], covers.inputs[1])
    mix = C.node(nt, "ShaderNodeMixShader", 350, 0)
    nt.links.new(covers.outputs[0], mix.inputs[0])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


# ─── Laying them ─────────────────────────────────────────────────────────

RAD = math.pi / 180


def toward(yaw, pitch, dist):
    """Points at a bearing (degrees) and distance from the eye."""
    y, p = np.asarray(yaw) * RAD, np.asarray(pitch) * RAD
    d = np.stack(np.broadcast_arrays(np.sin(y) * np.cos(p), np.cos(y) * np.cos(p), np.sin(p)), -1)
    return EYE + d * np.asarray(dist)[..., None]


def scatter(n, yaw, pitch):
    """Evenly over a patch of the sphere: bearings in degrees."""
    y = rng.uniform(*yaw, n)
    s = rng.uniform(math.sin(pitch[0] * RAD), math.sin(pitch[1] * RAD), n)
    return y, np.arcsin(s) / RAD


def along(centres, direction, length, bend=0.0, sag=None):
    """Paths of K points through each centre; `bend` bows them sideways."""
    t = np.linspace(-0.5, 0.5, K)[None, :, None]
    direction = direction / np.maximum(np.linalg.norm(direction, axis=1, keepdims=True), 1e-9)
    view = centres - EYE
    side = np.cross(view, direction)
    side /= np.maximum(np.linalg.norm(side, axis=1, keepdims=True), 1e-9)
    L = np.asarray(length)[:, None, None]
    b = np.broadcast_to(bend, len(centres))[:, None, None]
    p = centres[:, None, :] + direction[:, None, :] * t * L + side[:, None, :] * b * L * (0.25 - t * t)
    return p


def frame(yaw, pitch):
    """Right and up directions on the sphere at bearings (degrees)."""
    y, p = yaw * RAD, pitch * RAD
    right = np.stack([np.cos(y), -np.sin(y), np.zeros_like(y)], -1)
    up = np.stack([-np.sin(y) * np.sin(p), -np.cos(y) * np.sin(p), np.cos(p)], -1)
    return right, up


def on_dome(yaw, pitch, dist, angle, length_deg, width_deg, bend=0.0):
    """Strokes on a sphere: angle 90 is upright. Returns paths and widths."""
    right, up = frame(yaw, pitch)
    a = (angle * RAD)[:, None]
    c = toward(yaw, pitch, dist)
    d = right * np.cos(a) + up * np.sin(a)
    return along(c, d, length_deg * RAD * dist, bend), width_deg * RAD * dist


def mood(yaw, pitch, seed):
    """Slow variation over the sphere, 0..1, without a seam."""
    y, p = np.asarray(yaw) * RAD, np.asarray(pitch) * RAD
    d = np.stack([np.sin(y) * np.cos(p) * 3.1, np.cos(y) * np.cos(p) * 3.1, np.sin(p) * 2.2], -1)
    return np.clip((fbm(d, 3, seed) - 0.5) * 1.9 + 0.5, 0, 1)
