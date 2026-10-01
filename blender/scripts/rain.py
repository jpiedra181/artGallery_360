"""Room II — Rain. Inside Hiroshige's "Sudden Shower over Shin-Ōhashi Bridge
and Atake".

The viewer stands by the railing of the long wooden bridge over the Sumida,
in a summer downpour. The deck rises ahead and people hurry across under
straw hats and mats; below, the grey-green river and a raftsman; across the
water, the dark tree line of Atake fading into mist under a band of black
cloud. Flat woodblock colours; the rain itself is drawn live by the viewer.

Mask pass
  R  river (rain rings)      G  sky
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C
import printmaking as P

SKY = [(0.0, "#a9aea6"), (0.12, "#8e9490"), (0.32, "#626865"), (0.55, "#33373a"), (0.8, "#1c1e21"), (1.0, "#151719")]
RIVER = "#4f7a76"
RIVER_DEEP = "#2f565b"
RIVER_LINE = "#6f9590"
DECK = "#d8bf8e"
DECK_LINE = "#a98d5e"
RAIL = "#5a4a35"
PILE = "#4a4237"
BANK = "#2f3a30"
BANK_FAR = "#6c746b"
GROUND = "#7d7a62"
ROOF = "#3c3f42"
WALL = "#9e9784"
KIMONO = "#2c3a49"
KIMONO_2 = "#4e5a52"
STRAW = "#c7ad74"
STRAW_DARK = "#9a8350"
UMBRELLA = "#3a332c"
SKIN = "#e6c79d"
LOG = "#a98c5c"
FOG = "#9da39c"

BRIDGE_YAW = math.radians(-24)   # the deck runs away from us towards yaw -24°
VIEW_S = -38.0                   # where we stand along the bridge (m)
SPAN = 120.0                     # half-length of the bridge (m)
DECK_W = 6.2
RIVER_HALF = 112.0               # banks at ±112 m along the bridge axis

rng = random.Random(4)


def axis():
    a = BRIDGE_YAW
    along = Vector((math.sin(a), math.cos(a), 0))
    across = Vector((math.cos(a), -math.sin(a), 0))  # to the right of the deck
    return along, across


def deck_z(s):
    """Arched deck: highest in the middle of the river."""
    return 6.0 + 2.8 * (1 - (s / SPAN) ** 2)


# where the viewer stands: on the deck, near the right-hand railing
_along, _across = axis()
ORIGIN = -(_along * VIEW_S + _across * (DECK_W / 2 - 1.1))  # shift the world so we are at x=y=0


def W(s, t, z):
    """World position for bridge coordinates: s along, t across (m), z up."""
    along, across = axis()
    return along * s + across * t + Vector((0, 0, z)) + ORIGIN


def fogged(name, color_hex, fog_hex=FOG, near=60.0, far=650.0, amount=0.8):
    """Flat colour that fades into the mist with distance."""
    mat, nt, out = C.new_material(name)
    em = C.node(nt, "ShaderNodeEmission", 400, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    lp = C.node(nt, "ShaderNodeLightPath", -400, -200)
    rng_ = C.node(nt, "ShaderNodeMapRange", -200, -200)
    rng_.inputs["From Min"].default_value = near
    rng_.inputs["From Max"].default_value = far
    rng_.inputs["To Max"].default_value = amount
    rng_.interpolation_type = "SMOOTHSTEP"
    nt.links.new(lp.outputs["Ray Length"], rng_.inputs["Value"])
    col = C.mix_color(nt, P.hex_to_linear(color_hex), P.hex_to_linear(fog_hex), rng_.outputs["Result"], x=100, y=0)
    nt.links.new(col, em.inputs["Color"])
    return mat


def obj_from_bm(name, bm, coll, mat, smooth=False):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    C.assign(obj, mat)
    return obj


def beam(bm, a, b, w, h=None):
    """Box from point a to point b with cross-section w × h."""
    h = h or w
    d = b - a
    m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((w, h, d.length, 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


# ─── Bridge ───────────────────────────────────────────────────────────────────

def build_bridge(coll):
    along, across = axis()
    # deck: a strip with planks across it (UV u = along, v = across)
    n = 360
    s = np.linspace(-SPAN - 4, SPAN + 4, n)
    verts, uvs = [], []
    for si in s:
        for t in (-DECK_W / 2, DECK_W / 2):
            p = W(si, t, deck_z(si))
            verts.append(tuple(p))
            uvs.append((si, t))
    faces = P.grid_faces(n, 2)
    deck = P.mesh_from_arrays("deck", np.array(verts), faces, coll)
    P.add_uv(deck, np.array(uvs))
    mat, nt, out = C.new_material("deck")
    em = C.node(nt, "ShaderNodeEmission", 500, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    uv = C.node(nt, "ShaderNodeUVMap", -700, 0)
    sep = C.node(nt, "ShaderNodeSeparateXYZ", -500, 0)
    nt.links.new(uv.outputs[0], sep.inputs[0])
    mul = C.node(nt, "ShaderNodeMath", -350, 0, operation="MULTIPLY")
    mul.inputs[1].default_value = 1 / 0.32
    nt.links.new(sep.outputs["X"], mul.inputs[0])
    fr = C.node(nt, "ShaderNodeMath", -200, 0, operation="FRACT")
    nt.links.new(mul.outputs[0], fr.inputs[0])
    seam = C.node(nt, "ShaderNodeMath", -50, 0, operation="LESS_THAN")
    seam.inputs[1].default_value = 0.08
    nt.links.new(fr.outputs[0], seam.inputs[0])
    col = C.mix_color(nt, P.hex_to_linear(DECK), P.hex_to_linear(DECK_LINE), seam.outputs[0], x=150, y=0)
    lp = C.node(nt, "ShaderNodeLightPath", -50, -250)
    fog = C.node(nt, "ShaderNodeMapRange", 100, -250)
    fog.inputs["From Min"].default_value = 60
    fog.inputs["From Max"].default_value = 450
    fog.inputs["To Max"].default_value = 0.65
    fog.interpolation_type = "SMOOTHSTEP"
    nt.links.new(lp.outputs["Ray Length"], fog.inputs["Value"])
    col = C.mix_color(nt, col, P.hex_to_linear(FOG), fog.outputs["Result"], x=300, y=0)
    nt.links.new(col, em.inputs["Color"])
    C.assign(deck, mat)
    deck["line_group"] = "deck"

    # edge beams, railing posts and rails
    bm = bmesh.new()
    for side in (-1, 1):
        t = side * DECK_W / 2
        prev = None
        for si in np.arange(-SPAN, SPAN + 0.1, 2.0):
            base = W(si, t, deck_z(si))
            top = base + Vector((0, 0, 1.05))
            beam(bm, base - Vector((0, 0, 0.05)), top, 0.13)
            if prev is not None:
                pb, pt = prev
                beam(bm, pt, top, 0.1, 0.12)                                         # handrail
                beam(bm, pb + Vector((0, 0, 0.45)), base + Vector((0, 0, 0.45)), 0.07)  # mid rail
                beam(bm, pb - Vector((0, 0, 0.25)), base - Vector((0, 0, 0.25)), 0.16, 0.4)  # fascia
            prev = (base, top)
    rail = obj_from_bm("railing", bm, coll, fogged("rail", RAIL))

    # bents of piles under the deck, every 7 m, with cross bracing
    bm = bmesh.new()
    for si in np.arange(-RIVER_HALF + 4, RIVER_HALF - 3, 7.0):
        top_z = deck_z(si) - 0.45
        xs = [-2.6, -0.9, 0.9, 2.6]
        for t in xs:
            beam(bm, W(si, t, -3.0), W(si, t, top_z), 0.32)
        beam(bm, W(si, -3.1, top_z), W(si, 3.1, top_z), 0.35, 0.35)            # cap
        beam(bm, W(si, -2.6, top_z - 0.6), W(si, 2.6, 1.2), 0.14)                # braces
        beam(bm, W(si, 2.6, top_z - 0.6), W(si, -2.6, 1.2), 0.14)
        beam(bm, W(si, -2.8, 2.2), W(si, 2.8, 2.2), 0.2)                         # tie
    for t in (-2.7, 2.7):  # stringers along the bridge
        prev = None
        for si in np.arange(-SPAN, SPAN + 0.1, 3.5):
            p = W(si, t, deck_z(si) - 0.32)
            if prev is not None:
                beam(bm, prev, p, 0.3, 0.45)
            prev = p
    obj_from_bm("piles", bm, coll, fogged("piles", PILE, near=40, far=500, amount=0.75))
    return deck


# ─── River, banks and the far shore ───────────────────────────────────────────

def build_river(coll):
    along, across = axis()
    size = 3000
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=2, y_segments=2, size=size / 2)
    water = obj_from_bm("river", bm, coll, None)
    water.location = (0, 0, 0)
    mat, nt, out = C.new_material("river")
    em = C.node(nt, "ShaderNodeEmission", 600, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    geo = C.node(nt, "ShaderNodeNewGeometry", -900, 0)
    # bands of colour drifting with the current, like a graded wipe of ink
    noise = C.node(nt, "ShaderNodeTexNoise", -700, 0)
    noise.inputs["Scale"].default_value = 0.02
    noise.inputs["Detail"].default_value = 1.5
    mp = C.node(nt, "ShaderNodeMapping", -850, -200)
    mp.inputs["Scale"].default_value = (1.0, 14.0, 1.0)  # stretched along the flow
    mp.inputs["Rotation"].default_value = (0, 0, BRIDGE_YAW + math.pi / 2)
    nt.links.new(geo.outputs["Position"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], noise.inputs["Vector"])
    ramp = C.node(nt, "ShaderNodeValToRGB", -450, 0)
    cr = ramp.color_ramp
    cr.interpolation = "CONSTANT"
    cr.elements[0].position = 0.0
    cr.elements[0].color = (*P.hex_to_linear(RIVER_DEEP), 1)
    cr.elements[1].position = 0.33
    cr.elements[1].color = (*P.hex_to_linear(RIVER), 1)
    e = cr.elements.new(0.69)
    e.color = (*P.hex_to_linear(RIVER_LINE), 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    lp = C.node(nt, "ShaderNodeLightPath", -450, -300)
    fog = C.node(nt, "ShaderNodeMapRange", -250, -300)
    fog.inputs["From Min"].default_value = 80
    fog.inputs["From Max"].default_value = 900
    fog.inputs["To Max"].default_value = 0.7
    fog.interpolation_type = "SMOOTHSTEP"
    nt.links.new(lp.outputs["Ray Length"], fog.inputs["Value"])
    # the graded wipe at the bottom of the print: deep blue right below us
    near = C.node(nt, "ShaderNodeMapRange", -250, -500)
    near.inputs["From Min"].default_value = 11.0
    near.inputs["From Max"].default_value = 45.0
    near.inputs["To Min"].default_value = 1.0
    near.inputs["To Max"].default_value = 0.0
    near.interpolation_type = "SMOOTHSTEP"
    nt.links.new(lp.outputs["Ray Length"], near.inputs["Value"])
    col = C.mix_color(nt, ramp.outputs["Color"], P.hex_to_linear("#223f50"), near.outputs["Result"], x=150, y=-100)
    col = C.mix_color(nt, col, P.hex_to_linear("#8a9692"), fog.outputs["Result"], x=300, y=0)
    nt.links.new(col, em.inputs["Color"])
    C.assign(water, mat)
    C.set_mask(water, (1, 0, 0))
    water.location = tuple(Vector((0, 0, 0)))
    return water


def blob_tree(bm, at, r, h):
    """A dark rounded tree mass: a few squashed spheres."""
    for _ in range(rng.randint(3, 5)):
        c = at + Vector((rng.uniform(-r, r) * 0.6, rng.uniform(-r, r) * 0.6, h * rng.uniform(0.55, 0.85)))
        rr = r * rng.uniform(0.55, 0.9)
        m = Matrix.Translation(c) @ Matrix.Diagonal((rr, rr, rr * 0.75, 1))
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0, matrix=m)
    beam(bm, at, at + Vector((0, 0, h * 0.5)), r * 0.15)


def house(bm_wall, bm_roof, at, yaw, w, d, h):
    rot = Matrix.Rotation(yaw, 4, "Z")
    m = Matrix.Translation(at + Vector((0, 0, h / 2))) @ rot @ Matrix.Diagonal((w, d, h, 1))
    bmesh.ops.create_cube(bm_wall, size=1.0, matrix=m)
    # hipped roof: a squashed pyramid with eaves
    rh = h * 0.7
    verts = [Vector((-w * 0.65, -d * 0.65, 0)), Vector((w * 0.65, -d * 0.65, 0)), Vector((w * 0.65, d * 0.65, 0)),
             Vector((-w * 0.65, d * 0.65, 0)), Vector((-w * 0.25, 0, rh)), Vector((w * 0.25, 0, rh))]
    base = at + Vector((0, 0, h))
    vs = [bm_roof.verts.new(base + rot.to_3x3() @ v) for v in verts]
    for f in ((0, 1, 5, 4), (1, 2, 5), (2, 3, 4, 5), (3, 0, 4), (3, 2, 1, 0)):
        bm_roof.faces.new([vs[i] for i in f])


def build_banks(coll):
    """Both banks run parallel to the river, at the two ends of the bridge."""
    along, across = axis()
    for end, label in ((1, "atake"), (-1, "near_bank")):
        ground = bmesh.new()
        trees = bmesh.new()
        walls = bmesh.new()
        roofs = bmesh.new()
        s0 = end * RIVER_HALF
        # embankment: a long low strip along the river
        verts = []
        for t in np.linspace(-1600, 1600, 80):
            for ds in (0, end * 500):
                verts.append(W(s0 + ds, t, 1.4))
        faces = P.grid_faces(80, 2)
        g = P.mesh_from_arrays(f"{label}_ground", np.array([tuple(v) for v in verts]), faces, coll)
        C.assign(g, fogged(f"{label}_ground", GROUND, near=40, far=700, amount=0.8))
        # a dense band of trees along the water, with roofs among them
        for t in np.arange(-900, 900, 9.0):
            if abs(t) < 9 and end == 1:
                continue  # leave the bridge approach clear
            depth = rng.uniform(4, 28)
            at = W(s0 + end * depth, t + rng.uniform(-3, 3), 1.4)
            if rng.random() < 0.22:
                house(walls, roofs, at, BRIDGE_YAW + rng.uniform(-0.1, 0.1), rng.uniform(6, 11), rng.uniform(5, 8), rng.uniform(3.5, 5.0))
            else:
                blob_tree(trees, at, rng.uniform(4.5, 8.5), rng.uniform(9, 16))
        # a second, taller row of trees behind
        for t in np.arange(-900, 900, 14.0):
            at = W(s0 + end * rng.uniform(32, 60), t, 1.4)
            blob_tree(trees, at, rng.uniform(6, 10), rng.uniform(14, 22))
        far_tone = BANK if end == 1 else "#3a4438"
        obj_from_bm(f"{label}_trees", trees, coll, fogged(f"{label}_trees", far_tone, BANK_FAR, near=90, far=620, amount=0.85), smooth=True)
        obj_from_bm(f"{label}_walls", walls, coll, fogged(f"{label}_walls", WALL, near=80, far=600, amount=0.85))
        obj_from_bm(f"{label}_roofs", roofs, coll, fogged(f"{label}_roofs", ROOF, near=80, far=600, amount=0.8))


# ─── People ───────────────────────────────────────────────────────────────────

def person(parts, at, facing, kind, scale=1.0, lean=0.35):
    """A figure hurrying through the rain.

    kind: "hat" (wide straw hat), "mat" (straw mat held over the head),
    "umbrella" (oiled-paper umbrella). parts: dict of bmesh per colour.
    """
    rot = Matrix.Rotation(-facing, 4, "Z")
    fwd = rot.to_3x3() @ Vector((0, 1, 0))
    side = rot.to_3x3() @ Vector((1, 0, 0))
    lean_m = Matrix.Rotation(-lean, 4, side)
    k = scale
    # bare legs mid-stride, mostly hidden by the robe
    for sgn in (-1, 1):
        hip = at + Vector((0, 0, 0.62 * k)) + side * 0.08 * sgn * k
        foot = at + fwd * 0.22 * sgn * k + side * 0.09 * sgn * k
        beam(parts["skin"], foot, hip, 0.11 * k)
        # sandal
        beam(parts["rail"], foot - fwd * 0.08 * k, foot + fwd * 0.12 * k, 0.1 * k, 0.04 * k)
    # robe: a tapered, forward-leaning body from the shoulders to below the knees
    body_c = at + Vector((0, 0, 0.96 * k))
    m = Matrix.Translation(body_c) @ lean_m @ rot @ Matrix.Diagonal((0.27 * k, 0.21 * k, 0.53 * k, 1))
    bmesh.ops.create_cone(parts["kimono"], cap_ends=True, segments=12, radius1=1.0, radius2=0.7, depth=2.0, matrix=m)
    # arms folded in front, holding the robe or the umbrella
    for sgn in (-1, 1):
        sh = body_c + lean_m.to_3x3() @ Vector((0, 0, 0.42 * k)) + side * 0.2 * sgn * k
        hand = body_c + lean_m.to_3x3() @ Vector((0, 0, 0.12 * k)) + fwd * 0.26 * k + side * 0.05 * sgn * k
        beam(parts["kimono"], sh, hand, 0.13 * k)
    head = body_c + lean_m.to_3x3() @ Vector((0, 0, 0.66 * k)) + fwd * 0.08 * k
    bmesh.ops.create_uvsphere(parts["skin"], u_segments=10, v_segments=7, radius=0.12 * k, matrix=Matrix.Translation(head))
    if kind == "hat":
        m = Matrix.Translation(head + Vector((0, 0, 0.08 * k))) @ lean_m
        bmesh.ops.create_cone(parts["straw"], cap_ends=True, segments=18, radius1=0.42 * k, radius2=0.02, depth=0.22 * k, matrix=m)
    elif kind == "mat":
        # a straw mat draped over head and back
        m = Matrix.Translation(head + Vector((0, 0, 0.02)) - fwd * 0.15 * k) @ lean_m @ rot @ Matrix.Diagonal((0.38 * k, 0.5 * k, 0.1 * k, 1))
        bmesh.ops.create_uvsphere(parts["straw_dark"], u_segments=12, v_segments=6, radius=1.0, matrix=m)
    else:
        top = head + Vector((0, 0, 0.55 * k)) + fwd * 0.12 * k
        beam(parts["rail"], head + fwd * 0.18 * k - Vector((0, 0, 0.2 * k)), top, 0.025 * k)
        m = Matrix.Translation(top) @ Matrix.Rotation(-0.25, 4, side)
        bmesh.ops.create_cone(parts["umbrella"], cap_ends=True, segments=20, radius1=0.62 * k, radius2=0.03, depth=0.32 * k, matrix=m)


def build_people(coll):
    parts = {n: bmesh.new() for n in ("kimono", "kimono_2", "straw", "straw_dark", "umbrella", "skin", "rail")}
    along, across = axis()
    heading_fwd = BRIDGE_YAW
    heading_back = BRIDGE_YAW + math.pi
    # (s offset from us, t across the deck, direction, kind, scale)
    crowd = [
        (5.5, -1.1, heading_back, "hat", 1.0),
        (8.0, 1.4, heading_back, "mat", 1.0),
        (9.2, 0.3, heading_back, "mat", 0.95),
        (14.0, -1.8, heading_fwd, "umbrella", 1.0),
        (15.5, -0.9, heading_fwd, "umbrella", 0.95),
        (24.0, 1.0, heading_back, "hat", 1.0),
        (-7.0, -1.6, heading_fwd, "hat", 1.0),
        (-11.0, 0.8, heading_back, "umbrella", 1.0),
    ]
    for ds, t, heading, kind, sc in crowd:
        si = VIEW_S + ds
        at = W(si, t, deck_z(si))
        p = {k: parts[k] for k in parts}
        if rng.random() < 0.5:
            p = dict(parts, kimono=parts["kimono_2"])
        person(p, at, heading, kind, sc)
    cols = {"kimono": KIMONO, "kimono_2": KIMONO_2, "straw": STRAW, "straw_dark": STRAW_DARK, "umbrella": UMBRELLA,
            "skin": SKIN, "rail": RAIL}
    for name, bm in parts.items():
        obj_from_bm(f"people_{name}", bm, coll, P.flat(f"people_{name}", cols[name]), smooth=True)


def build_raft(coll):
    """A log raft drifting downstream, its raftsman leaning on a pole."""
    along, across = axis()
    centre = W(VIEW_S + 18, 44, 0.15)
    flow = across  # the river flows across the bridge
    logs = bmesh.new()
    for i in range(7):
        off = along * (i - 3) * 0.55
        beam(logs, centre + off - flow * 7, centre + off + flow * 7, 0.5)
    obj_from_bm("raft", logs, coll, fogged("raft", LOG, near=40, far=400, amount=0.6))
    parts = {n: bmesh.new() for n in ("kimono", "straw", "skin", "rail")}
    at = centre + flow * 4 + Vector((0, 0, 0.25))
    person(dict(parts, straw_dark=parts["straw"], umbrella=parts["straw"]), at, BRIDGE_YAW + math.pi / 2, "hat", 1.05, lean=0.15)
    beam(parts["rail"], at + Vector((0, 0, 1.9)) - along * 0.2, at - along * 2.2 + Vector((0, 0, -1.8)), 0.06)
    for name, col in (("kimono", KIMONO), ("straw", STRAW), ("skin", SKIN), ("rail", RAIL)):
        obj_from_bm(f"raftsman_{name}", parts[name], coll, fogged(f"raftsman_{name}", col, near=40, far=400, amount=0.6), smooth=True)


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    scene = C.clear_scene()
    P.setup_render(scene, samples=24 if preview else 64)
    P.sky_world(scene, SKY)
    c_bridge = C.collection("Bridge")
    c_river = C.collection("River")
    c_banks = C.collection("Banks")
    c_people = C.collection("People")
    build_river(c_river)
    build_bridge(c_bridge)
    build_banks(c_banks)
    build_people(c_people)
    build_raft(c_river)
    eye = deck_z(VIEW_S) + 1.55
    C.pano_camera(eye)
    C.set_resolution(1024 if preview else 8192)
    print(f"eye height above the river: {eye:.2f} m")
    return scene


if __name__ == "__main__":
    build()
