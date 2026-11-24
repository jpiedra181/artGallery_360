"""Room II — Rain. Inside Hiroshige's "Sudden Shower over Shin-Ōhashi Bridge
and Atake".

The print looks down on the bridge, so the viewer does too: from the open
platform of a fire watch on the near bank, with the bridge crossing from the
lower left to the upper right, the turquoise river going to deep blue under
it, the far bank a single dark silhouette and black cloud wiped in above.
Flat woodblock colours (emission only).

This is the plate. The railings, the people hurrying over the deck and the
raft are drawn live over it, because they move, and the rain falls live too
(src/scripts/worlds/sudden-shower.ts, which repeats the layout constants).

Mask pass
  R  river (rain rings)      G  sky      B  our platform, in front of the drawing
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C
import printmaking as P

# Palette read from the print (sRGB), a little fresher than the aged sheet
SKY_LOW, SKY, CLOUD, BLACK = "#5f7f8c", "#4d6a7c", "#33434f", "#1b1d21"
SHORE, SHORE_BACK, SHORE_FAR = "#34495a", "#3f5768", "#4c6879"
RIVER_FAR, RIVER, RIVER_LOW, RIVER_DEEP = "#86b5a8", "#7cb3a4", "#5c9a9b", "#1f466b"
DECK, DECK_SIDE = "#eec78b", "#d8a878"
PILE, PILE_DARK = "#897d6d", "#6f6558"
GROUND, GROUND_WET = "#a3977a", "#8f8a70"
TILE, TILE_LIGHT, THATCH, WALL, PAPER = "#566873", "#6b7f88", "#a98f5f", "#a89878", "#efe0bd"
TIMBER, TIMBER_DARK = "#d6b585", "#a3845c"
INK = "#24272c"

# ── layout (metres; the eye is over the origin, the water at z = 0) ──
EYE = 22.0
ALONG = (0.848, 0.530)            # the way the bridge runs
START = (-9.0, 22.0)              # its centre line at s = 0
DECK_W = 6.4
S0, S1 = -21.0, 131.0             # where it meets the banks
FLOW = (0.871, -0.491)            # along the river
NORMAL = (0.491, 0.871)           # across it, towards the far bank
NEAR, FAR = -3.5, 129.0           # the two shores, measured along NORMAL

rng = random.Random(57)
nrng = np.random.default_rng(57)


def deck_z(s):
    return 5.6 + 3.2 * (1 - ((s - 55.0) / 78.0) ** 2)


def on_bridge(s, t, z=0.0):
    """Point of the bridge: s along, t across (positive towards us), z above the deck."""
    return Vector((START[0] + ALONG[0] * s + ALONG[1] * t, START[1] + ALONG[1] * s - ALONG[0] * t, deck_z(s) + z))


def shore(f, n, z=0.0):
    """Point by the river: f along it, n across it."""
    return Vector((FLOW[0] * f + NORMAL[0] * n, FLOW[1] * f + NORMAL[1] * n, z))


def fogged(name, color_hex, fog_hex=SKY_LOW, near=90.0, far=700.0, amount=0.75):
    """Flat colour that goes into the wet air with distance."""
    mat, nt, out = C.new_material(name)
    em = C.node(nt, "ShaderNodeEmission", 400, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    lp = C.node(nt, "ShaderNodeLightPath", -400, -200)
    mr = C.node(nt, "ShaderNodeMapRange", -200, -200)
    mr.inputs["From Min"].default_value = near
    mr.inputs["From Max"].default_value = far
    mr.inputs["To Max"].default_value = amount
    mr.interpolation_type = "SMOOTHSTEP"
    nt.links.new(lp.outputs["Ray Length"], mr.inputs["Value"])
    col = C.mix_color(nt, P.hex_to_linear(color_hex), P.hex_to_linear(fog_hex), mr.outputs["Result"], x=100, y=0)
    nt.links.new(col, em.inputs["Color"])
    return mat


def obj_from_bm(name, bm, coll, mat, group=None, lines=True):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    C.assign(obj, mat)
    if group:
        obj["line_group"] = group
    if not lines:
        no_lines(obj)
    return obj


def no_lines(obj):
    """Printed from a colour block alone: no key line round it."""
    for kind in ("normal", "id", "depth"):
        obj[f"skip_{kind}"] = True


def beam(bm, a, b, w, h=None):
    h = h or w
    d = b - a
    m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((w, h, d.length, 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


# ─── Sky ──────────────────────────────────────────────────────────────────────

def build_sky(scene):
    """Prussian blue, and the black cloud wiped in from the top with a ragged
    lower edge (bokashi: the block is inked unevenly by hand)."""
    world = scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = C.node(nt, "ShaderNodeOutputWorld", 900, 0)
    bg = C.node(nt, "ShaderNodeBackground", 700, 0)
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    coord = C.node(nt, "ShaderNodeTexCoord", -1100, 0)
    sep = C.node(nt, "ShaderNodeSeparateXYZ", -900, 0)
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    # lobes hanging from the cloud: noise over the bearing, stretched downwards
    mp = C.node(nt, "ShaderNodeMapping", -900, -300)
    mp.inputs["Scale"].default_value = (2.6, 2.6, 0.9)
    nt.links.new(coord.outputs["Generated"], mp.inputs["Vector"])
    noise = C.node(nt, "ShaderNodeTexNoise", -700, -300)
    noise.inputs["Scale"].default_value = 1.0
    noise.inputs["Detail"].default_value = 2.2
    noise.inputs["Roughness"].default_value = 0.42
    nt.links.new(mp.outputs[0], noise.inputs["Vector"])
    push = C.node(nt, "ShaderNodeMath", -500, -200, operation="MULTIPLY_ADD")
    push.inputs[1].default_value = 0.78
    nt.links.new(noise.outputs["Fac"], push.inputs[0])
    nt.links.new(sep.outputs["Z"], push.inputs[2])
    ramp = C.node(nt, "ShaderNodeValToRGB", -250, 0)
    cr = ramp.color_ramp
    cr.interpolation = "EASE"
    stops = [(0.22, SKY_LOW), (0.38, SKY), (0.56, SKY), (0.66, CLOUD), (0.73, "#22272c"), (0.86, BLACK)]
    while len(cr.elements) > 1:
        cr.elements.remove(cr.elements[-1])
    for i, (pos, hx) in enumerate(stops):
        el = cr.elements[0] if i == 0 else cr.elements.new(pos)
        el.position = pos
        el.color = (*P.hex_to_linear(hx), 1)
    nt.links.new(push.outputs[0], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])


# ─── River and banks ──────────────────────────────────────────────────────────

def build_river(coll):
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=2, y_segments=2, size=2200)
    water = obj_from_bm("river", bm, coll, None, "river")
    mat, nt, out = C.new_material("river")
    em = C.node(nt, "ShaderNodeEmission", 600, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    lp = C.node(nt, "ShaderNodeLightPath", -700, 0)
    # graded wipes: deep blue under the bridge and below us, turquoise, pale towards the far shore.
    # The wipe is level on the sheet, so it follows how far down one looks: the length of the ray.
    geo = C.node(nt, "ShaderNodeNewGeometry", -1000, -300)
    noise = C.node(nt, "ShaderNodeTexNoise", -800, -300)
    noise.inputs["Scale"].default_value = 0.03
    noise.inputs["Detail"].default_value = 1.0
    nt.links.new(geo.outputs["Position"], noise.inputs["Vector"])
    ln = C.node(nt, "ShaderNodeMath", -500, 0, operation="LOGARITHM")
    ln.inputs[1].default_value = 10.0
    nt.links.new(lp.outputs["Ray Length"], ln.inputs[0])
    wob = C.node(nt, "ShaderNodeMath", -350, -100, operation="MULTIPLY_ADD")
    wob.inputs[1].default_value = 0.06
    nt.links.new(noise.outputs["Fac"], wob.inputs[0])
    nt.links.new(ln.outputs[0], wob.inputs[2])
    fac = C.node(nt, "ShaderNodeMapRange", -200, 0)
    fac.inputs["From Min"].default_value = math.log10(20)
    fac.inputs["From Max"].default_value = math.log10(700)
    nt.links.new(wob.outputs[0], fac.inputs["Value"])
    ramp = C.node(nt, "ShaderNodeValToRGB", 0, 0)
    cr = ramp.color_ramp
    cr.interpolation = "EASE"
    while len(cr.elements) > 1:
        cr.elements.remove(cr.elements[-1])
    pos = lambda d: (math.log10(d) - math.log10(20)) / (math.log10(700) - math.log10(20))
    for i, (d, hx) in enumerate([(24, RIVER_DEEP), (33, "#2f6584"), (46, RIVER_LOW), (66, RIVER), (135, RIVER_FAR), (260, "#7aa8a6"), (680, SKY)]):
        el = cr.elements[0] if i == 0 else cr.elements.new(pos(d))
        el.position = pos(d)
        el.color = (*P.hex_to_linear(hx), 1)
    nt.links.new(fac.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    C.assign(water, mat)
    C.set_mask(water, (1, 0, 0))


def lobes(x, seed, low, high, spacing):
    """Height of a mass of trees along x: overlapping rounded crowns."""
    r = np.random.default_rng(seed)
    h = np.full_like(x, low * 0.8)
    c = x.min() - 40
    while c < x.max() + 40:
        rad = spacing * r.uniform(0.7, 1.9)
        top = r.uniform(low, high) * (0.8 + 0.35 * math.sin(c * 0.021 + seed) + 0.15 * math.sin(c * 0.07 + seed * 2))
        inside = np.clip(1 - ((x - c) / rad) ** 2, 0, 1)
        h = np.maximum(h, top * np.sqrt(inside) ** 0.55)
        # smaller crowns on the shoulder of each
        for _ in range(3):
            c2, rad2 = c + r.uniform(-rad, rad), rad * r.uniform(0.2, 0.4)
            i2 = np.clip(1 - ((x - c2) / rad2) ** 2, 0, 1)
            h = np.maximum(h, np.interp(c2, x, h) * 0.94 + rad2 * 0.55 * np.sqrt(i2) - 99.0 * (i2 <= 0))
        c += rad * r.uniform(0.5, 0.95)
    return h


def silhouette(name, coll, n, f0, f1, low, high, spacing, colour, seed, base=0.0, side=1, gap=None):
    f = np.arange(f0, f1, 0.7)
    h = lobes(f, seed, low, high, spacing)
    if gap:
        h = np.minimum(h, 2.4 + 40 * np.clip(np.maximum(gap[0] - f, f - gap[1]) / 9, 0, 1) ** 2)
    verts = []
    for fi, hi in zip(f, h):
        verts.append(tuple(shore(fi, n, base)))
        verts.append(tuple(shore(fi, n, base + hi)))
    obj = P.mesh_from_arrays(name, np.array(verts), P.grid_faces(len(f), 2), coll)
    C.assign(obj, fogged(name, colour, SKY, near=150, far=900, amount=0.82))
    no_lines(obj)
    return obj


def build_far_bank(coll):
    """Atake: one dark silhouette, a second just behind it, and three roofs catching the light."""
    silhouette("atake_far", coll, FAR + 75, -2600, 2600, 29, 37, 26, SHORE_FAR, 3)
    silhouette("atake_back", coll, FAR + 32, -1100, 1100, 12, 20, 17, SHORE_BACK, 8)
    silhouette("atake", coll, FAR, -1100, 1100, 7.5, 13.5, 11, SHORE, 21)
    # the stepped edge of the bank on the water
    f = np.arange(-1100, 1100, 5.0)
    r = np.random.default_rng(5)
    edge = np.repeat(r.uniform(0.0, 5.0, len(f) // 2 + 1), 2)[: len(f)]
    verts = []
    for fi, e in zip(f, edge):
        verts.append(tuple(shore(fi, FAR - e, 0.3)))
        verts.append(tuple(shore(fi, FAR + 2000, 0.3)))
    g = P.mesh_from_arrays("atake_ground", np.array(verts), P.grid_faces(len(f), 2), coll)
    C.assign(g, fogged("atake_ground", SHORE, SKY, near=150, far=900, amount=0.82))
    no_lines(g)
    bm, dark = bmesh.new(), bmesh.new()
    for f0, w in ((-165, 15), (-128, 14), (-96, 12), (-250, 16), (58, 11), (120, 12)):
        a = [shore(f0 - w / 2, FAR - 1.2, 4.6), shore(f0 + w / 2, FAR - 1.2, 4.6), shore(f0, FAR - 1.2, 8.8)]
        bm.faces.new([bm.verts.new(p) for p in a])
        b = [shore(f0 - w * 0.12, FAR - 1.4, 4.6), shore(f0 + w * 0.36, FAR - 1.4, 4.6), shore(f0 + w * 0.05, FAR - 1.4, 7.3)]
        dark.faces.new([dark.verts.new(p) for p in b])
        dark.faces.new([dark.verts.new(p) for p in (shore(f0 - w * 0.7, FAR - 1.0, 0.4), shore(f0 + w * 0.7, FAR - 1.0, 0.4), shore(f0 + w * 0.6, FAR - 1.0, 4.6), shore(f0 - w * 0.6, FAR - 1.0, 4.6))])
    obj_from_bm("roofs_lit", bm, coll, fogged("roofs_lit", PAPER, SKY, near=120, far=900, amount=0.6), lines=False)
    obj_from_bm("roofs_dark", dark, coll, fogged("roofs_dark", "#2b3d4c", SKY, near=150, far=900, amount=0.8), lines=False)


def house(bms, at, turn, w, d, h, roof):
    rot = Matrix.Rotation(turn, 4, "Z")
    bmesh.ops.create_cube(bms["wall"], size=1.0, matrix=Matrix.Translation(at + Vector((0, 0, h / 2))) @ rot @ Matrix.Diagonal((w, d, h, 1)))
    rh, r3 = d * 0.36, rot.to_3x3()
    e = 1.15
    v = [Vector(p) for p in ((-w / 2 - e, -d / 2 - e, 0), (w / 2 + e, -d / 2 - e, 0), (w / 2 + e, d / 2 + e, 0), (-w / 2 - e, d / 2 + e, 0), (-w / 2 - e * 0.6, 0, rh), (w / 2 + e * 0.6, 0, rh))]
    top = at + Vector((0, 0, h))
    vs = [bms[roof].verts.new(top + r3 @ p) for p in v]
    for f in ((0, 1, 5, 4), (2, 3, 4, 5)):
        bms[roof].faces.new([vs[i] for i in f])
    gv = [bms["wall"].verts.new(top + r3 @ p) for p in v]
    for f in ((1, 2, 5), (3, 0, 4)):
        bms["wall"].faces.new([gv[i] for i in f])
    # ridge, and the rows of the tiles
    a, b = top + r3 @ (v[4] + Vector((0, 0, 0.12))), top + r3 @ (v[5] + Vector((0, 0, 0.12)))
    beam(bms["ridge"], a, b, 0.42, 0.34)
    for side in (0, 3):
        for k in (0.36, 0.68):
            p = v[4].lerp(v[side], k) + Vector((0, 0, 0.06))
            q = v[5].lerp(v[1 if side == 0 else 2], k) + Vector((0, 0, 0.06))
            beam(bms["ridge"], top + r3 @ p, top + r3 @ q, 0.09, 0.09)


def build_near_bank(coll):
    """The town we are standing in, seen from above: roofs, lanes, dark trees."""
    f = np.arange(-900, 901, 12.0)
    verts = []
    for fi in f:
        verts.append(tuple(shore(fi, NEAR, 2.6)))
        verts.append(tuple(shore(fi, -900, 2.6)))
    g = P.mesh_from_arrays("near_ground", np.array(verts), P.grid_faces(len(f), 2), coll)
    C.assign(g, fogged("near_ground", GROUND, SKY_LOW, near=40, far=420, amount=0.75))
    bm = bmesh.new()  # the facing of the embankment, and its coping
    beam(bm, shore(-600, NEAR + 0.2, 1.0), shore(600, NEAR + 0.2, 1.0), 3.2, 0.5)
    beam(bm, shore(-600, NEAR, 2.72), shore(600, NEAR, 2.72), 0.3, 1.2)
    obj_from_bm("embankment", bm, coll, fogged("embankment", PILE, SKY_LOW, near=60, far=400, amount=0.7))

    bms = {k: bmesh.new() for k in ("wall", "tile", "tile2", "thatch", "ridge")}
    turn = math.atan2(FLOW[1], FLOW[0])
    row = -14.0
    while row > -210:
        depth = rng.uniform(7.0, 9.5)
        fi = -330.0 + rng.uniform(0, 12)
        while fi < 330:
            w = rng.uniform(8, 15)
            p = shore(fi + w / 2, row - depth / 2, 2.6)
            # leave room for the tower, and for the street the bridge comes down into
            street = abs((p.x - START[0]) * ALONG[1] - (p.y - START[1]) * ALONG[0]) < 8.5 and p.x < -20
            if math.hypot(p.x, p.y) > 13 and not street and rng.random() > 0.1:
                kind = "thatch" if rng.random() < 0.16 else ("tile2" if rng.random() < 0.4 else "tile")
                house(bms, p, turn + rng.uniform(-0.02, 0.02), w - 1.6, depth, rng.uniform(2.2, 3.4), kind)
            fi += w + (rng.uniform(2.5, 5) if rng.random() < 0.14 else -0.2)
        row -= depth + rng.uniform(2.6, 5.4)
    for key, colour in (("wall", WALL), ("tile", TILE), ("tile2", TILE_LIGHT), ("thatch", THATCH), ("ridge", "#44545e")):
        obj_from_bm(f"town_{key}", bms[key], coll, fogged(f"town_{key}", colour, SKY_LOW, near=50, far=330, amount=0.85), "town" if key == "ridge" else f"town_{key}")
    # what breaks the rows: trees standing dark among the roofs, the big roof of a temple, two more towers
    crowns, trunks = bmesh.new(), bmesh.new()
    for _ in range(58):
        f, n = rng.uniform(-260, 260), rng.uniform(-200, -20)
        p = shore(f, n, 2.6)
        if math.hypot(p.x, p.y) < 20:
            continue
        away = Vector((p.x, p.y, 0)).normalized()
        side = Vector((away.y, -away.x, 0))
        size = rng.uniform(2.2, 4.6) * (1.5 if rng.random() < 0.15 else 1)
        lift = size * rng.uniform(1.0, 1.5)
        pts = []
        lob = rng.randint(6, 9)
        for k in range(48):
            a = k / 48 * 2 * math.pi
            r = size * (0.86 + 0.14 * abs(math.sin(a * lob / 2 + lob)))
            pts.append(crowns.verts.new(p + side * math.cos(a) * r + Vector((0, 0, lift + math.sin(a) * r * 0.82))))
        crowns.faces.new(pts)
        beam(trunks, p, p + Vector((0, 0, lift)), 0.35)
    obj_from_bm("town_trees", crowns, coll, fogged("town_trees", SHORE_BACK, SKY_LOW, near=50, far=330, amount=0.8))
    obj_from_bm("town_trunks", trunks, coll, fogged("town_trunks", "#39454c", SKY_LOW, near=50, far=330, amount=0.8), lines=False)
    temple = {k: bmesh.new() for k in ("wall", "tile", "tile2", "thatch", "ridge")}
    for f, n, w, d, h in ((-74, -92, 34, 24, 7.5), (96, -128, 26, 19, 6.5), (20, -168, 22, 16, 6)):
        house(temple, shore(f, n, 2.6), turn, w, d, h, "tile")
    for key, colour in (("wall", WALL), ("tile", "#4b5b66"), ("ridge", "#34424c")):
        obj_from_bm(f"temple_{key}", temple[key], coll, fogged(f"temple_{key}", colour, SKY_LOW, near=50, far=330, amount=0.8), f"temple_{key}")
    towers = bmesh.new()
    for f, n, h in ((-118, -46, 15), (64, -70, 17)):
        base = shore(f, n, 2.6)
        for dx in (-0.9, 0.9):
            for dy in (-0.9, 0.9):
                beam(towers, base + Vector((dx * 1.2, dy * 1.2, 0)), base + Vector((dx, dy, h)), 0.3)
        beam(towers, base + Vector((0, 0, h - 1.6)), base + Vector((0, 0, h - 1.4)), 2.9)
        beam(towers, base + Vector((0, 0, h)), base + Vector((0, 0, h + 0.3)), 3.4)
        beam(towers, base + Vector((0, 0, h + 0.3)), base + Vector((0, 0, h + 0.9)), 2.0)
        for k in range(1, 4):
            for s in (-1, 1):
                beam(towers, base + Vector((-1.1, s, h * k / 4)), base + Vector((1.1, s, h * k / 4)), 0.2)
                beam(towers, base + Vector((s, -1.1, h * k / 4)), base + Vector((s, 1.1, h * k / 4)), 0.2)
    obj_from_bm("towers", towers, coll, fogged("towers", PILE, SKY_LOW, near=50, far=330, amount=0.8))
    silhouette("near_trees", coll, -225, -900, 900, 13, 22, 15, SHORE_BACK, 33, 2.6)
    silhouette("near_trees_back", coll, -290, -2600, 2600, 28, 38, 24, SHORE_FAR, 41, 2.6)


# ─── Bridge ───────────────────────────────────────────────────────────────────

def build_bridge(coll):
    s = np.linspace(S0 - 16, S1 + 8, 320)
    verts = []
    for si in s:
        for t in (-DECK_W / 2, DECK_W / 2):
            verts.append(tuple(on_bridge(si, t)))
    deck = P.mesh_from_arrays("deck", np.array(verts), P.grid_faces(len(s), 2), coll)
    C.assign(deck, fogged("deck", DECK, SKY_LOW, near=110, far=420, amount=0.6))
    deck["line_group"] = "deck"

    bm = bmesh.new()
    for t in (-DECK_W / 2, DECK_W / 2):
        prev = None
        for si in np.arange(S0 - 14, S1 + 6, 1.5):
            p = on_bridge(si, t, -0.2)
            if prev:
                beam(bm, prev, p, 0.2, 0.4)
            prev = p
    obj_from_bm("fascia", bm, coll, fogged("fascia", DECK_SIDE, SKY_LOW, near=110, far=420, amount=0.6), "deck")

    # the timber under it: bents of piles, bound near the water, with caps, ties and braces
    piles, dark = bmesh.new(), bmesh.new()
    for si in np.arange(S0 + 5, S1 - 3, 6.2):
        top = deck_z(si) - 0.75
        feet = (-3.3, -1.15, 1.15, 3.3)
        for t in feet:
            lean = t * 0.1
            a, b = on_bridge(si, t + lean), on_bridge(si, t * 0.86)
            a.z, b.z = -2.0, top
            m = beam(piles, a, b, 0.5)
            for z in (0.7, 1.15):  # the iron bands
                q = a.lerp(b, (z + 2) / (top + 2))
                beam(dark, q - Vector((0, 0, 0.1)), q + Vector((0, 0, 0.1)), 0.6)
        for z, w in ((top, 0.5), (top * 0.52 + 0.4, 0.34)):
            a, b = on_bridge(si, -3.7), on_bridge(si, 3.7)
            a.z = b.z = z
            beam(piles, a, b, w)
        for sg in (-1, 1):
            a, b = on_bridge(si, -2.9 * sg), on_bridge(si, 2.9 * sg)
            a.z, b.z = top - 0.5, top * 0.52 + 0.6
            beam(piles, a, b, 0.24)
        if si + 6.2 < S1 - 3:  # braces and ties from bent to bent, on both faces
            for t in (-2.9, 2.9):
                a, b = on_bridge(si, t), on_bridge(si + 6.2, t)
                a.z, b.z = top - 0.4, top * 0.5
                beam(piles, a, b, 0.22)
                c, d = on_bridge(si, t), on_bridge(si + 6.2, t)
                c.z, d.z = top * 0.5, deck_z(si + 6.2) - 1.15
                beam(piles, c, d, 0.22)
                e, g = on_bridge(si, t), on_bridge(si + 6.2, t)
                e.z, g.z = top * 0.5 + 0.1, deck_z(si + 6.2) * 0.5 - 0.3
                beam(piles, e, g, 0.26)
    for t in (-2.9, -1, 1, 2.9):
        prev = None
        for si in np.arange(S0, S1, 3.1):
            p = on_bridge(si, t, -0.55)
            if prev:
                beam(piles, prev, p, 0.36, 0.42)
            prev = p
    fog = dict(fog_hex=SKY_LOW, near=90, far=420, amount=0.7)
    obj_from_bm("piles", piles, coll, fogged("piles", PILE, **fog))
    obj_from_bm("bands", dark, coll, fogged("bands", PILE_DARK, **fog))


# ─── Where we stand ───────────────────────────────────────────────────────────

def build_platform(coll):
    """The top of a fire watch: a few boards, posts at the back and sides, open towards the river."""
    z = EYE - 1.62
    boards, frame = bmesh.new(), bmesh.new()
    for i in range(8):
        x = -1.22 + i * 0.35
        beam(boards, Vector((x, -1.35, z)), Vector((x, 0.62, z)), 0.335, 0.07)
    for x in (-1.45, 1.45):
        for y in (-1.4, 0.5):
            beam(frame, Vector((x, y, 2.6)), Vector((x, y, z + (0.95 if y < 0 else 0.62))), 0.16)
        beam(frame, Vector((x, -1.4, z + 0.86)), Vector((x, 0.5, z + 0.56)), 0.1, 0.12)
        beam(frame, Vector((x, -1.5, z - 0.12)), Vector((x, 0.72, z - 0.12)), 0.16, 0.2)
    for h in (0.86, 0.45):
        beam(frame, Vector((-1.45, -1.4, z + h)), Vector((1.45, -1.4, z + h)), 0.1, 0.12)
    for k in range(1, 5):
        zz = 2.6 + (z - 2.6) * k / 5
        for a, b in (((-1.45, -1.4), (1.45, -1.4)), ((-1.45, 0.5), (1.45, 0.5)), ((-1.45, -1.4), (-1.45, 0.5)), ((1.45, -1.4), (1.45, 0.5))):
            beam(frame, Vector((*a, zz)), Vector((*b, zz)), 0.11)
    for obj in (obj_from_bm("boards", boards, coll, P.flat("boards", TIMBER)), obj_from_bm("frame", frame, coll, P.flat("frame", TIMBER_DARK))):
        C.set_mask(obj, (0, 0, 1))


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    scene = C.clear_scene()
    P.setup_render(scene, samples=24 if preview else 64)
    build_sky(scene)
    build_river(C.collection("River"))
    banks = C.collection("Banks")
    build_far_bank(banks)
    build_near_bank(banks)
    build_bridge(C.collection("Bridge"))
    build_platform(C.collection("Platform"))
    C.pano_camera(EYE)
    C.set_resolution(1024 if preview else 8192)
    return scene


if __name__ == "__main__":
    build()
