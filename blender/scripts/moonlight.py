"""Room IV — Moonlight. Inside Turner's "Keelmen Heaving in Coals by
Moonlight" (1835).

The viewer sits in a small boat on the River Tyne at night. Ahead, the full
moon opens a funnel of luminous cloud and lays a path of light across the
water. Tall sailing ships stand in silhouette on the left; on the right,
colliers and low keels where torches and braziers burn and figures shovel
coal in drifting smoke. Distant lights and a factory flame along the
horizon. Rendered with real light, then painted (scripts/looks.py).

Mask pass
  R  water      G  sky      B  fires (flicker)
"""

import math
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C

rng = random.Random(21)

MOON_YAW = math.radians(-6)
MOON_ELEV = math.radians(17)
MOON_DIR = Vector((math.sin(MOON_YAW) * math.cos(MOON_ELEV), math.cos(MOON_YAW) * math.cos(MOON_ELEV), math.sin(MOON_ELEV)))
EYE = 1.05


def polar(yaw_deg, dist, z=0.0):
    a = math.radians(yaw_deg)
    return Vector((math.sin(a) * dist, math.cos(a) * dist, z))


def obj_from_bm(name, bm, coll, mat=None, smooth=False):
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


def beam(bm, a, b, w, h=None):
    h = h or w
    d = b - a
    if d.length < 1e-4:
        return
    m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((w, h, d.length, 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def diffuse(name, color, roughness=0.8):
    mat, nt, out = C.new_material(name)
    bsdf = C.principled(nt)
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return mat


def glow(name, color, strength):
    return C.emission_material(name, color, strength)


# ─── Sky: the funnel of moonlit cloud ─────────────────────────────────────────

def build_sky(scene):
    """Procedural night sky built around the moon's direction: a bright halo,
    then rings of cloud swirling outwards into a dark blue night."""
    world = scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = C.node(nt, "ShaderNodeOutputWorld", 1600, 0)
    bg = C.node(nt, "ShaderNodeBackground", 1400, 0)
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    coord = C.node(nt, "ShaderNodeTexCoord", -1400, 0)

    # angle from the moon (0 at the moon, pi opposite)
    dot = C.node(nt, "ShaderNodeVectorMath", -1200, 0, operation="DOT_PRODUCT")
    dot.inputs[1].default_value = tuple(MOON_DIR)
    nt.links.new(coord.outputs["Generated"], dot.inputs[0])
    theta = C.node(nt, "ShaderNodeMath", -1050, 0, operation="ARCCOSINE")
    nt.links.new(dot.outputs["Value"], theta.inputs[0])

    # azimuth around the moon axis
    ref = MOON_DIR.cross(Vector((0, 0, 1))).normalized()
    ref2 = MOON_DIR.cross(ref).normalized()
    d1 = C.node(nt, "ShaderNodeVectorMath", -1200, -250, operation="DOT_PRODUCT")
    d1.inputs[1].default_value = tuple(ref)
    nt.links.new(coord.outputs["Generated"], d1.inputs[0])
    d2 = C.node(nt, "ShaderNodeVectorMath", -1200, -400, operation="DOT_PRODUCT")
    d2.inputs[1].default_value = tuple(ref2)
    nt.links.new(coord.outputs["Generated"], d2.inputs[0])
    phi = C.node(nt, "ShaderNodeMath", -1050, -300, operation="ARCTAN2")
    nt.links.new(d1.outputs["Value"], phi.inputs[0])
    nt.links.new(d2.outputs["Value"], phi.inputs[1])

    # spiral coordinates: rings that twist as they move away from the moon
    logt = C.node(nt, "ShaderNodeMath", -900, 0, operation="LOGARITHM")
    logt.inputs[1].default_value = 2.718
    add = C.node(nt, "ShaderNodeMath", -1000, 100, operation="ADD")
    add.inputs[1].default_value = 0.02
    nt.links.new(theta.outputs[0], add.inputs[0])
    nt.links.new(add.outputs[0], logt.inputs[0])
    twist = C.node(nt, "ShaderNodeMath", -750, -300, operation="MULTIPLY_ADD")
    twist.inputs[1].default_value = 0.9
    nt.links.new(logt.outputs[0], twist.inputs[0])
    nt.links.new(phi.outputs[0], twist.inputs[2])
    comb = C.node(nt, "ShaderNodeCombineXYZ", -600, -150)
    sc = C.node(nt, "ShaderNodeMath", -750, -100, operation="MULTIPLY")
    sc.inputs[1].default_value = 2.2
    nt.links.new(logt.outputs[0], sc.inputs[0])
    nt.links.new(sc.outputs[0], comb.inputs["X"])
    # azimuth wraps: feed sin/cos so the noise stays continuous around the moon
    sinp = C.node(nt, "ShaderNodeMath", -600, -350, operation="SINE")
    cosp = C.node(nt, "ShaderNodeMath", -600, -450, operation="COSINE")
    nt.links.new(twist.outputs[0], sinp.inputs[0])
    nt.links.new(twist.outputs[0], cosp.inputs[0])
    nt.links.new(sinp.outputs[0], comb.inputs["Y"])
    nt.links.new(cosp.outputs[0], comb.inputs["Z"])
    noise = C.node(nt, "ShaderNodeTexNoise", -400, -150)
    noise.inputs["Scale"].default_value = 2.2
    noise.inputs["Detail"].default_value = 6.0
    noise.inputs["Roughness"].default_value = 0.6
    nt.links.new(comb.outputs[0], noise.inputs["Vector"])
    clouds = C.node(nt, "ShaderNodeMapRange", -200, -150)
    clouds.inputs["From Min"].default_value = 0.36
    clouds.inputs["From Max"].default_value = 0.7
    clouds.interpolation_type = "SMOOTHSTEP"
    nt.links.new(noise.outputs["Fac"], clouds.inputs["Value"])

    # light falls off away from the moon
    fall = C.node(nt, "ShaderNodeMapRange", -400, 200)
    fall.inputs["From Min"].default_value = 0.05
    fall.inputs["From Max"].default_value = 1.6
    fall.inputs["To Min"].default_value = 1.0
    fall.inputs["To Max"].default_value = 0.0
    fall.interpolation_type = "SMOOTHERSTEP"
    nt.links.new(theta.outputs[0], fall.inputs["Value"])
    halo = C.node(nt, "ShaderNodeMapRange", -400, 400)
    halo.inputs["From Min"].default_value = 0.0
    halo.inputs["From Max"].default_value = 0.35
    halo.inputs["To Min"].default_value = 1.0
    halo.inputs["To Max"].default_value = 0.0
    halo.interpolation_type = "SMOOTHSTEP"
    nt.links.new(theta.outputs[0], halo.inputs["Value"])

    night = (0.003, 0.006, 0.015)
    lit_cloud = (0.42, 0.38, 0.27)
    dark_cloud = (0.035, 0.04, 0.05)
    # cloud colour: warm and bright near the moon, cool and dim far away
    cloud_col = C.mix_color(nt, dark_cloud, lit_cloud, fall.outputs["Result"], x=0, y=0)
    sky_col = C.mix_color(nt, night, (0.1, 0.11, 0.12), fall.outputs["Result"], x=0, y=200)
    # clouds thin out far from the moon
    far = C.node(nt, "ShaderNodeMapRange", -200, -400)
    far.inputs["From Min"].default_value = 2.3
    far.inputs["From Max"].default_value = 1.1
    far.interpolation_type = "SMOOTHSTEP"
    nt.links.new(theta.outputs[0], far.inputs["Value"])
    cover = C.node(nt, "ShaderNodeMath", 0, -300, operation="MULTIPLY")
    nt.links.new(clouds.outputs["Result"], cover.inputs[0])
    nt.links.new(far.outputs["Result"], cover.inputs[1])
    col = C.mix_color(nt, sky_col, cloud_col, cover.outputs[0], x=250, y=100)
    # a broad, soft glow that turns the whole funnel luminous
    glow_r = C.node(nt, "ShaderNodeMapRange", -200, 600)
    glow_r.inputs["From Min"].default_value = 0.0
    glow_r.inputs["From Max"].default_value = 0.9
    glow_r.inputs["To Min"].default_value = 0.35
    glow_r.inputs["To Max"].default_value = 0.0
    glow_r.interpolation_type = "SMOOTHSTEP"
    nt.links.new(theta.outputs[0], glow_r.inputs["Value"])
    col = C.mix_color(nt, col, (0.75, 0.68, 0.48), glow_r.outputs["Result"], x=400, y=300)
    # the luminous halo around the moon
    hmul = C.node(nt, "ShaderNodeMath", 300, 400, operation="POWER")
    hmul.inputs[1].default_value = 2.2
    nt.links.new(halo.outputs["Result"], hmul.inputs[0])
    col = C.mix_color(nt, col, (1.25, 1.12, 0.85), hmul.outputs[0], x=500, y=100)
    # a few stars in the dark parts
    vor = C.node(nt, "ShaderNodeTexVoronoi", -400, -600)
    vor.inputs["Scale"].default_value = 180.0
    nt.links.new(coord.outputs["Generated"], vor.inputs["Vector"])
    star = C.node(nt, "ShaderNodeMath", -200, -600, operation="LESS_THAN")
    star.inputs[1].default_value = 0.035
    nt.links.new(vor.outputs["Distance"], star.inputs[0])
    darkness = C.node(nt, "ShaderNodeMath", 0, -600, operation="MULTIPLY")
    inv = C.node(nt, "ShaderNodeMath", -200, -750, operation="SUBTRACT")
    inv.inputs[0].default_value = 1.0
    nt.links.new(clouds.outputs["Result"], inv.inputs[1])
    nt.links.new(star.outputs[0], darkness.inputs[0])
    nt.links.new(inv.outputs[0], darkness.inputs[1])
    col = C.mix_color(nt, col, (0.5, 0.5, 0.55), darkness.outputs[0], x=750, y=0)
    nt.links.new(col, bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    # haze: a finite volume around the river (a world volume would swallow
    # the sky, which sits at infinity)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=650.0)
    dome = obj_from_bm("haze", bm, scene.collection, smooth=True)
    hm, hnt, hout = C.new_material("haze")
    vol = C.node(hnt, "ShaderNodeVolumePrincipled", 200, 0)
    vol.inputs["Density"].default_value = 0.0005
    vol.inputs["Anisotropy"].default_value = 0.55
    vol.inputs["Color"].default_value = (0.82, 0.84, 0.88, 1)
    hnt.links.new(vol.outputs[0], hout.inputs["Volume"])
    C.assign(dome, hm)
    dome["volume_only"] = True

    # moonlight: a soft, cool key light from the moon
    moon = bpy.data.lights.new("moonlight", "SUN")
    moon.energy = 1.1
    moon.angle = math.radians(3)
    moon.color = (0.75, 0.82, 1.0)
    mo = bpy.data.objects.new("moonlight", moon)
    mo.rotation_euler = (-MOON_DIR).to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(mo)
    # the moon's disc, far away
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=48, radius=38.0)
    disc = obj_from_bm("moon", bm, scene.collection, glow("moon", (1.0, 0.96, 0.85), 18.0))
    disc.location = MOON_DIR * 2400
    disc.rotation_euler = MOON_DIR.to_track_quat("Z", "Y").to_euler()
    disc.visible_shadow = False
    C.set_mask(disc, (0, 1, 0))


# ─── Water ────────────────────────────────────────────────────────────────────

def build_water(coll):
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=96, radius=4000)
    obj = obj_from_bm("river", bm, coll)
    mat, nt, out = C.new_material("river")
    bsdf = C.principled(nt)
    bsdf.inputs["Base Color"].default_value = (0.02, 0.022, 0.02, 1)
    bsdf.inputs["Roughness"].default_value = 0.06
    bsdf.inputs["Specular IOR Level"].default_value = 0.7
    # long, low swells across the view stretch reflections into paths of light
    tc = C.node(nt, "ShaderNodeTexCoord", -900, -200)
    mp = C.node(nt, "ShaderNodeMapping", -700, -200)
    mp.inputs["Scale"].default_value = (0.25, 2.2, 1.0)
    mp.inputs["Rotation"].default_value = (0, 0, MOON_YAW)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    waves = C.node(nt, "ShaderNodeTexNoise", -500, -200)
    waves.inputs["Scale"].default_value = 0.9
    waves.inputs["Detail"].default_value = 4.0
    nt.links.new(mp.outputs[0], waves.inputs["Vector"])
    bump = C.node(nt, "ShaderNodeBump", -250, -200)
    bump.inputs["Strength"].default_value = 0.12
    bump.inputs["Distance"].default_value = 0.2
    nt.links.new(waves.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    C.assign(obj, mat)
    C.set_mask(obj, (1, 0, 0))
    return obj


# ─── Ships ────────────────────────────────────────────────────────────────────

def hull(bm, length, beam_w, height, draft, deck=True):
    """A ship's hull centred on the origin, bow towards +y: rounded U
    sections, a sheer line that rises towards bow and stern, a raked stem."""
    n_l, n_c = 36, 14
    rings = []
    for i in range(n_l + 1):
        t = i / n_l
        y = -length / 2 + length * t
        fullness = math.sin(math.pi * min(1.0, t * 1.04)) ** 0.5
        bow = max(0.0, (t - 0.78) / 0.22)
        w = beam_w / 2 * max(0.04, fullness * (1 - 0.9 * bow ** 1.5))
        sheer = height * (1 + 0.35 * (2 * t - 1) ** 2 + 0.25 * bow)
        ring = []
        for j in range(n_c + 1):
            a = math.pi * j / n_c  # 0 port gunwale, pi starboard gunwale
            s_ = math.sin(a)
            x = -math.cos(a) * w * (1 - 0.08 * s_)
            z = sheer - (sheer + draft) * s_ ** 0.7
            # the stem rakes forward at the top and the keel is cut away at the bow
            yy = y + bow * (1 - s_) * length * 0.04 - bow * s_ * length * 0.03
            ring.append(bm.verts.new((x, yy, z)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(n_c):
            bm.faces.new((r0[j], r0[j + 1], r1[j + 1], r1[j]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    if deck:
        top = [rings[k][0] for k in range(n_l + 1)] + [rings[k][n_c] for k in range(n_l, -1, -1)]
        bm.faces.new(top)


def ship(coll, name, at, heading, length=34, masts=(30, 33, 26), sails="set"):
    """A three-masted square-rigger: hull, masts, yards, sails and rigging."""
    rot = Matrix.Translation(at) @ Matrix.Rotation(-heading, 4, "Z")
    hull_bm, spar_bm, sail_bm, rig_bm = bmesh.new(), bmesh.new(), bmesh.new(), bmesh.new()
    hull(hull_bm, length, length * 0.26, 4.5, 3.0)
    positions = (-0.28, 0.04, 0.33)
    tops = []
    for (pos, h) in zip(positions, masts):
        y = pos * length
        base = Vector((0, y, 4.0))
        top = Vector((0, y, 4.0 + h))
        beam(spar_bm, base, top, 0.5)
        tops.append(top)
        # yards with sails hanging from them
        for k, frac in enumerate((0.32, 0.55, 0.74, 0.9)):
            z = 4.0 + h * frac
            span = length * 0.32 * (1 - frac * 0.55)
            beam(spar_bm, Vector((-span / 2, y, z)), Vector((span / 2, y, z)), 0.28)
            if sails == "set" and k < 3:
                drop = h * 0.2
                # a slightly bellied square sail
                vs = [sail_bm.verts.new(v) for v in (
                    Vector((-span * 0.48, y + 0.1, z - 0.2)), Vector((span * 0.48, y + 0.1, z - 0.2)),
                    Vector((span * 0.44, y + 0.9, z - drop)), Vector((-span * 0.44, y + 0.9, z - drop)))]
                sail_bm.faces.new(vs)
            elif sails == "furled":
                beam(sail_bm, Vector((-span * 0.45, y, z - 0.35)), Vector((span * 0.45, y, z - 0.35)), 0.55)
    # bowsprit
    beam(spar_bm, Vector((0, length * 0.45, 4.5)), Vector((0, length * 0.75, 9.5)), 0.35)
    # standing rigging: stays and shrouds
    beam(rig_bm, tops[0], Vector((0, -length / 2, 5)), 0.06)
    beam(rig_bm, tops[0], tops[1], 0.06)
    beam(rig_bm, tops[1], tops[2], 0.06)
    beam(rig_bm, tops[2], Vector((0, length * 0.75, 9.5)), 0.06)
    for top, pos in zip(tops, positions):
        for sgn in (-1, 1):
            for dy in (-1.5, 0, 1.5):
                beam(rig_bm, top - Vector((0, 0, 2)), Vector((sgn * length * 0.13, pos * length + dy, 5.0)), 0.05)
    parts = []
    for bm, mat, nm in (
        (hull_bm, diffuse("ship_hull", (0.012, 0.01, 0.009), 0.7), "hull"),
        (spar_bm, diffuse("ship_spar", (0.02, 0.016, 0.012), 0.8), "spars"),
        (sail_bm, diffuse("ship_sail", (0.32, 0.31, 0.28), 0.9), "sails"),
        (rig_bm, diffuse("ship_rig", (0.01, 0.01, 0.01), 0.9), "rigging"),
    ):
        o = obj_from_bm(f"{name}_{nm}", bm, coll, mat)
        o.matrix_world = rot
        parts.append(o)
    return parts


# ─── Keels, fires and smoke ───────────────────────────────────────────────────

FIRES = []


def fire(coll, at, size=1.0, warm=True):
    """A brazier: iron basket on a post, a bright flame, light, and smoke."""
    bm = bmesh.new()
    beam(bm, at, at + Vector((0, 0, 2.2 * size)), 0.12)
    m = Matrix.Translation(at + Vector((0, 0, 2.35 * size))) @ Matrix.Diagonal((0.45 * size, 0.45 * size, 0.3 * size, 1))
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.6, radius2=1.0, depth=1.0, matrix=m)
    obj_from_bm("brazier", bm, coll, diffuse("iron", (0.02, 0.018, 0.016)))
    flame = bmesh.new()
    color = (1.0, 0.22, 0.02) if warm else (1.0, 0.5, 0.12)
    for k in range(5):
        c = at + Vector((rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), (2.6 + k * 0.35) * size))
        r = (0.55 - k * 0.08) * size
        m = Matrix.Translation(c) @ Matrix.Diagonal((r, r, r * 1.6, 1))
        bmesh.ops.create_icosphere(flame, subdivisions=2, radius=1.0, matrix=m)
    fo = obj_from_bm("flame", flame, coll, glow("flame_warm" if warm else "flame_pale", color, 4.0), smooth=True)
    fo.visible_shadow = False
    C.set_mask(fo, (0, 0, 1))
    light = bpy.data.lights.new("fire_light", "POINT")
    light.energy = 2600 * size
    light.color = color
    light.shadow_soft_size = 0.6 * size
    lo = bpy.data.objects.new("fire_light", light)
    lo.location = at + Vector((0, 0, 3.0 * size))
    coll.objects.link(lo)
    FIRES.append((at + Vector((0, 0, 3.4 * size)), size))


def smoke(coll):
    """Smoke rising and drifting from all the fires, lit from below."""
    for at, size in FIRES:
        bm = bmesh.new()
        h = 26 * size
        m = Matrix.Translation(at + Vector((-3 * size, 2 * size, h / 2))) @ Matrix.Diagonal((9 * size, 9 * size, h, 1))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
        obj = obj_from_bm("smoke", bm, coll)
        mat, nt, out = C.new_material("smoke")
        vol = C.node(nt, "ShaderNodeVolumePrincipled", 300, 0)
        vol.inputs["Color"].default_value = (0.35, 0.33, 0.3, 1)
        vol.inputs["Anisotropy"].default_value = 0.3
        tc = C.node(nt, "ShaderNodeTexCoord", -900, 0)
        sep = C.node(nt, "ShaderNodeSeparateXYZ", -700, 150)
        nt.links.new(tc.outputs["Generated"], sep.inputs[0])
        mp = C.node(nt, "ShaderNodeMapping", -700, -100)
        mp.inputs["Scale"].default_value = (2.0, 2.0, 5.0)
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        noise = C.node(nt, "ShaderNodeTexNoise", -500, -100)
        noise.inputs["Scale"].default_value = 2.4
        noise.inputs["Detail"].default_value = 5
        nt.links.new(mp.outputs[0], noise.inputs["Vector"])
        # a plume: narrow at the bottom centre, widening and thinning upwards
        dx = C.node(nt, "ShaderNodeMath", -500, 300, operation="SUBTRACT")
        nt.links.new(sep.outputs["X"], dx.inputs[0])
        dx.inputs[1].default_value = 0.5
        dy = C.node(nt, "ShaderNodeMath", -500, 400, operation="SUBTRACT")
        nt.links.new(sep.outputs["Y"], dy.inputs[0])
        dy.inputs[1].default_value = 0.5
        r = C.node(nt, "ShaderNodeVectorMath", -350, 350, operation="LENGTH")
        cmb = C.node(nt, "ShaderNodeCombineXYZ", -420, 350)
        nt.links.new(dx.outputs[0], cmb.inputs["X"])
        nt.links.new(dy.outputs[0], cmb.inputs["Y"])
        nt.links.new(cmb.outputs[0], r.inputs[0])
        width = C.node(nt, "ShaderNodeMath", -350, 200, operation="MULTIPLY_ADD")
        width.inputs[1].default_value = 0.4
        width.inputs[2].default_value = 0.06
        nt.links.new(sep.outputs["Z"], width.inputs[0])
        inside = C.node(nt, "ShaderNodeMath", -200, 300, operation="DIVIDE")
        nt.links.new(r.outputs["Value"], inside.inputs[0])
        nt.links.new(width.outputs[0], inside.inputs[1])
        plume = C.node(nt, "ShaderNodeMapRange", -50, 300)
        plume.inputs["From Min"].default_value = 1.0
        plume.inputs["From Max"].default_value = 0.2
        plume.interpolation_type = "SMOOTHSTEP"
        nt.links.new(inside.outputs[0], plume.inputs["Value"])
        dens = C.node(nt, "ShaderNodeMath", 100, 100, operation="MULTIPLY")
        nt.links.new(plume.outputs["Result"], dens.inputs[0])
        nt.links.new(noise.outputs["Fac"], dens.inputs[1])
        fade = C.node(nt, "ShaderNodeMapRange", -50, -250)
        fade.inputs["From Min"].default_value = 0.0
        fade.inputs["From Max"].default_value = 1.0
        fade.inputs["To Min"].default_value = 1.0
        fade.inputs["To Max"].default_value = 0.15
        nt.links.new(sep.outputs["Z"], fade.inputs["Value"])
        dens2 = C.node(nt, "ShaderNodeMath", 200, -50, operation="MULTIPLY")
        nt.links.new(dens.outputs[0], dens2.inputs[0])
        nt.links.new(fade.outputs["Result"], dens2.inputs[1])
        scale = C.node(nt, "ShaderNodeMath", 250, 100, operation="MULTIPLY")
        scale.inputs[1].default_value = 2.2
        nt.links.new(dens2.outputs[0], scale.inputs[0])
        nt.links.new(scale.outputs[0], vol.inputs["Density"])
        nt.links.new(vol.outputs[0], out.inputs["Volume"])
        C.assign(obj, mat)
        obj["volume_only"] = True


def keel(coll, at, heading, fires=1, workers=3):
    """A flat-bottomed coal barge with a heap of coal, braziers and keelmen."""
    rot = Matrix.Translation(at) @ Matrix.Rotation(-heading, 4, "Z")
    bm = bmesh.new()
    hull(bm, 13, 4.2, 1.0, 0.8)
    coal = bmesh.new()
    for _ in range(14):
        p = Vector((rng.uniform(-1.2, 1.2), rng.uniform(-4, 4), 0.9))
        m = Matrix.Translation(p) @ Matrix.Diagonal((rng.uniform(0.8, 1.6), rng.uniform(1, 2), rng.uniform(0.5, 1.0), 1))
        bmesh.ops.create_icosphere(coal, subdivisions=2, radius=1.0, matrix=m)
    men = bmesh.new()
    for k in range(workers):
        p = Vector((rng.uniform(-1.4, 1.4), rng.uniform(-3.5, 3.5), 1.2))
        lean = rng.uniform(0.3, 0.7)
        body = p + Vector((0, 0, 0.9))
        m = Matrix.Translation(body) @ Matrix.Rotation(lean, 4, "X") @ Matrix.Diagonal((0.28, 0.22, 0.6, 1))
        bmesh.ops.create_icosphere(men, subdivisions=2, radius=1.0, matrix=m)
        head = body + Matrix.Rotation(lean, 3, "X") @ Vector((0, 0, 0.75))
        bmesh.ops.create_icosphere(men, subdivisions=1, radius=0.16, matrix=Matrix.Translation(head))
        beam(men, body + Vector((0.2, 0.3, 0.2)), body + Vector((0.6, 1.6, -1.0)), 0.07)  # shovel
    for nm, b, col in (("keel", bm, (0.015, 0.012, 0.01)), ("coal", coal, (0.008, 0.008, 0.008)), ("keelmen", men, (0.02, 0.015, 0.012))):
        o = obj_from_bm(f"{nm}", b, coll, diffuse(f"{nm}_mat", col), smooth=(nm != "keel"))
        o.matrix_world = rot
    for k in range(fires):
        fire(coll, rot @ Vector((rng.uniform(-1, 1), -4.5 + k * 4.5, 0.6)), size=rng.uniform(0.8, 1.2), warm=(k % 2 == 0))


# ─── The rest of the night ────────────────────────────────────────────────────

def town(coll):
    """Low dark shores with lit windows and a factory chimney flaring."""
    shore, lights = bmesh.new(), bmesh.new()
    for yaw in np.arange(-150, -10, 1.6):
        d = rng.uniform(900, 1300)
        p = polar(yaw, d, 0)
        h = rng.uniform(8, 26)
        m = Matrix.Translation(p + Vector((0, 0, h / 2))) @ Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Diagonal((rng.uniform(15, 40), 10, h, 1))
        bmesh.ops.create_cube(shore, size=1.0, matrix=m)
        for _ in range(rng.randint(0, 3)):
            q = p + Vector((rng.uniform(-10, 10), 0, rng.uniform(2, h - 2)))
            bmesh.ops.create_icosphere(lights, subdivisions=1, radius=rng.uniform(0.6, 1.2), matrix=Matrix.Translation(q - polar(yaw, 6)))
    for yaw in np.arange(20, 200, 2.0):
        d = rng.uniform(700, 1100)
        p = polar(yaw, d, 0)
        h = rng.uniform(5, 18)
        m = Matrix.Translation(p + Vector((0, 0, h / 2))) @ Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Diagonal((rng.uniform(15, 35), 10, h, 1))
        bmesh.ops.create_cube(shore, size=1.0, matrix=m)
    obj_from_bm("shore", shore, coll, diffuse("shore", (0.01, 0.01, 0.012), 0.9))
    lo = obj_from_bm("town_lights", lights, coll, glow("window", (1.0, 0.7, 0.35), 25.0))
    lo.visible_shadow = False
    C.set_mask(lo, (0, 0, 1))
    # factory chimney with a white flame, far left
    chim = bmesh.new()
    base = polar(-38, 1050, 0)
    beam(chim, base, base + Vector((0, 0, 55)), 7)
    obj_from_bm("chimney", chim, coll, diffuse("chimney", (0.01, 0.01, 0.01)))
    fl = bmesh.new()
    m = Matrix.Translation(base + Vector((0, 0, 64))) @ Matrix.Diagonal((5, 5, 12, 1))
    bmesh.ops.create_icosphere(fl, subdivisions=2, radius=1.0, matrix=m)
    fo = obj_from_bm("factory_flame", fl, coll, glow("factory_flame", (1.0, 0.9, 0.7), 22.0), smooth=True)
    C.set_mask(fo, (0, 0, 1))


def rowboat(coll):
    """Our small boat: we sit in the stern, the bow ahead of us."""
    bm = bmesh.new()
    hull(bm, 4.6, 1.5, 0.45, 0.35, deck=False)
    o = obj_from_bm("rowboat", bm, coll, diffuse("rowboat", (0.02, 0.014, 0.01), 0.8), smooth=False)
    o.modifiers.new("solid", "SOLIDIFY").thickness = 0.04
    o.location = (0, 1.4, 0.0)
    oars = bmesh.new()
    for sgn in (-1, 1):
        beam(oars, Vector((sgn * 0.7, 1.0, 0.5)), Vector((sgn * 2.6, -0.4, -0.15)), 0.06)
    obj_from_bm("oars", oars, coll, diffuse("oar", (0.08, 0.06, 0.04)))


def flotsam(coll):
    """The buoy on the left and a plank floating near us, as in the painting."""
    bm = bmesh.new()
    p = polar(-24, 22, 0.2)
    m = Matrix.Translation(p) @ Matrix.Diagonal((0.9, 0.9, 1.0, 1))
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0, matrix=m)
    beam(bm, polar(22, 9, 0.02), polar(30, 11, 0.02), 0.6, 0.12)
    obj_from_bm("flotsam", bm, coll, diffuse("flotsam", (0.04, 0.03, 0.02)), smooth=True)


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    FIRES.clear()
    scene = C.clear_scene()
    C.use_gpu(scene)
    river = C.collection("River")
    ships = C.collection("Ships")
    keels = C.collection("Keels")
    far = C.collection("Far")
    build_sky(scene)
    build_water(river)
    # tall ships on the left, sails set and silvered by the moon
    ship(ships, "ship_left_near", polar(-48, 58, 0), math.radians(-120), length=36, masts=(30, 34, 27), sails="set")
    ship(ships, "ship_left_far", polar(-22, 150, 0), math.radians(-100), length=32, masts=(27, 30, 24), sails="set")
    # colliers moored on the right, with keels alongside and fires burning
    ship(ships, "collier_1", polar(42, 70, 0), math.radians(-80), length=34, masts=(29, 32, 25), sails="furled")
    ship(ships, "collier_2", polar(70, 110, 0), math.radians(-70), length=30, masts=(26, 29, 23), sails="furled")
    ship(ships, "collier_3", polar(115, 160, 0), math.radians(-60), length=32, masts=(27, 30, 24), sails="furled")
    ship(ships, "ship_behind", polar(-150, 120, 0), math.radians(60), length=34, masts=(28, 31, 25), sails="furled")
    keel(keels, polar(36, 52, 0.3), math.radians(-85), fires=2, workers=3)
    keel(keels, polar(58, 60, 0.3), math.radians(-60), fires=1, workers=3)
    keel(keels, polar(84, 92, 0.3), math.radians(-40), fires=1, workers=2)
    smoke(keels)
    town(far)
    rowboat(river)
    flotsam(river)

    cy = scene.cycles
    cy.samples = 128 if preview else 768
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.015
    cy.use_denoising = True
    cy.max_bounces = 6
    cy.volume_bounces = 1
    cy.volume_step_rate = 1.5
    cy.sample_clamp_indirect = 5.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    C.set_view_transform("AgX", "AgX - Medium High Contrast", exposure=-0.1)
    C.pano_camera(EYE)
    C.set_resolution(1024 if preview else 8192)
    return scene


if __name__ == "__main__":
    build()
