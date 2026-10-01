"""Room I — Wave. Inside Hokusai's "Under the Wave off Kanagawa".

The viewer rides low in a fishing boat in the trough between swells. Ahead,
Mount Fuji sits small on the horizon; on the left the great wave rises and
its lip curls overhead, breaking into claw-like foam. Flat woodblock colours
(emission only); outlines and paper are added in post (scripts/looks.py).

Mask pass
  R  sea surface      G  sky
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C
import printmaking as P

# Palette sampled from the print (sRGB)
DEEP = "#1d3757"
PRUSSIAN = "#2b5276"
MID = "#5b84a6"
LIGHT = "#a8c0cf"
FOAM = "#f1e9d6"
PAPER = "#eadfc5"
HORIZON = "#8f897b"
INK = "#1d2735"
BOAT = "#e5d2a3"
BOAT_DARK = "#b39a68"
CLOTH = "#4d6b86"
SKIN = "#e8c9a0"
FUJI = "#5e7891"
SNOW = "#f5efe2"

SWELL_DIR = math.radians(135)  # waves travel towards yaw 135° (from the front-left)

rng = random.Random(7)


# ─── Sea ──────────────────────────────────────────────────────────────────────

WAVES = [
    # wavelength (m), amplitude (m), direction offset (deg), steepness, phase
    (110.0, 2.6, 0, 0.55, -math.pi / 2),  # -π/2: the viewer sits in the trough
    (64.0, 1.5, -18, 0.6, -math.pi / 2),
    (38.0, 0.8, 24, 0.7, 2.3),
    (21.0, 0.35, -40, 0.8, 0.7),
    (11.0, 0.22, 55, 0.8, 4.1),
    (7.3, 0.14, -70, 0.85, 1.9),
    (4.6, 0.08, 20, 0.9, 5.2),
    (3.1, 0.045, -35, 0.9, 0.4),
]


def gerstner(x, y):
    """Displaced positions, height and a crest factor for points on the sea."""
    dx = np.zeros_like(x)
    dy = np.zeros_like(x)
    z = np.zeros_like(x)
    jac = np.ones_like(x)
    for length, amp, offset, q, phase in WAVES:
        a = SWELL_DIR + math.radians(offset)
        d = np.array([math.sin(a), math.cos(a)])
        k = 2 * math.pi / length
        theta = k * (d[0] * x + d[1] * y) + phase
        c, s = np.cos(theta), np.sin(theta)
        dx += q * amp * d[0] * c
        dy += q * amp * d[1] * c
        z += amp * s
        jac -= q * amp * k * s
    return x + dx, y + dy, z, jac


def sea_height_at(x, y):
    """Height of the displaced surface near (x, y) (one fixed-point step)."""
    px, py = x, y
    for _ in range(4):
        gx, gy, gz, _ = gerstner(np.array([px], float), np.array([py], float))
        px += x - gx[0]
        py += y - gy[0]
    return gerstner(np.array([px], float), np.array([py], float))[2][0]


def build_sea(coll):
    # polar grid: fine near the boat, coarse towards the horizon
    rings = np.concatenate([[0.0], 1.2 * (1.032 ** np.arange(0, 230))])
    rings = rings[rings < 2600]
    seg = 900
    ang = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    R, A = np.meshgrid(rings, ang, indexing="ij")
    x0 = (R * np.sin(A)).ravel()
    y0 = (R * np.cos(A)).ravel()
    x, y, z, jac = gerstner(x0, y0)
    # waves flatten towards the horizon so it stays a clean line
    fade = 1 - P.smoothstep(600, 2400, R.ravel())
    z *= fade
    verts = np.stack([x0 + (x - x0) * fade, y0 + (y - y0) * fade, z], -1)
    faces = P.grid_faces(len(rings), seg, wrap_cols=True)
    obj = P.mesh_from_arrays("sea", verts, faces, coll)
    height = (z + 5.5) / 11.0
    crest = np.clip((1 - jac) * 1.4 + (z - 1.0) * 0.25, 0, 1) * fade
    P.add_point_attribute(obj, "height", height)
    P.add_point_attribute(obj, "crest", crest)
    for p in obj.data.polygons:
        p.use_smooth = True
    C.assign(obj, sea_material())
    C.set_mask(obj, (1, 0, 0))
    obj["line_group"] = "water"
    return obj


def sea_material():
    """Bands of Prussian blue, fine contour lines and white crests."""
    mat, nt, out = C.new_material("sea")
    em = C.node(nt, "ShaderNodeEmission", 900, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    h = C.node(nt, "ShaderNodeAttribute", -900, 200)
    h.attribute_name = "height"
    c = C.node(nt, "ShaderNodeAttribute", -900, -200)
    c.attribute_name = "crest"

    ramp = C.node(nt, "ShaderNodeValToRGB", -500, 300)
    cr = ramp.color_ramp
    cr.interpolation = "CONSTANT"
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*P.hex_to_linear(DEEP), 1)
    cr.elements[1].position = 0.5
    cr.elements[1].color = (*P.hex_to_linear(PRUSSIAN), 1)
    e = cr.elements.new(0.66)
    e.color = (*P.hex_to_linear(MID), 1)
    nt.links.new(h.outputs["Fac"], ramp.inputs["Fac"])

    # contour lines of equal height: like the cut lines on the print
    geo = C.node(nt, "ShaderNodeNewGeometry", -1100, 0)
    noise = C.node(nt, "ShaderNodeTexNoise", -900, 0)
    noise.inputs["Scale"].default_value = 0.08
    noise.inputs["Detail"].default_value = 1.0
    nt.links.new(geo.outputs["Position"], noise.inputs["Vector"])
    warp = C.node(nt, "ShaderNodeMath", -700, 50, operation="MULTIPLY_ADD")
    warp.inputs[1].default_value = 0.04
    nt.links.new(noise.outputs["Fac"], warp.inputs[0])
    # a gentle slope along the swell direction opens closed rings into streaks
    dirdot = C.node(nt, "ShaderNodeVectorMath", -1000, -100, operation="DOT_PRODUCT")
    dirdot.inputs[1].default_value = (math.sin(SWELL_DIR) * 0.0016, math.cos(SWELL_DIR) * 0.0016, 0.0)
    nt.links.new(geo.outputs["Position"], dirdot.inputs[0])
    biased = C.node(nt, "ShaderNodeMath", -850, -100, operation="ADD")
    nt.links.new(h.outputs["Fac"], biased.inputs[0])
    nt.links.new(dirdot.outputs["Value"], biased.inputs[1])
    nt.links.new(biased.outputs[0], warp.inputs[2])
    freq = C.node(nt, "ShaderNodeMath", -550, 50, operation="MULTIPLY")
    freq.inputs[1].default_value = 52.0
    nt.links.new(warp.outputs[0], freq.inputs[0])
    fr = C.node(nt, "ShaderNodeMath", -400, 50, operation="FRACT")
    nt.links.new(freq.outputs[0], fr.inputs[0])
    line = C.node(nt, "ShaderNodeMath", -250, 50, operation="LESS_THAN")
    line.inputs[1].default_value = 0.16
    nt.links.new(fr.outputs[0], line.inputs[0])
    # lines are lighter on the high water, darker blue in the troughs
    line_col = C.mix_color(nt, P.hex_to_linear(MID), P.hex_to_linear(LIGHT), h.outputs["Fac"], x=-100, y=-50)
    col = C.mix_color(nt, ramp.outputs["Color"], line_col, line.outputs[0], x=150, y=200)

    # foam on the crests, with a ragged edge
    fnoise = C.node(nt, "ShaderNodeTexNoise", -700, -300)
    fnoise.inputs["Scale"].default_value = 0.9
    fnoise.inputs["Detail"].default_value = 4.0
    nt.links.new(geo.outputs["Position"], fnoise.inputs["Vector"])
    fsum = C.node(nt, "ShaderNodeMath", -450, -300, operation="MULTIPLY_ADD")
    fsum.inputs[1].default_value = 0.35
    nt.links.new(fnoise.outputs["Fac"], fsum.inputs[0])
    nt.links.new(c.outputs["Fac"], fsum.inputs[2])
    foam = C.node(nt, "ShaderNodeMath", -250, -300, operation="GREATER_THAN")
    foam.inputs[1].default_value = 0.62
    nt.links.new(fsum.outputs[0], foam.inputs[0])
    col = C.mix_color(nt, col, P.hex_to_linear(FOAM), foam.outputs[0], x=400, y=0)

    # distance haze: the sea pales towards the horizon like an ink wash
    lp = C.node(nt, "ShaderNodeLightPath", -250, -600)
    haze = C.node(nt, "ShaderNodeMapRange", 0, -600)
    haze.inputs["From Min"].default_value = 250.0
    haze.inputs["From Max"].default_value = 2300.0
    haze.inputs["To Max"].default_value = 0.85
    haze.interpolation_type = "SMOOTHSTEP"
    nt.links.new(lp.outputs["Ray Length"], haze.inputs["Value"])
    col = C.mix_color(nt, col, P.hex_to_linear("#7f97a6"), haze.outputs["Result"], x=650, y=0)
    nt.links.new(col, em.inputs["Color"])
    return mat


# ─── The great wave ───────────────────────────────────────────────────────────

# Cross-section of a plunging breaker (u: towards the viewer, v: up), in units
# of the wave height, from the trough behind it, over the crest, out along the
# lip, curling under and back down the hollow face.
CURL = [
    (-1.25, -0.06), (-0.75, 0.16), (-0.42, 0.48), (-0.18, 0.80), (0.02, 0.98),
    (0.24, 1.06), (0.46, 1.04), (0.66, 0.94), (0.82, 0.78), (0.89, 0.62),
    (0.83, 0.50), (0.68, 0.47), (0.52, 0.53), (0.36, 0.58), (0.22, 0.52),
    (0.12, 0.38), (0.10, 0.22), (0.18, 0.08), (0.36, -0.02), (0.56, -0.05),
]
# The same number of points along a plain swell, so the two blend smoothly.
SWELL = [
    (u, 0.42 * math.exp(-(((u + 0.05) / 0.55) ** 2)) - 0.05)
    for u in np.linspace(-1.25, 0.95, len(CURL))
]
PROFILE_N = 90


def _profile_marks():
    """Indices of the crest top and the lip tip on the resampled curl."""
    c = P.catmull_rom(CURL, PROFILE_N)
    upper = np.where(c[:, 1] > 0.45)[0]
    tip = int(upper[np.argmax(c[upper, 0])])
    top = int(np.argmax(c[:, 1]))
    return top, tip


CREST_I, TIP_I = _profile_marks()
# stretch of the profile covered in foam: a fringe along the leading edge of the lip
LIP_T = ((TIP_I - 4) / (PROFILE_N - 1), (TIP_I + 4) / (PROFILE_N - 1))


def finger_field(n_s, length, spacing, seed):
    """Per-slice strength of the foam fingers along the crest (0..1), and a
    faster pattern that splits each finger tip into three talons."""
    r = np.random.default_rng(seed)
    edges = [0.0]
    while edges[-1] < length + spacing:
        edges.append(edges[-1] + spacing * r.uniform(0.7, 1.3))
    edges = np.array(edges)
    x = np.linspace(0, length, n_s)
    idx = np.searchsorted(edges, x, side="right") - 1
    phase = (x - edges[idx]) / (edges[idx + 1] - edges[idx])
    width = 0.7
    f = np.clip((phase - (1 - width) / 2) / width, 0, 1)
    finger = np.sin(np.pi * f) ** 1.1
    strength = r.uniform(0.55, 1.0, len(edges))[idx]
    talon = np.abs(np.sin(np.pi * f * 3)) ** 1.5
    return finger * strength, talon


def deform_lip(prof, e, talon):
    """Pull the lip of one slice out into a finger that hooks downwards.
    e: finger strength for this slice (0 keeps the plain curl)."""
    if e <= 1e-3:
        return prof
    out = prof.copy()
    pivot = prof[TIP_I - 9]
    j = np.arange(len(prof))
    w = P.smoothstep(TIP_I - 9, TIP_I - 1, j) * (1 - P.smoothstep(TIP_I + 5, TIP_I + 15, j))
    reach = (0.36 * e + 0.22 * e * talon) * w
    ang = -0.75 * e * w  # clockwise: the finger curls down and back
    d = prof - pivot
    c, s_ = np.cos(ang), np.sin(ang)
    rot = np.stack([d[:, 0] * c - d[:, 1] * s_, d[:, 0] * s_ + d[:, 1] * c], -1)
    out = pivot + rot * (1 + reach)[:, None]
    return out


def wave_sheet(name, start, end, base_z, peak_s, height, min_height, width, coll, n_s=180, tail=1.0, max_curl=1.0,
               finger_spacing=0.0, seed=1):
    """Sweep the breaker profile along a straight crest from `start` to `end`
    (x, y). The wave travels to the right of that line, so a ridge running
    away from the viewer on the left shows its curl in profile, as in the print.
    """
    curl = P.catmull_rom(CURL, PROFILE_N)
    swell = P.catmull_rom(SWELL, PROFILE_N)
    s = np.linspace(0, 1, n_s)
    a, b = np.array(start, float), np.array(end, float)
    along = (b - a) / np.linalg.norm(b - a)
    travel = np.array([along[1], -along[0]])  # right-hand side of the crest
    side_w = np.where(s < peak_s, width, width * tail)
    env = np.exp(-(((s - peak_s) / side_w) ** 2))
    H = min_height + (height - min_height) * env
    k = P.smoothstep(0.3, 0.92, env) * max_curl  # how far each slice has curled over
    length = float(np.linalg.norm(b - a))
    if finger_spacing > 0:
        finger, talon = finger_field(n_s, length, finger_spacing, seed)
    else:
        finger, talon = np.zeros(n_s), np.zeros(n_s)
    verts, uvs, lip = [], [], []
    t = np.linspace(0, 1, PROFILE_N)
    j = np.arange(PROFILE_N)
    fringe = P.smoothstep(TIP_I - 2, TIP_I, j) * (1 - P.smoothstep(TIP_I + 2, TIP_I + 4, j))
    finger_band = P.smoothstep(TIP_I - 5, TIP_I - 1, j) * (1 - P.smoothstep(TIP_I + 4, TIP_I + 9, j))
    for i in range(n_s):
        e = finger[i] * P.smoothstep(0.45, 0.9, k[i])
        prof = deform_lip(swell + (curl - swell) * k[i], e, talon[i])
        crest = a + (b - a) * s[i]
        u = prof[:, 0] * H[i] * 1.15
        v = prof[:, 1] * H[i]
        x = crest[0] + travel[0] * u
        y = crest[1] + travel[1] * u
        z = base_z + v
        verts.append(np.stack([x, y, z], -1))
        uvs.append(np.stack([np.full(PROFILE_N, s[i]), t], -1))
        lip.append(np.clip(k[i] * fringe * 0.8 + e * 1.2 * finger_band, 0, 1))
    verts = np.concatenate(verts)
    faces = P.grid_faces(n_s, PROFILE_N)
    obj = P.mesh_from_arrays(name, verts, faces, coll)
    P.add_uv(obj, np.concatenate(uvs))
    P.add_point_attribute(obj, "lip", np.concatenate(lip))
    P.add_point_attribute(obj, "curl", np.repeat(k, PROFILE_N))
    for p in obj.data.polygons:
        p.use_smooth = True
    mod = obj.modifiers.new("solid", "SOLIDIFY")
    mod.thickness = 0.12
    C.assign(obj, wave_material())
    C.set_mask(obj, (1, 0, 0))
    obj["line_group"] = "water"
    frame = {"a": a, "b": b, "travel": travel}
    return obj, (s, H, k, curl, swell, base_z, frame)


def _slice_point(params, i, j, offset=0.0):
    """World position of profile point j on slice i (offset along the crest)."""
    s, H, k, curl, swell, base_z, f = params
    prof = swell + (curl - swell) * k[i]
    u, v = prof[j] * np.array([H[i] * 1.15, H[i]])
    along = (f["b"] - f["a"]) / np.linalg.norm(f["b"] - f["a"])
    c = f["a"] + (f["b"] - f["a"]) * s[i] + along * offset
    return Vector((c[0] + f["travel"][0] * u, c[1] + f["travel"][1] * u, base_z + v))


def wave_material():
    """Prussian body streaked with light lines that run up the face; white
    foam with blue flecks on the crest and lip."""
    if "wave" in bpy.data.materials:
        return bpy.data.materials["wave"]
    mat, nt, out = C.new_material("wave")
    em = C.node(nt, "ShaderNodeEmission", 900, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    uv = C.node(nt, "ShaderNodeUVMap", -1100, 0)
    sep = C.node(nt, "ShaderNodeSeparateXYZ", -900, 0)
    nt.links.new(uv.outputs[0], sep.inputs[0])
    lip = C.node(nt, "ShaderNodeAttribute", -900, -300)
    lip.attribute_name = "lip"

    # body: deep → prussian up the profile
    ramp = C.node(nt, "ShaderNodeValToRGB", -500, 300)
    cr = ramp.color_ramp
    cr.interpolation = "LINEAR"
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*P.hex_to_linear(PRUSSIAN), 1)
    cr.elements[1].position = 0.45
    cr.elements[1].color = (*P.hex_to_linear(DEEP), 1)
    e = cr.elements.new(0.75)
    e.color = (*P.hex_to_linear(DEEP), 1)
    e = cr.elements.new(1.0)
    e.color = (*P.hex_to_linear(PRUSSIAN), 1)
    nt.links.new(sep.outputs["Y"], ramp.inputs["Fac"])

    # streaks across the sweep (constant s): light blue lines running up the wave
    noise = C.node(nt, "ShaderNodeTexNoise", -900, 200)
    noise.inputs["Scale"].default_value = 3.0
    noise.inputs["Detail"].default_value = 2.0
    nt.links.new(uv.outputs[0], noise.inputs["Vector"])
    wobble = C.node(nt, "ShaderNodeMath", -700, 200, operation="MULTIPLY_ADD")
    wobble.inputs[1].default_value = 0.02
    nt.links.new(noise.outputs["Fac"], wobble.inputs[0])
    nt.links.new(sep.outputs["X"], wobble.inputs[2])
    freq = C.node(nt, "ShaderNodeMath", -550, 200, operation="MULTIPLY")
    freq.inputs[1].default_value = 75.0
    nt.links.new(wobble.outputs[0], freq.inputs[0])
    fr = C.node(nt, "ShaderNodeMath", -400, 200, operation="FRACT")
    nt.links.new(freq.outputs[0], fr.inputs[0])
    streak = C.node(nt, "ShaderNodeMath", -250, 200, operation="LESS_THAN")
    streak.inputs[1].default_value = 0.11
    nt.links.new(fr.outputs[0], streak.inputs[0])
    col = C.mix_color(nt, ramp.outputs["Color"], P.hex_to_linear(MID), streak.outputs[0], x=0, y=300)

    # foam on the lip with blue flecks (Hokusai's "snow" of spray)
    vor = C.node(nt, "ShaderNodeTexVoronoi", -700, -500)
    vor.inputs["Scale"].default_value = 70.0
    nt.links.new(uv.outputs[0], vor.inputs["Vector"])
    fleck = C.node(nt, "ShaderNodeMath", -450, -500, operation="LESS_THAN")
    fleck.inputs[1].default_value = 0.17
    nt.links.new(vor.outputs["Distance"], fleck.inputs[0])
    fnoise = C.node(nt, "ShaderNodeTexNoise", -700, -300)
    fnoise.inputs["Scale"].default_value = 18.0
    fnoise.inputs["Detail"].default_value = 3.0
    nt.links.new(uv.outputs[0], fnoise.inputs["Vector"])
    fsum = C.node(nt, "ShaderNodeMath", -450, -300, operation="MULTIPLY_ADD")
    fsum.inputs[1].default_value = 0.5
    nt.links.new(fnoise.outputs["Fac"], fsum.inputs[0])
    nt.links.new(lip.outputs["Fac"], fsum.inputs[2])
    foam = C.node(nt, "ShaderNodeMath", -250, -300, operation="GREATER_THAN")
    foam.inputs[1].default_value = 0.78
    nt.links.new(fsum.outputs[0], foam.inputs[0])
    foam_col = C.mix_color(nt, P.hex_to_linear(FOAM), P.hex_to_linear(MID), fleck.outputs[0], x=0, y=-400)
    fstreak = C.node(nt, "ShaderNodeMath", -250, -650, operation="LESS_THAN")
    fstreak.inputs[1].default_value = 0.07
    nt.links.new(fr.outputs[0], fstreak.inputs[0])
    foam_col = C.mix_color(nt, foam_col, P.hex_to_linear(LIGHT), fstreak.outputs[0], x=150, y=-500)
    col = C.mix_color(nt, col, foam_col, foam.outputs[0], x=400, y=0)
    nt.links.new(col, em.inputs["Color"])
    return mat


def spray(name, params, coll, count=500):
    """Drops of spray thrown off the lip, like the falling "snow" in the print."""
    s, H, k, curl, swell, base_z, f = params
    travel = Vector((f["travel"][0], f["travel"][1], 0))
    bm = bmesh.new()
    peak = int(np.argmax(H))
    for _ in range(count):
        i = int(np.clip(rng.gauss(peak, len(s) * 0.1), 0, len(s) - 1))
        if k[i] < 0.3:
            continue
        j = rng.randint(CREST_I, TIP_I + 4)
        p = _slice_point(params, i, j, rng.uniform(-1.0, 1.0))
        p += travel * rng.uniform(0.5, 7.0) + Vector((0, 0, rng.uniform(-6, 1.5)))
        r = rng.uniform(0.05, 0.16) * (H[i] / 20)
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r, matrix=Matrix.Translation(p))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    C.assign(obj, P.flat("foam", FOAM))
    obj["line_group"] = "spray"
    # plain white drops, no outlines: leave them out of the line passes
    for kind in ("depth", "normal", "id"):
        obj[f"skip_{kind}"] = True
    return obj


# ─── Mount Fuji ───────────────────────────────────────────────────────────────

def fuji(coll, yaw_deg=9.0, dist=2300.0, height=380.0, radius=640.0):
    a = math.radians(yaw_deg)
    centre = Vector((math.sin(a) * dist, math.cos(a) * dist, -2.0))
    bm = bmesh.new()
    rings, seg = 26, 96
    verts = []
    for r_i in range(rings + 1):
        t = r_i / rings  # 0 at the top
        ring = []
        for j in range(seg):
            ang = 2 * math.pi * j / seg
            # concave flanks and a flat, slightly notched summit
            rad = radius * (t ** 1.55) + 26 * (1 - t) + 12 * math.sin(ang * 5 + 1.3) * t * (1 - t)
            z = height * (1 - t)
            ring.append(bm.verts.new(centre + Vector((math.cos(ang) * rad, math.sin(ang) * rad, z))))
        verts.append(ring)
    for r0, r1 in zip(verts, verts[1:]):
        for j in range(seg):
            bm.faces.new((r0[j], r0[(j + 1) % seg], r1[(j + 1) % seg], r1[j]))
    bm.faces.new(verts[0])
    mesh = bpy.data.meshes.new("fuji")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("fuji", mesh)
    coll.objects.link(obj)

    mat, nt, out = C.new_material("fuji")
    em = C.node(nt, "ShaderNodeEmission", 600, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    geo = C.node(nt, "ShaderNodeNewGeometry", -800, 0)
    sep = C.node(nt, "ShaderNodeSeparateXYZ", -600, 0)
    nt.links.new(geo.outputs["Position"], sep.inputs[0])
    noise = C.node(nt, "ShaderNodeTexNoise", -600, -250)
    noise.inputs["Scale"].default_value = 0.02
    noise.inputs["Detail"].default_value = 3.0
    nt.links.new(geo.outputs["Position"], noise.inputs["Vector"])
    zn = C.node(nt, "ShaderNodeMath", -350, 0, operation="MULTIPLY_ADD")
    zn.inputs[1].default_value = 70.0
    nt.links.new(noise.outputs["Fac"], zn.inputs[0])
    nt.links.new(sep.outputs["Z"], zn.inputs[2])
    snow = C.node(nt, "ShaderNodeMath", -150, 0, operation="GREATER_THAN")
    snow.inputs[1].default_value = height * 0.62 + 33
    nt.links.new(zn.outputs[0], snow.inputs[0])
    col = C.mix_color(nt, P.hex_to_linear(FUJI), P.hex_to_linear(SNOW), snow.outputs[0], x=200, y=0)
    nt.links.new(col, em.inputs["Color"])
    C.assign(obj, mat)
    return obj


# ─── Boats ────────────────────────────────────────────────────────────────────

def hull(name, length=13.0, beam=1.55, depth=0.75, coll=None):
    """Long, narrow open boat (oshiokuri-bune) with a raised, pointed bow."""
    bm = bmesh.new()
    n_l, n_c = 40, 12
    rings = []
    for i in range(n_l + 1):
        t = i / n_l  # 0 stern → 1 bow
        y = -length * 0.25 + length * t
        width = beam * (0.55 + 0.45 * math.sin(math.pi * min(1, t * 1.08)) ** 0.6) * (1 - 0.9 * max(0, t - 0.82) / 0.18)
        sheer = depth * (0.15 * (1 - t) ** 3 + 0.35 * max(0, t - 0.8) ** 2 * 25)
        ring = []
        for j in range(n_c + 1):
            a = math.pi * j / n_c  # 0 = port gunwale, π = starboard gunwale
            x = -math.cos(a) * width / 2
            z = -math.sin(a) ** 1.6 * depth + depth * 0.2 + sheer
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(n_c):
            bm.faces.new((r0[j], r0[j + 1], r1[j + 1], r1[j]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    # floorboards: a flat deck inside the hull, so no sea shows through
    floor_z = -depth * 0.32
    left, right = [], []
    for ring in rings[1:-3]:
        xs = [v.co.x for v in ring if v.co.z <= floor_z + 0.02]
        y = ring[0].co.y
        if len(xs) < 2:
            continue
        left.append(bm.verts.new((min(xs) * 0.98, y, floor_z)))
        right.append(bm.verts.new((max(xs) * 0.98, y, floor_z)))
    for i in range(len(left) - 1):
        bm.faces.new((left[i], right[i], right[i + 1], left[i + 1]))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    (coll or bpy.context.scene.collection).objects.link(obj)
    sol = obj.modifiers.new("solid", "SOLIDIFY")
    sol.thickness = 0.06
    mat, nt, out = C.new_material(f"{name}_mat")
    em = C.node(nt, "ShaderNodeEmission", 400, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    geo = C.node(nt, "ShaderNodeNewGeometry", -600, 0)
    lw = C.node(nt, "ShaderNodeLayerWeight", -600, -200)
    lw.inputs["Blend"].default_value = 0.35
    dark = C.node(nt, "ShaderNodeMath", -300, -100, operation="GREATER_THAN")
    dark.inputs[1].default_value = 0.55
    nt.links.new(lw.outputs["Facing"], dark.inputs[0])
    col = C.mix_color(nt, P.hex_to_linear(BOAT), P.hex_to_linear(BOAT_DARK), dark.outputs[0], x=150, y=0)
    # floorboards: thin dark seams running along the boat
    tc = C.node(nt, "ShaderNodeTexCoord", -800, -400)
    sep = C.node(nt, "ShaderNodeSeparateXYZ", -600, -400)
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    plank = C.node(nt, "ShaderNodeMath", -450, -400, operation="MULTIPLY")
    plank.inputs[1].default_value = 1 / 0.22
    nt.links.new(sep.outputs["X"], plank.inputs[0])
    fr = C.node(nt, "ShaderNodeMath", -300, -400, operation="FRACT")
    nt.links.new(plank.outputs[0], fr.inputs[0])
    seam = C.node(nt, "ShaderNodeMath", -150, -400, operation="LESS_THAN")
    seam.inputs[1].default_value = 0.06
    nt.links.new(fr.outputs[0], seam.inputs[0])
    nz = C.node(nt, "ShaderNodeSeparateXYZ", -450, -600)
    nt.links.new(geo.outputs["Normal"], nz.inputs[0])
    is_floor = C.node(nt, "ShaderNodeMath", -300, -600, operation="GREATER_THAN")
    is_floor.inputs[1].default_value = 0.85
    nt.links.new(nz.outputs["Z"], is_floor.inputs[0])
    seam_on = C.node(nt, "ShaderNodeMath", 0, -500, operation="MULTIPLY")
    nt.links.new(seam.outputs[0], seam_on.inputs[0])
    nt.links.new(is_floor.outputs[0], seam_on.inputs[1])
    col = C.mix_color(nt, col, P.hex_to_linear(BOAT_DARK), seam_on.outputs[0], x=300, y=-200)
    nt.links.new(col, em.inputs["Color"])
    C.assign(obj, mat)
    return obj


def rower(bm, at, facing, scale=1.0):
    """A crouched oarsman: hunched back, bowed head, oar over the side."""
    fwd = Vector((math.sin(facing), math.cos(facing), 0))
    side = Vector((math.cos(facing), -math.sin(facing), 0))
    turn = Matrix.Rotation(-facing, 4, "Z")
    # hips and a back bent low over the oar
    hips = at + Vector((0, 0, 0.2 * scale))
    m = Matrix.Translation(hips) @ turn @ Matrix.Diagonal((0.24 * scale, 0.22 * scale, 0.18 * scale, 1))
    bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=1.0, matrix=m)
    back = hips + fwd * 0.2 * scale + Vector((0, 0, 0.24 * scale))
    m = Matrix.Translation(back) @ turn @ Matrix.Rotation(math.radians(-48), 4, "X") @ Matrix.Diagonal((0.23 * scale, 0.17 * scale, 0.33 * scale, 1))
    bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=1.0, matrix=m)
    head = back + fwd * 0.3 * scale + Vector((0, 0, 0.1 * scale))
    bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.11 * scale, matrix=Matrix.Translation(head))
    # arms reaching forward to the oar
    for sgn in (-1, 1):
        a = back + side * sgn * 0.17 * scale + Vector((0, 0, 0.08 * scale))
        b = a + fwd * 0.42 * scale - Vector((0, 0, 0.22 * scale))
        d = b - a
        m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((0.055 * scale, 0.055 * scale, d.length / 2, 1))
        bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=1.0, matrix=m)
    return side


def boat(name, location, heading, pitch, roll, coll, rowers=6, first_rower=-1.0):
    obj = hull(name, coll=coll)
    obj.location = location
    obj.rotation_euler = (pitch, roll, -heading)
    bm = bmesh.new()
    bm_oars = bmesh.new()
    for i in range(rowers):
        y = first_rower + i * 1.5
        rower(bm, Vector((0.0, y, -0.15)), 0.0)
        sgn = 1 if i % 2 == 0 else -1
        a = Vector((sgn * 0.45, y + 0.1, 0.35))
        b = Vector((sgn * 2.6, y - 0.9, -0.55))
        mid = (a + b) / 2
        d = b - a
        m = Matrix.Translation(mid) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((0.035, 0.035, d.length / 2, 1))
        bmesh.ops.create_cone(bm_oars, cap_ends=True, segments=6, radius1=1, radius2=1, depth=2, matrix=m)
    for b_, n_, col in ((bm, "crew", CLOTH), (bm_oars, "oars", BOAT_DARK)):
        mesh = bpy.data.meshes.new(f"{name}_{n_}")
        b_.to_mesh(mesh)
        b_.free()
        o = bpy.data.objects.new(f"{name}_{n_}", mesh)
        coll.objects.link(o)
        o.parent = obj
        for p in o.data.polygons:
            p.use_smooth = True
        C.assign(o, P.flat(n_, col))
    return obj


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    scene = C.clear_scene()
    P.setup_render(scene, samples=24 if preview else 64)
    sea_c = C.collection("Sea")
    wave_c = C.collection("Waves")
    boat_c = C.collection("Boats")
    far_c = C.collection("Far")

    P.sky_world(
        scene,
        [(0.0, HORIZON), (0.07, "#b9b19c"), (0.2, PAPER), (0.75, "#e3d6b8"), (1.0, "#d2c39f")],
        clouds={"color": "#f2ead6", "scale": 2.4, "cover": 0.56, "low": 0.08, "high": 0.4},
    )

    build_sea(sea_c)

    trough = sea_height_at(0.0, 0.0)
    floor = trough + 0.05  # the floorboards of our boat, just above the water

    # the great wave: a ridge on the left running away from us, travelling to
    # the right, so its curl reads in profile when we look forward-left
    params = None
    obj, params = wave_sheet("great_wave", (-31, -45), (-31, 130), base_z=trough - 1.2, peak_s=0.42,
                             height=28, min_height=3.0, width=0.16, tail=1.5, coll=wave_c,
                             n_s=1400, finger_spacing=1.5, seed=3)
    n = 0
    spray("great_wave_spray", params, wave_c)

    # the small wave in the foreground that echoes the shape of Fuji
    _, p2 = wave_sheet("small_wave", (-9, 18), (-2, 52), base_z=trough - 0.5, peak_s=0.5,
                       height=6.0, min_height=1.0, width=0.22, coll=wave_c, n_s=500, finger_spacing=0.45, seed=5)

    # a broad swell behind and to the right, so the trough feels enclosed
    wave_sheet("rear_swell", (40, -10), (-20, -60), base_z=trough - 1.0, peak_s=0.5,
               height=8.0, min_height=3.0, width=0.35, coll=wave_c, n_s=90, max_curl=0.0)

    fuji(far_c)

    # our boat: we sit at the stern, the crew in front of us
    # We sit near the bow; the crew rows behind us. (The hull runs from
    # 3.25 m behind its origin to 9.75 m ahead of it.)
    boat("our_boat", Vector((0, -8.4, floor + 0.35)), 0.0, 0.0, math.radians(-1.5), boat_c, rowers=5, first_rower=-1.6)
    # two more boats: one climbing into the hollow of the great wave, one ahead
    boat("boat_left", Vector((-18, 26, sea_height_at(-18, 26) + 0.2)), math.radians(-14), math.radians(18), math.radians(-14), boat_c, rowers=7)
    boat("boat_right", Vector((13, 30, sea_height_at(13, 30) + 0.2)), math.radians(24), math.radians(-5), math.radians(6), boat_c, rowers=7)

    C.pano_camera(floor + 0.95)
    C.set_resolution(1024 if preview else 8192)
    print(f"trough {trough:.2f}, claws {n}")
    return scene


if __name__ == "__main__":
    build()
