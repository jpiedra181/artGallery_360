"""Per-scene finishing looks, applied by scripts/post.py.

Each function receives the render as float32 RGB in [0, 1] (display
referred) and the scene's render folder, and returns the finished image.

All filters treat the panorama as a cylinder: they wrap around horizontally
so no seam appears where the left and right edges meet.
"""

import os

import cv2
import numpy as np

# ─── Helpers ──────────────────────────────────────────────────────────────────


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def load_pass(folder, name, size):
    path = os.path.join(folder, f"{name}.png")
    if not os.path.exists(path):
        return None
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    scale = 65535.0 if img.dtype == np.uint16 else 255.0
    img = img.astype(np.float32) / scale
    if img.shape[1] != size[0]:
        img = cv2.resize(img, size, interpolation=cv2.INTER_NEAREST)
    # BGRA -> RGBA
    if img.ndim == 3 and img.shape[2] == 4:
        img = img[..., [2, 1, 0, 3]]
    elif img.ndim == 3:
        img = img[..., ::-1]
    return img


def wrap_filter(img, pad, fn):
    """Run fn on a horizontally wrapped copy and crop back."""
    padded = np.concatenate([img[:, -pad:], img, img[:, :pad]], axis=1)
    out = fn(padded)
    return out[:, pad:-pad]


def shift(a, dx, dy):
    """Neighbour lookup with horizontal wrap and vertical clamp."""
    out = np.roll(a, -dx, axis=1)
    if dy > 0:
        out = np.concatenate([out[dy:], np.repeat(out[-1:], dy, axis=0)], axis=0)
    elif dy < 0:
        out = np.concatenate([np.repeat(out[:1], -dy, axis=0), out[:dy]], axis=0)
    return out


def fbm(shape, scales, seed=0, weights=None):
    """Smooth multi-scale noise in [-1, 1], tileable horizontally."""
    rng = np.random.default_rng(seed)
    h, w = shape
    total = np.zeros(shape, np.float32)
    weights = weights or [1.0 / (i + 1) for i in range(len(scales))]
    for s, wt in zip(scales, weights):
        gh, gw = max(2, int(h / s)), max(2, int(w / s))
        g = rng.standard_normal((gh, gw)).astype(np.float32)
        # Sample the grid as a ring: whole cells on each side for the cubic
        # filter to read, and the same cell size all the way round, so the last
        # column runs into the first.
        ring = np.concatenate([g[:, -3:], g, g[:, :3]], axis=1)
        x = (np.arange(w, dtype=np.float32) + 0.5) * gw / w - 0.5 + 3
        y = np.clip((np.arange(h, dtype=np.float32) + 0.5) * gh / h - 0.5, 0, gh - 1)
        # cv2.remap takes at most 32767 columns on either side: well above any grid here
        mx, my = np.meshgrid(x, y.astype(np.float32))
        total += cv2.remap(ring, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE) * wt
    total /= max(1e-6, np.abs(total).max())
    return total


# ─── Woodblock print finish ───────────────────────────────────────────────────


def ink_lines(folder, size, width_px, far=350.0, normal_deg=38.0, depth_jump=0.12):
    """Outline mask (0..1) from the depth, normal and id passes."""
    w, h = size
    depth = load_pass(folder, "depth", size)
    normal = load_pass(folder, "normal", size)
    ids = load_pass(folder, "id", size)
    edges = np.zeros((h, w), bool)

    if depth is not None:
        inv = srgb_to_linear(depth[..., 0])
        alpha = depth[..., 3]
        D = np.where(alpha > 0.5, 20.0 * (1.0 / np.maximum(inv, 1e-4) - 1.0), 1e5)
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            n = shift(D, dx, dy)
            near = np.minimum(D, n)
            jump = np.abs(D - n) / np.maximum(near, 1e-3)
            # second difference: ignores smooth surfaces seen at grazing angles
            n2 = shift(D, -dx, -dy)
            curv = np.abs(n + n2 - 2 * D) / np.maximum(near, 1e-3)
            edges |= (jump > depth_jump) & (curv > depth_jump * 0.8) & (near < far)

    if normal is not None:
        N = srgb_to_linear(normal[..., :3]) * 2.0 - 1.0
        N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)
        alpha = normal[..., 3] > 0.5
        cos_t = np.cos(np.radians(normal_deg))
        for dx, dy in ((1, 0), (0, 1)):
            n = np.stack([shift(N[..., c], dx, dy) for c in range(3)], -1)
            edges |= (np.sum(N * n, -1) < cos_t) & alpha & shift(alpha, dx, dy)

    if ids is not None:
        I = ids[..., :3]
        a = ids[..., 3] > 0.5
        for dx, dy in ((1, 0), (0, 1)):
            n = np.stack([shift(I[..., c], dx, dy) for c in range(3)], -1)
            na = shift(a, dx, dy)
            diff = np.abs(I - n).max(-1) > 0.02
            edges |= (diff & a & na)

    e = edges.astype(np.float32)
    k = max(1, int(round(width_px)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    e = wrap_filter(e, k * 2, lambda x: cv2.dilate(x, kernel))
    e = wrap_filter(e, 6, lambda x: cv2.GaussianBlur(x, (0, 0), max(0.6, width_px * 0.22)))
    return np.clip(e * 1.25, 0, 1)


def paper(shape, seed=3, strength=1.0):
    """Paper tone: soft mottling plus fine fibres, as a multiplier near 1."""
    h, w = shape
    mott = fbm(shape, [w / 6, w / 18, w / 60], seed)
    fibres = fbm(shape, [w / 900, w / 2400], seed + 1, [1.0, 0.6])
    # stretch fibre noise horizontally into short strands
    sx = max(1, w / 1600)
    fibres = wrap_filter(fibres, int(sx * 4) + 2, lambda x: cv2.GaussianBlur(x, (0, 0), sigmaX=sx, sigmaY=0.6))
    fibres /= max(1e-6, np.abs(fibres).max())
    return 1.0 + strength * (0.025 * mott + 0.03 * fibres)


def woodblock(img, folder, ink_hex="#1d2735", width=3.0, seed=5):
    """Ink outlines, a little block mottling in flat areas, and paper."""
    h, w = img.shape[:2]
    scale = w / 8192
    lines = ink_lines(folder, (w, h), width * scale)
    ink = np.array([int(ink_hex[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)
    # block mottling: pressure of the baren varies across big flat areas
    blot = fbm((h, w), [w / 40, w / 140], seed, [1.0, 0.5])
    img = img * (1.0 + 0.035 * blot[..., None])
    img = img * (1 - lines[..., None]) + ink * lines[..., None]
    img = img * paper((h, w), seed)[..., None]
    return np.clip(img, 0, 1)


# ─── Oil paint finish ─────────────────────────────────────────────────────────

BLENDER = r"C:/Program Files/Blender Foundation/Blender 5.0/blender.exe"
PAINT_FILTER = os.path.join(os.path.dirname(__file__), "..", "blender", "scripts", "paint_filter.py")


def kuwahara(img, size, uniformity=4, sharpness=0.6, eccentricity=1.0):
    """Anisotropic Kuwahara via Blender's compositor, wrapping horizontally so
    the panorama has no seam. img: float RGB in [0, 1]."""
    import subprocess
    import tempfile

    pad = int(size * 4)
    padded = np.concatenate([img[:, -pad:], img, img[:, :pad]], axis=1)
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.png")
        dst = os.path.join(tmp, "out.png")
        cv2.imwrite(src, (np.clip(padded, 0, 1) * 65535).astype(np.uint16)[..., ::-1])
        subprocess.run(
            [BLENDER, "-b", "--factory-startup", "-P", os.path.abspath(PAINT_FILTER), "--",
             "--in", src, "--out", dst, "--size", str(size), "--uniformity", str(uniformity),
             "--sharpness", str(sharpness), "--eccentricity", str(eccentricity)],
            check=True, capture_output=True,
        )
        out = cv2.imread(dst, cv2.IMREAD_UNCHANGED)[..., :3][..., ::-1].astype(np.float32) / 65535.0
    return out[:, pad:-pad]


def canvas_weave(shape, period_px, seed=2):
    """Fine canvas weave as a multiplier near 1."""
    h, w = shape
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    jitter = fbm(shape, [period_px * 6], seed)[...] * 0.6
    weave = np.sin((x + jitter * period_px) * (2 * np.pi / period_px)) * np.sin((y - jitter * period_px) * (2 * np.pi / period_px))
    return 1.0 + 0.018 * weave


def impasto(img, strength=0.06, blur=2.0):
    """Light raking across the thickness of the paint: emboss the luminance."""
    lum = img @ np.array([0.3, 0.59, 0.11], np.float32)
    lum = wrap_filter(lum, 8, lambda x: cv2.GaussianBlur(x, (0, 0), blur))
    gx = (np.roll(lum, -1, 1) - np.roll(lum, 1, 1)) * 0.5
    gy = np.zeros_like(lum)
    gy[1:-1] = (lum[2:] - lum[:-2]) * 0.5
    relief = (gx * -0.7 + gy * -0.7) * 40.0
    return img * (1.0 + np.clip(relief, -1, 1)[..., None] * strength)


def grade(img, shadows, highlights, saturation=1.0, gamma=1.0):
    """Split-tone: tint shadows and highlights, then adjust saturation."""
    lum = (img @ np.array([0.3, 0.59, 0.11], np.float32))[..., None]
    t = np.clip(lum, 0, 1)
    tint = np.array(shadows, np.float32) * (1 - t) + np.array(highlights, np.float32) * t
    img = img * tint
    lum = (img @ np.array([0.3, 0.59, 0.11], np.float32))[..., None]
    img = lum + (img - lum) * saturation
    return np.clip(img, 0, 1) ** gamma


def bloom(img, threshold=0.7, radii=(0.003, 0.012, 0.045), amounts=(0.5, 0.4, 0.3), tint=(1.0, 0.93, 0.78)):
    """Light spreading from the brightest paint (the moon, flames, their
    reflections): the glow Turner scumbles around them. Radii are fractions
    of the panorama's width."""
    h, w = img.shape[:2]
    lum = img @ np.array([0.3, 0.59, 0.11], np.float32)
    bright = img * np.clip((lum - threshold) / (1.0 - threshold), 0, 1)[..., None]
    tint = np.array(tint, np.float32)
    out = img
    for r, amount in zip(radii, amounts):
        sigma = r * w
        # wide glows are smooth: blur a reduced copy
        f = max(1, int(sigma / 6))
        small = cv2.resize(bright, (w // f, h // f), interpolation=cv2.INTER_AREA) if f > 1 else bright
        pad = int(sigma / f * 3) + 2
        glow = wrap_filter(small, pad, lambda x: cv2.GaussianBlur(x, (0, 0), sigma / f))
        if f > 1:
            glow = cv2.resize(glow, (w, h), interpolation=cv2.INTER_LINEAR)
        out = 1.0 - (1.0 - out) * (1.0 - np.clip(glow * amount * tint, 0, 1))
    return out


def scumble(img, reach_px, grain_px, seed):
    """Break every edge the way stiff paint breaks on the threads of a canvas:
    look each pixel up a little way off, in a direction that changes from
    thread to thread."""
    h, w = img.shape[:2]
    noise = lambda s: wrap_filter(np.random.default_rng(s).standard_normal((h, w)).astype(np.float32), int(grain_px * 3) + 2, lambda a: cv2.GaussianBlur(a, (0, 0), max(0.6, grain_px * 0.36)))
    dx, dy = noise(seed), noise(seed + 1)
    dx *= reach_px / max(1e-6, dx.std() * 1.4)
    dy *= reach_px / max(1e-6, dy.std() * 1.4)
    pad = int(reach_px * 4) + 2
    x, y = np.meshgrid(np.arange(w, dtype=np.float32) + pad, np.arange(h, dtype=np.float32))
    wide = np.concatenate([img[:, -pad:], img, img[:, :pad]], axis=1)
    out = np.empty_like(img)
    # cv2.remap handles at most 32767 pixels a side: fine at 8k
    cv2.remap(wide, x + dx, np.clip(y + dy, 0, h - 1), cv2.INTER_LINEAR, dst=out)
    return out


def stroke_field(img, length_px, seed, bins=8):
    """Noise smeared along the local direction of the image (perpendicular to
    its gradient), so every area gets dabs that follow its forms."""
    h, w = img.shape[:2]
    lum = img @ np.array([0.3, 0.59, 0.11], np.float32)
    sigma = max(1.0, length_px * 0.6)
    lum = wrap_filter(lum, int(sigma * 3) + 2, lambda x: cv2.GaussianBlur(x, (0, 0), sigma * 0.5))
    gx = wrap_filter(lum, 4, lambda x: cv2.Sobel(x, cv2.CV_32F, 1, 0, ksize=3))
    gy = wrap_filter(lum, 4, lambda x: cv2.Sobel(x, cv2.CV_32F, 0, 1, ksize=3))
    blur = lambda x: wrap_filter(x, int(sigma * 3) + 2, lambda y: cv2.GaussianBlur(y, (0, 0), sigma))
    jxx, jxy, jyy = blur(gx * gx), blur(gx * gy), blur(gy * gy)
    angle = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2  # along the edges
    # where there is no clear structure (open sky, still water) lay broad
    # horizontal strokes instead of letting the noise swirl
    root = np.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy)
    coherence = root / np.maximum(jxx + jyy, 1e-9)
    strength = jxx + jyy
    flat = (coherence < 0.35) | (strength < np.percentile(strength, 35))
    angle = np.where(flat, 0.0, angle)
    idx = np.round(angle / (np.pi / bins)).astype(np.int32) % bins
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal((h, w)).astype(np.float32)
    k = int(length_px) | 1
    out = np.zeros((h, w), np.float32)
    for b in range(bins):
        kernel = np.zeros((k, k), np.float32)
        c = k // 2
        t = b * np.pi / bins
        for s in np.linspace(-c, c, k * 2):
            x, y = int(round(c + s * np.cos(t))), int(round(c + s * np.sin(t)))
            kernel[y, x] = 1.0
        kernel /= kernel.sum()
        f = wrap_filter(noise, c + 1, lambda x: cv2.filter2D(x, -1, kernel))
        out = np.where(idx == b, f, out)
    out /= max(1e-6, out.std() * 2.5)
    return np.clip(out, -1, 1)


def oil(img, folder, size, weave_px, seed, stroke_px=0, stroke=0.0, hue_jitter=0.0, **grading):
    h, w = img.shape[:2]
    scale = w / 8192
    img = kuwahara(img, max(3, size * scale))
    if stroke > 0:
        s1 = stroke_field(img, max(5, stroke_px * scale), seed)
        img = img * (1 + stroke * s1[..., None])
        if hue_jitter > 0:
            # broken colour: neighbouring strokes lean warm or cool
            s2 = stroke_field(img, max(5, stroke_px * scale), seed + 1)
            img = img + hue_jitter * s2[..., None] * np.array([0.6, 0.1, -0.7], np.float32) * img
    img = impasto(img, strength=0.05, blur=max(1.0, 2.5 * scale))
    img = grade(img, **grading)
    img = img * canvas_weave((h, w), max(3.0, weave_px * scale), seed)[..., None]
    return np.clip(img, 0, 1)


# ─── Scenes ───────────────────────────────────────────────────────────────────


def wave(img, folder):
    return woodblock(img, folder, ink_hex="#1d2735", width=3.2, seed=11)


def rain(img, folder):
    # Hiroshige: thin lines, and the grain of the block showing in the big wiped areas
    img = woodblock(img, folder, ink_hex="#24272c", width=2.1, seed=23)
    h, w = img.shape[:2]
    grain = fbm((h, max(16, w // 24)), [w / 24 / 5, w / 24 / 12, w / 24 / 30], 77, [1.0, 0.8, 0.6])
    mx, my = np.meshgrid((np.arange(w, dtype=np.float32) + 0.5) / 24, np.arange(h, dtype=np.float32))
    ring = np.concatenate([grain, grain[:, :2]], axis=1)
    grain = cv2.remap(ring, mx, my + 6 * fbm((h, w), [w / 9, w / 30], 78).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    grain /= max(1e-6, grain.std() * 2.2)
    # level grain turns into rings where one looks straight down: let it go there
    lat = np.abs(np.linspace(90, -90, h, dtype=np.float32))[:, None]
    grain = np.clip(grain, -1, 1) * np.clip((48 - lat) / 22, 0, 1)
    return np.clip(img * (1.0 + 0.04 * grain[..., None]), 0, 1)


def stillness(img, folder):
    # Monet: the strokes are already in the render (blender/scripts/stillness.py). Wet paint: edges drag
    # a little into their neighbours, the ridges catch the light, the canvas shows through.
    scale = img.shape[1] / 8192
    img = scumble(img, 1.0 * scale, 6.0 * scale, 31)
    img = scumble(img, 0.8 * scale, 2.4 * scale, 37)
    img = impasto(img, strength=0.09, blur=max(0.8, 1.6 * scale))
    img = grade(img, shadows=(0.96, 0.98, 1.06), highlights=(1.14, 1.1, 1.02), saturation=1.12)
    return np.clip(img * canvas_weave(img.shape[:2], max(3.0, 7 * scale), 31)[..., None], 0, 1)


def moonlight(img, folder):
    # Turner: the strokes are in the render (blender/scripts/moonlight.py). Thin glazes
    # dragged over one another, light spilling a little from the fires and the moon.
    scale = img.shape[1] / 8192
    img = scumble(img, 0.8 * scale, 5.0 * scale, 41)
    img = bloom(img, threshold=0.86, radii=(0.002, 0.008, 0.03), amounts=(0.22, 0.2, 0.16))
    img = impasto(img, strength=0.07, blur=max(0.8, 1.6 * scale))
    return np.clip(img * canvas_weave(img.shape[:2], max(3.0, 7 * scale), 41)[..., None], 0, 1)
