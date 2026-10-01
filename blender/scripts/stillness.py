"""Room III — Stillness. Inside Monet's "Water Lily Pond" (1900).

The viewer stands on a small landing at the edge of the pond at Giverny. A
green Japanese footbridge arches across the water ahead; lily pads crowd the
surface; weeping willows hang their curtains on every side; irises, grasses
and flowering shrubs fill the banks. Rendered with real light, then turned
into paint with an anisotropic Kuwahara filter (scripts/looks.py).

Mask pass
  R  open water (ripples)      G  sky
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C
import instancing as I

rng = random.Random(9)
nrng = np.random.default_rng(9)

WATER_Z = 0.0
BANK_Z = 0.32
BRIDGE_Y = 13.0
BRIDGE_HALF = 6.2
SUN_AZIMUTH = math.radians(215)   # behind the viewer, to the left
SUN_ELEVATION = math.radians(38)

# The pond: a smooth union of ellipses (centre x, centre y, radius x, radius y)
POND = [
    (0.0, 7.6, 15.5, 7.3),   # front lobe; its near edge is at our feet
    (0.0, 13.0, 5.7, 4.2),   # the narrows under the bridge
    (1.0, 20.0, 13.5, 6.5),  # back lobe behind the bridge
    (14.0, 4.5, 7.5, 4.0),   # an arm to the right
    (-15.0, 10.0, 6.0, 5.0), # an arm to the left
]


def pond_sdf(x, y):
    """Negative inside the pond (in units of the nearest ellipse's size)."""
    d = np.full(np.shape(x), 9.0)
    for cx, cy, rx, ry in POND:
        e = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) - 1.0
        # smooth minimum keeps the shoreline round where lobes meet
        k = 0.25
        h = np.clip(0.5 + 0.5 * (e - d) / k, 0, 1)
        d = e * (1 - h) + d * h - k * h * (1 - h)
    return d


def in_pond(x, y, margin=0.0):
    return pond_sdf(np.array(x), np.array(y)) < -margin


# ─── Helpers ──────────────────────────────────────────────────────────────────

def principled_mat(name, color, roughness=0.5, specular=0.5, translucent=0.0, attr=None, attr_dark=None):
    """Principled material; with attr, colour varies by a 0..1 attribute."""
    mat, nt, out = C.new_material(name)
    bsdf = C.principled(nt)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = specular
    if attr:
        a = C.node(nt, "ShaderNodeAttribute", -500, 100)
        a.attribute_name = attr
        col = C.mix_color(nt, attr_dark, color, a.outputs["Fac"], x=-200, y=100)
        nt.links.new(col, bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
    if translucent > 0:
        trans = C.node(nt, "ShaderNodeBsdfTranslucent", 200, -250)
        if attr:
            nt.links.new(col, trans.inputs["Color"])
        else:
            trans.inputs["Color"].default_value = (*color, 1)
        mix = C.node(nt, "ShaderNodeMixShader", 450, 0)
        mix.inputs[0].default_value = translucent
        nt.links.new(bsdf.outputs[0], mix.inputs[1])
        nt.links.new(trans.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs["Surface"])
    else:
        nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return mat


def obj_from_bm(name, bm, coll, mat=None, smooth=True):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    if mat:
        C.assign(obj, mat)
    return obj


def point_attr(obj, name, values):
    attr = obj.data.attributes.new(name, "FLOAT", "POINT")
    attr.data.foreach_set("value", np.asarray(values, np.float32))


def hair(name, strands, radii, coll, mat, tint=None):
    """Hair-curves object from a list of (n×3) point arrays of equal length."""
    n_pts = strands[0].shape[0]
    cv = bpy.data.hair_curves.new(name)
    cv.add_curves([n_pts] * len(strands))
    pos = np.concatenate(strands).astype(np.float32)
    cv.position_data.foreach_set("vector", pos.ravel())
    rad = cv.attributes.get("radius") or cv.attributes.new("radius", "FLOAT", "POINT")
    rad.data.foreach_set("value", np.asarray(radii, np.float32).ravel())
    if tint is not None:
        t = cv.attributes.new("tint", "FLOAT", "POINT")
        t.data.foreach_set("value", np.repeat(np.asarray(tint, np.float32), n_pts))
    obj = bpy.data.objects.new(name, cv)
    coll.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def beam(bm, a, b, w, h=None):
    h = h or w
    d = b - a
    m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((w, h, d.length, 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def dabs(centre, radius, height, count, size, squash=0.8, bias_up=0.0, leaves=False):
    """Leaf clusters filling an ellipsoid, denser towards its surface, like
    brush dabs. Returns (positions, scales, rotations) for instancing."""
    u = nrng.random(count) ** 0.35
    th = nrng.uniform(0, 2 * math.pi, count)
    ph = np.arccos(nrng.uniform(-1, 1, count))
    pos = np.stack([
        centre[0] + radius * u * np.sin(ph) * np.cos(th),
        centre[1] + radius * u * np.sin(ph) * np.sin(th),
        centre[2] + height * (u * np.cos(ph) * 0.5 + bias_up),
    ], 1)
    r = size * nrng.uniform(0.6, 1.4, count)
    if leaves:
        scales = np.stack([r, r, r], 1)
        rots = I.random_rotations(count, nrng)
    else:
        scales = np.stack([r, r * nrng.uniform(0.7, 1.2, count), r * squash], 1)
        rots = I.rot_z(nrng.uniform(0, 2 * math.pi, count))
    return pos, scales, rots


class Dabs:
    """Accumulates dab clouds, then builds them as one mesh."""

    def __init__(self):
        self.parts = []

    def add(self, *args, **kwargs):
        self.parts.append(dabs(*args, **kwargs))

    def build(self, name, coll, mat, kind="leaf", tint=True):
        if not self.parts:
            return None
        pos = np.concatenate([p[0] for p in self.parts])
        sc = np.concatenate([p[1] for p in self.parts])
        rot = np.concatenate([p[2] for p in self.parts])
        attrs = {"tint": nrng.random(len(pos))} if tint else None
        obj = I.build(name, kind, pos, sc, rot, coll, attrs)
        C.assign(obj, mat)
        return obj


# ─── Ground and water ─────────────────────────────────────────────────────────

def build_ground(coll):
    n = 360
    xs = np.linspace(-70, 70, n)
    ys = np.linspace(-60, 80, n)
    X, Y = np.meshgrid(xs, ys, indexing="ij")
    d = pond_sdf(X, Y)
    bank = 1 - np.clip(-d * 6, 0, 1)            # 1 on land, 0 a little inside the pond
    noise = np.sin(X * 0.21) * np.cos(Y * 0.17) * 0.12 + np.sin(X * 0.05 + 1) * np.cos(Y * 0.07) * 0.25
    Z = np.where(d < 0, -0.6 + bank * (BANK_Z + 0.6), BANK_Z + np.clip(d, 0, 2) * 0.15 + noise * np.clip(d * 0.5, 0, 1))
    verts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1)
    import printmaking as P
    faces = P.grid_faces(n, n)
    obj = P.mesh_from_arrays("ground", verts, faces, coll)
    for p in obj.data.polygons:
        p.use_smooth = True
    point_attr(obj, "shore", np.clip(1 - d.ravel() * 3, 0, 1))
    mat, nt, out = C.new_material("ground")
    bsdf = C.principled(nt)
    bsdf.inputs["Roughness"].default_value = 0.9
    a = C.node(nt, "ShaderNodeAttribute", -800, 200)
    a.attribute_name = "shore"
    noise_t = C.node(nt, "ShaderNodeTexNoise", -800, -100)
    noise_t.inputs["Scale"].default_value = 0.8
    noise_t.inputs["Detail"].default_value = 6
    grass = C.mix_color(nt, (0.06, 0.17, 0.07), (0.36, 0.42, 0.08), noise_t.outputs["Fac"], x=-500, y=0)
    col = C.mix_color(nt, grass, (0.10, 0.08, 0.04), a.outputs["Fac"], x=-250, y=100)
    nt.links.new(col, bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    C.assign(obj, mat)
    return obj


def build_water(coll):
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    obj = obj_from_bm("pond", bm, coll, smooth=False)
    obj.location = (0, 10, WATER_Z)
    mat, nt, out = C.new_material("pond")
    bsdf = C.principled(nt)
    bsdf.inputs["Base Color"].default_value = (0.012, 0.03, 0.026, 1)
    bsdf.inputs["Roughness"].default_value = 0.025
    bsdf.inputs["Specular IOR Level"].default_value = 0.6
    noise = C.node(nt, "ShaderNodeTexNoise", -600, -300)
    noise.inputs["Scale"].default_value = 3.0
    bump = C.node(nt, "ShaderNodeBump", -300, -300)
    bump.inputs["Strength"].default_value = 0.04
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    C.assign(obj, mat)
    C.set_mask(obj, (1, 0, 0))
    return obj


def build_landing(coll):
    """The little timber landing we stand on."""
    bm = bmesh.new()
    for i in range(9):
        x = -1.2 + i * 0.3
        beam(bm, Vector((x, -1.8, BANK_Z + 0.1)), Vector((x, 0.7, BANK_Z + 0.1)), 0.27, 0.06)
    for x in (-1.25, 1.25):
        for y in (-1.6, 0.6):
            beam(bm, Vector((x, y, -0.5)), Vector((x, y, BANK_Z + 0.08)), 0.12)
    mat = principled_mat("landing", (0.2, 0.11, 0.05), roughness=0.9, specular=0.25)
    return obj_from_bm("landing", bm, coll, mat, smooth=False)


# ─── Lilies ───────────────────────────────────────────────────────────────────

def build_lilies(coll):
    pads_v, pads_f, tint = [], [], []
    petals = {"pink": ([], []), "white": ([], [])}
    # clusters drift across the pond in loose horizontal bands, as in the painting
    clusters = []
    for _ in range(170):
        x = nrng.uniform(-24, 24)
        y = nrng.uniform(1.0, 27)
        band = math.sin(y * 0.9) * 0.5 + 0.5
        if not in_pond(x, y, 0.12) or rng.random() > 0.45 + 0.55 * band:
            continue
        if abs(y - BRIDGE_Y) < 1.0 and abs(x) < BRIDGE_HALF:
            continue
        clusters.append((x, y, nrng.uniform(0.8, 2.6)))
    seg = 18
    for cx, cy, cr in clusters:
        count = int(cr * cr * 9)
        for _ in range(count):
            a = rng.uniform(0, 2 * math.pi)
            rr = cr * math.sqrt(rng.random())
            x, y = cx + math.cos(a) * rr * 1.6, cy + math.sin(a) * rr * 0.8
            if not in_pond(x, y, 0.06):
                continue
            r = rng.uniform(0.11, 0.3)
            notch = rng.uniform(0, 2 * math.pi)
            base = len(pads_v)
            pads_v.append((x, y, WATER_Z + 0.006 + rng.uniform(0, 0.004)))
            for k in range(seg + 1):
                ang = notch + 0.35 + (2 * math.pi - 0.7) * k / seg
                pads_v.append((x + math.cos(ang) * r, y + math.sin(ang) * r, WATER_Z + 0.004))
            for k in range(seg):
                pads_f.append((base, base + 1 + k, base + 2 + k))
            t = rng.random()
            tint.extend([t] * (seg + 2))
            if rng.random() < 0.075:
                starts, ends = petals["pink" if rng.random() < 0.6 else "white"]
                fr = r * rng.uniform(0.35, 0.5)
                # a cup of pointed petals
                for k in range(8):
                    ang = k / 8 * 2 * math.pi + rng.uniform(-0.2, 0.2)
                    starts.append((x, y, WATER_Z + 0.02))
                    ends.append((x + math.cos(ang) * fr, y + math.sin(ang) * fr, WATER_Z + fr * 0.9))
    mesh = bpy.data.meshes.new("lily_pads")
    mesh.from_pydata(pads_v, [], pads_f)
    mesh.update()
    pads = bpy.data.objects.new("lily_pads", mesh)
    coll.objects.link(pads)
    point_attr(pads, "tint", tint)
    pad_mat = principled_mat("lily_pad", (0.22, 0.34, 0.07), roughness=0.38, specular=0.6, attr="tint", attr_dark=(0.05, 0.16, 0.06))
    C.assign(pads, pad_mat)
    for key, col in (("pink", (0.85, 0.36, 0.48)), ("white", (0.86, 0.8, 0.7))):
        starts, ends = petals[key]
        if starts:
            fl = I.beams(f"lilies_{key}", starts, ends, [0.05] * len(starts), [0.014] * len(starts), coll)
            C.assign(fl, principled_mat(f"lily_{key}", col, roughness=0.5, translucent=0.3))
    return pads


# ─── The Japanese bridge ──────────────────────────────────────────────────────

def bridge_z(x):
    return 0.85 + 1.25 * (1 - (x / BRIDGE_HALF) ** 2)


def build_bridge(coll):
    bm = bmesh.new()
    xs = np.linspace(-BRIDGE_HALF, BRIDGE_HALF, 40)
    w = 0.85
    # deck planks across the arch
    for x in np.arange(-BRIDGE_HALF, BRIDGE_HALF, 0.17):
        z = bridge_z(x)
        beam(bm, Vector((x, BRIDGE_Y - w, z)), Vector((x, BRIDGE_Y + w, z)), 0.15, 0.06)
    for side in (-1, 1):
        y = BRIDGE_Y + side * (w + 0.02)
        prev = None
        for x in xs:
            z = bridge_z(x)
            p = Vector((x, y, z))
            if prev is not None:
                beam(bm, prev - Vector((0, 0, 0.12)), p - Vector((0, 0, 0.12)), 0.1, 0.24)        # stringer
                beam(bm, prev + Vector((0, 0, 0.92)), p + Vector((0, 0, 0.92)), 0.08, 0.07)       # handrail
                beam(bm, prev + Vector((0, 0, 0.5)), p + Vector((0, 0, 0.5)), 0.05, 0.05)         # mid rail
            prev = p
        for x in np.arange(-BRIDGE_HALF, BRIDGE_HALF + 0.01, 0.82):
            z = bridge_z(x)
            beam(bm, Vector((x, y, z - 0.05)), Vector((x, y, z + 0.95)), 0.075)                  # posts
    # piers standing in the water
    for x in (-BRIDGE_HALF + 0.4, -2.2, 2.2, BRIDGE_HALF - 0.4):
        for side in (-1, 1):
            y = BRIDGE_Y + side * (w - 0.1)
            beam(bm, Vector((x, y, -0.6)), Vector((x, y, bridge_z(x) - 0.1)), 0.14)
        beam(bm, Vector((x, BRIDGE_Y - w, bridge_z(x) - 0.25)), Vector((x, BRIDGE_Y + w, bridge_z(x) - 0.25)), 0.14)
    mat = principled_mat("bridge_green", (0.11, 0.27, 0.16), roughness=0.55)
    return obj_from_bm("bridge", bm, coll, mat, smooth=False)


# ─── Willows, trees, shrubs and the banks ─────────────────────────────────────

def build_willow(coll, base, height=8.5, crown=5.5, strands=3200, lean=(0.0, 0.0), dabs_out=None):
    """A weeping willow: a short trunk, a crown of branch clusters, and long
    hanging strands with an uneven hem that falls almost to the water."""
    bm = bmesh.new()
    top = base + Vector((lean[0], lean[1], height * 0.62))
    beam(bm, base, top, 0.55)
    clusters = []
    for _ in range(rng.randint(28, 36)):
        a = rng.uniform(0, 2 * math.pi)
        r = crown * math.sqrt(rng.uniform(0.05, 1.0))
        c = base + Vector((lean[0] + math.cos(a) * r, lean[1] + math.sin(a) * r,
                           height * (0.66 + 0.34 * (1 - (r / crown) ** 2)) + rng.uniform(-0.6, 0.5)))
        clusters.append((c, rng.uniform(0.8, 1.6), rng.uniform(0.5, 1.0)))
        if rng.random() < 0.35:
            beam(bm, top, c, 0.12)
    obj_from_bm("willow_trunk", bm, coll, principled_mat("bark", (0.12, 0.1, 0.08), roughness=0.9))
    wind = Vector((0.35, 0.15, 0))
    lines, radii, tints = [], [], []
    n_pts = 12
    for k in range(strands):
        c, cr, reach = clusters[k % len(clusters)]
        a = rng.uniform(0, 2 * math.pi)
        rr = cr * math.sqrt(rng.random())
        start = c + Vector((math.cos(a) * rr, math.sin(a) * rr, rng.uniform(-0.4, 0.5) - rr * 0.25))
        length = reach * rng.uniform(0.45, 1.0) * (start.z - WATER_Z - 0.05)
        out = (start - base).normalized() * rng.uniform(0.3, 1.0)
        out.z = 0
        pts = []
        for i in range(n_pts):
            t = i / (n_pts - 1)
            p = start + out * math.sin(t * 1.5) * 0.9 + wind * t * t + Vector((0, 0, -length * t))
            pts.append(tuple(p))
        lines.append(np.array(pts))
        radii.append(np.linspace(0.045, 0.018, n_pts))
        tints.append(rng.random())
    if dabs_out is not None:
        for c, cr, _ in clusters:
            dabs_out.add(tuple(c), cr * 1.2, cr * 0.8, int(cr * cr * 500), 0.1, bias_up=0.15, leaves=True)
    mat = principled_mat("willow", (0.36, 0.48, 0.12), roughness=0.6, translucent=0.35, attr="tint", attr_dark=(0.07, 0.18, 0.05))
    return hair("willow_leaves", lines, radii, coll, mat, tint=tints)


def build_reeds(coll, count=9000):
    """Irises, rushes and long grass along the shore."""
    lines, radii, tints = [], [], []
    flowers = []
    n_pts = 6
    placed = 0
    while placed < count:
        x = nrng.uniform(-28, 30)
        y = nrng.uniform(-6, 30)
        d = float(pond_sdf(np.array(x), np.array(y)))
        if not (-0.08 < d < 0.22):
            continue
        if math.hypot(x, y + 0.5) < 2.4:
            continue  # keep the landing clear
        if abs(y - BRIDGE_Y) < 1.3 and abs(x) < BRIDGE_HALF + 1:
            continue
        h = rng.uniform(0.5, 1.5) * (1.3 if d < 0.05 else 1.0)
        lean = Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0))
        base = Vector((x, y, BANK_Z - 0.1))
        pts = [tuple(base + lean * (t * t) * h + Vector((0, 0, h * t))) for t in np.linspace(0, 1, n_pts)]
        lines.append(np.array(pts))
        radii.append(np.linspace(0.02, 0.004, n_pts))
        tints.append(rng.random())
        if rng.random() < 0.06:
            flowers.append(pts[-1])
        placed += 1
    mat = principled_mat("reeds", (0.42, 0.5, 0.16), roughness=0.6, translucent=0.25, attr="tint", attr_dark=(0.12, 0.24, 0.06))
    hair("reeds", lines, radii, coll, mat, tint=tints)
    if flowers:
        fl = I.build("irises", "ico", np.array(flowers), np.tile([0.035, 0.035, 0.06], (len(flowers), 1)), None, coll)
        C.assign(fl, principled_mat("iris", (0.36, 0.22, 0.6), roughness=0.5, translucent=0.3))


def build_shrubs(coll):
    """Masses of foliage and flowers that ring the pond and fill the garden."""
    green, pink, red = Dabs(), Dabs(), Dabs()
    for _ in range(160):
        x = rng.uniform(-40, 40)
        y = rng.uniform(-30, 45)
        d = float(pond_sdf(np.array(x), np.array(y)))
        if d < 0.25 or math.hypot(x, y) < 7.0:
            continue
        size = rng.uniform(1.0, 2.6) * (1 + min(d, 3) * 0.3)
        green.add((x, y, BANK_Z), size, size * rng.uniform(1.0, 1.7), int(size * size * 700), 0.09, bias_up=0.6, leaves=True)
        if rng.random() < 0.35:
            (pink if rng.random() < 0.6 else red).add((x, y, BANK_Z + size * 0.5), size * 0.9, size * 0.9, int(size * size * 40), 0.07, bias_up=0.6)
    green.build("shrubs", coll, principled_mat("shrub", (0.3, 0.45, 0.1), roughness=0.6, translucent=0.2, attr="tint", attr_dark=(0.04, 0.13, 0.05)))
    pink.build("blossom_pink", coll, principled_mat("blossom_pink", (0.85, 0.42, 0.55), roughness=0.6, translucent=0.2), kind="ico0", tint=False)
    red.build("blossom_red", coll, principled_mat("blossom_red", (0.7, 0.12, 0.12), roughness=0.6, translucent=0.2), kind="ico0", tint=False)


def build_trees(coll):
    """Tall trees beyond the pond: trunks and broad canopies of leaf dabs."""
    starts, ends, widths = [], [], []
    canopy = Dabs()
    for _ in range(46):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(26, 48)
        x, y = math.cos(a) * r, 10 + math.sin(a) * r * 0.9
        h = rng.uniform(11, 19)
        starts.append((x, y, BANK_Z))
        ends.append((x, y, h * 0.6))
        widths.append(0.5)
        canopy.add((x, y, h * 0.72), h * 0.42, h * 0.5, 9000, 0.32, leaves=True)
    tr = I.beams("tree_trunks", starts, ends, widths, coll=coll)
    C.assign(tr, principled_mat("trunk", (0.1, 0.09, 0.07), roughness=0.9))
    canopy.build("tree_canopy", coll, principled_mat("canopy", (0.26, 0.4, 0.1), roughness=0.6, translucent=0.2, attr="tint", attr_dark=(0.03, 0.1, 0.05)))


# ─── Sky and light ────────────────────────────────────────────────────────────

def build_sky(scene):
    world = scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = C.node(nt, "ShaderNodeOutputWorld", 900, 0)
    bg = C.node(nt, "ShaderNodeBackground", 700, 0)
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    sky = C.node(nt, "ShaderNodeTexSky", 0, 0)
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_disc = False
    sky.sun_elevation = SUN_ELEVATION
    sky.sun_rotation = SUN_AZIMUTH
    sky.air_density = 1.2
    sky.aerosol_density = 1.2
    # soft summer clouds over the top
    coord = C.node(nt, "ShaderNodeTexCoord", -600, -300)
    mp = C.node(nt, "ShaderNodeMapping", -400, -300)
    mp.inputs["Scale"].default_value = (1, 1, 2.5)
    nt.links.new(coord.outputs["Generated"], mp.inputs["Vector"])
    noise = C.node(nt, "ShaderNodeTexNoise", -200, -300)
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 5
    nt.links.new(mp.outputs[0], noise.inputs["Vector"])
    cover = C.node(nt, "ShaderNodeMapRange", 0, -300)
    cover.inputs["From Min"].default_value = 0.5
    cover.inputs["From Max"].default_value = 0.68
    nt.links.new(noise.outputs["Fac"], cover.inputs["Value"])
    lit = C.node(nt, "ShaderNodeMath", 150, -300, operation="MULTIPLY")
    lit.inputs[1].default_value = 0.75
    nt.links.new(cover.outputs["Result"], lit.inputs[0])
    col = C.mix_color(nt, sky.outputs["Color"], (1.6, 1.58, 1.52), lit.outputs[0], x=300, y=0)
    nt.links.new(col, bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.55

    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 6.0
    sun.angle = math.radians(1.2)
    sun.color = (1.0, 0.93, 0.82)
    obj = bpy.data.objects.new("sun", sun)
    d = Vector((math.sin(SUN_AZIMUTH) * math.cos(SUN_ELEVATION), math.cos(SUN_AZIMUTH) * math.cos(SUN_ELEVATION), math.sin(SUN_ELEVATION)))
    obj.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(obj)


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    scene = C.clear_scene()
    C.use_gpu(scene)
    garden = C.collection("Garden")
    pond = C.collection("Pond")
    build_sky(scene)
    build_ground(garden)
    build_water(pond)
    build_landing(garden)
    build_lilies(pond)
    build_bridge(pond)
    crowns = Dabs()
    build_willow(garden, Vector((-8.0, 18.5, BANK_Z)), height=9.5, crown=6.0, strands=5200, lean=(0.6, -0.4), dabs_out=crowns)
    build_willow(garden, Vector((7.5, 19.5, BANK_Z)), height=10.5, crown=6.5, strands=5600, lean=(-0.5, -0.6), dabs_out=crowns)
    build_willow(garden, Vector((-15.5, 4.0, BANK_Z)), height=9.0, crown=5.5, strands=4400, lean=(0.8, 0.3), dabs_out=crowns)
    build_willow(garden, Vector((17.0, 11.0, BANK_Z)), height=9.0, crown=5.0, strands=4000, lean=(-0.7, 0.0), dabs_out=crowns)
    crowns.build("willow_crowns", garden, principled_mat("willow_crown", (0.34, 0.46, 0.12), roughness=0.6, translucent=0.3, attr="tint", attr_dark=(0.06, 0.16, 0.05)))
    build_reeds(garden)
    build_shrubs(garden)
    build_trees(garden)

    cy = scene.cycles
    cy.samples = 128 if preview else 512
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.02
    cy.use_denoising = True
    cy.max_bounces = 6
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 3
    cy.transmission_bounces = 4
    cy.transparent_max_bounces = 8
    cy.sample_clamp_indirect = 6.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    scene.cycles_curves.shape = "RIBBONS"
    C.set_view_transform("AgX", "AgX - Punchy", exposure=0.2)
    C.pano_camera(BANK_Z + 0.16 + 1.6)
    bpy.context.scene.camera.location.y = -0.4
    C.set_resolution(1024 if preview else 8192)
    return scene


if __name__ == "__main__":
    build()
