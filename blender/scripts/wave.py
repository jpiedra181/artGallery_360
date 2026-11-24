"""Room I — Wave. Inside Hokusai's "Under the Wave off Kanagawa".

The plate the wave is printed on: sea, sky, Mount Fuji small on the horizon
and the boat the viewer rides in. The great wave itself, the swells on either
side and the other two boats are drawn live over it, because they move
(src/scripts/worlds/great-wave.ts). Flat woodblock colours (emission only);
outlines and paper are added in post (scripts/looks.py).

Mask pass
  R  sea surface      G  sky      B  our boat, in front of the drawn wave
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
    (7.3, 0.22, -70, 0.85, 1.9),
    (4.6, 0.14, 20, 0.9, 5.2),
    (3.1, 0.08, -35, 0.9, 0.4),
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
    for ring in rings[1:]:
        # the boards rise with the keel towards the bow
        z = max(floor_z, min(v.co.z for v in ring) + 0.05)
        xs = [v.co.x for v in ring if v.co.z <= z + 0.02]
        y = ring[0].co.y
        half = max(0.012, 0.98 * max(abs(x) for x in xs)) if xs else 0.012
        left.append(bm.verts.new((-half, y, z)))
        right.append(bm.verts.new((half, y, z)))
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
    # the sides in shade, by which way they face in the boat: its starboard side is turned from the light
    side = C.node(nt, "ShaderNodeVectorMath", -450, -150, operation="DOT_PRODUCT")
    side.inputs[1].default_value = (-1.0, 0.0, 0.0)
    nt.links.new(geo.outputs["Normal"], side.inputs[0])
    dark = C.node(nt, "ShaderNodeMath", -300, -100, operation="GREATER_THAN")
    dark.inputs[1].default_value = 0.35
    nt.links.new(side.outputs["Value"], dark.inputs[0])
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


def ellipsoid(bm, at, size, turn=None, segments=14, rings=9):
    m = Matrix.Translation(at) @ (turn or Matrix.Identity(4)) @ Matrix.Diagonal((*size, 1))
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0, matrix=m)


def rower(body, heads, hair, at, scale=1.0):
    """An oarsman bent double over his oar, as in the print: a rounded back, a
    shaven crown and the hair tied on top. Faces +y."""
    fwd, side, up = Vector((0, 1, 0)), Vector((1, 0, 0)), Vector((0, 0, 1))
    ellipsoid(body, at + up * 0.17 * scale, (0.25 * scale, 0.24 * scale, 0.18 * scale))
    back = at + (fwd * 0.2 + up * 0.36) * scale
    ellipsoid(body, back, (0.25 * scale, 0.19 * scale, 0.34 * scale), Matrix.Rotation(math.radians(-58), 4, "X"))
    head = back + (fwd * 0.36 + up * 0.04) * scale
    ellipsoid(heads, head, (0.115 * scale, 0.125 * scale, 0.12 * scale), segments=16, rings=10)
    ellipsoid(hair, head + (up * 0.035 - fwd * 0.04) * scale, (0.122 * scale, 0.115 * scale, 0.112 * scale), segments=16, rings=10)
    ellipsoid(hair, head + (up * 0.14 - fwd * 0.05) * scale, (0.03 * scale, 0.06 * scale, 0.03 * scale), segments=10, rings=6)
    for sgn in (-1, 1):
        a = back + (side * sgn * 0.2 + up * 0.05) * scale
        b = a + (fwd * 0.4 + side * sgn * 0.06 - up * 0.22) * scale
        d = b - a
        ellipsoid(body, (a + b) / 2, (0.06 * scale, 0.06 * scale, d.length / 2), d.to_track_quat("Z", "Y").to_matrix().to_4x4(), 8, 6)


def boat(name, location, heading, pitch, roll, coll, rows=5, first_row=-1.6):
    """The boat we are in, with its crew in pairs behind us."""
    obj = hull(name, coll=coll)
    obj.location = location
    obj.rotation_euler = (pitch, roll, -heading)
    parts = {"crew": (bmesh.new(), CLOTH), "heads": (bmesh.new(), SKIN), "hair": (bmesh.new(), INK), "oars": (bmesh.new(), BOAT_DARK)}
    for i in range(rows):
        for sgn in (-1, 1):
            y = first_row + i * 1.05 + (0.16 if sgn > 0 else 0.0)
            rower(parts["crew"][0], parts["heads"][0], parts["hair"][0], Vector((sgn * 0.36, y, -0.16)), 0.98 + 0.06 * rng.random())
            a = Vector((sgn * 0.5, y + 0.45, 0.32))
            b = Vector((sgn * 2.9, y - 0.55, -0.62))
            d = b - a
            m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((0.04, 0.04, d.length / 2, 1))
            bmesh.ops.create_cone(parts["oars"][0], cap_ends=True, segments=6, radius1=1, radius2=1, depth=2, matrix=m)
    for part, (bm, colour) in parts.items():
        mesh = bpy.data.meshes.new(f"{name}_{part}")
        bm.to_mesh(mesh)
        bm.free()
        o = bpy.data.objects.new(f"{name}_{part}", mesh)
        coll.objects.link(o)
        o.parent = obj
        for p in o.data.polygons:
            p.use_smooth = True
        C.assign(o, P.flat(part, colour))
        C.set_mask(o, (0, 0, 1))
    C.set_mask(obj, (0, 0, 1))
    return obj


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    scene = C.clear_scene()
    P.setup_render(scene, samples=24 if preview else 64)
    sea_c = C.collection("Sea")
    boat_c = C.collection("Boats")
    far_c = C.collection("Far")

    P.sky_world(
        scene,
        [(0.0, HORIZON), (0.07, "#b9b19c"), (0.2, PAPER), (0.75, "#e3d6b8"), (1.0, "#d2c39f")],
        clouds={"color": "#f2ead6", "scale": 2.4, "cover": 0.56, "low": 0.08, "high": 0.4},
    )
    build_sea(sea_c)
    fuji(far_c)

    trough = sea_height_at(0.0, 0.0)
    floor = trough + 0.32  # the floorboards of our boat, clear of the chop
    # We sit near the bow; the crew rows behind us. (The hull runs from
    # 3.25 m behind its origin to 9.75 m ahead of it.)
    boat("our_boat", Vector((0, -8.4, floor + 0.35)), 0.0, 0.0, math.radians(-1.5), boat_c, rows=6, first_row=0.4)

    C.pano_camera(floor + 0.95)
    C.set_resolution(1024 if preview else 8192)
    print(f"trough {trough:.2f}")
    return scene


if __name__ == "__main__":
    build()
