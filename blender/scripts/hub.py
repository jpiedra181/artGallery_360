"""Hub: a dark, flooded gallery with the four paintings, one per wall.

The viewer stands on a small timber dais in the middle of the room. The floor
is covered by a sheet of still water that mirrors the lit canvases; the web
viewer animates ripples on it using the mask pass (R channel).

Mask pass
  R  water surface
(Painting hover/hit-testing is analytic in the viewer, from hub-geometry.json.)
"""

import math
import os

import bmesh
import bpy
from mathutils import Vector

import common as C

ROOM = 4.2          # distance from the viewer to each wall (m)
CEILING = 4.9
WATER_Z = 0.0
FLOOR_Z = -0.07
DAIS_TOP = 0.06
EYE = DAIS_TOP + 1.6
HANG = 1.78         # height of the painting centres

# id, texture, yaw (deg), image height (m), kind
PAINTINGS = [
    ("wave", "wave.jpg", 0, 1.72, "print"),
    ("rain", "rain.jpg", 90, 2.05, "print"),
    ("stillness", "stillness.jpg", 180, 1.95, "oil"),
    ("moonlight", "moonlight.jpg", 270, 1.85, "oil"),
]

WALL_TINT = (0.13, 0.17, 0.19)
REFLECT_MIN = 0.42  # mirror strength looking straight down (physical water ≈ 0.02)
COVE_COLOR = (0.70, 0.80, 1.0)
WASHER_POWER = 38
LIGHT_COLOR = (1.0, 0.86, 0.72)


def yaw_dir(deg):
    a = math.radians(deg)
    return Vector((math.sin(a), math.cos(a), 0.0))


def quad(name, w, h, coll, uv=True):
    """Vertical rectangle in local XZ, facing -Y, centred on the origin."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in ((-w / 2, 0, -h / 2), (w / 2, 0, -h / 2), (w / 2, 0, h / 2), (-w / 2, 0, h / 2))]
    face = bm.faces.new(vs)
    if uv:
        layer = bm.loops.layers.uv.new("UVMap")
        for loop, co in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            loop[layer].uv = co
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    # make sure the face points towards -Y (towards the viewer)
    if mesh.polygons[0].normal.y > 0:
        mesh.flip_normals()
    return C.mesh_object(name, mesh, coll)


def box(name, size, coll, location=(0, 0, 0)):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    return C.mesh_object(name, mesh, coll, location)


def place_on_wall(obj, yaw, inset, z):
    d = yaw_dir(yaw)
    obj.location = d * (ROOM - inset) + Vector((0, 0, z))
    obj.rotation_euler = (0, 0, -math.radians(yaw))


def frame_mesh(name, outer_w, outer_h, inner_w, inner_h, depth, coll):
    """Rectangular moulding: outer box minus inner opening, front face at y=0."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    ow, oh, iw, ih = outer_w / 2, outer_h / 2, inner_w / 2, inner_h / 2
    rings = []
    for y in (0.0, depth):
        rings.append([bm.verts.new((x, y, z)) for x, z in ((-ow, -oh), (ow, -oh), (ow, oh), (-ow, oh))])
        rings.append([bm.verts.new((x, y, z)) for x, z in ((-iw, -ih), (iw, -ih), (iw, ih), (-iw, ih))])
    of, inf, ob, inb = rings
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((of[i], of[j], inf[j], inf[i]))      # front
        bm.faces.new((of[j], of[i], ob[i], ob[j]))        # outer side
        bm.faces.new((inf[i], inf[j], inb[j], inb[i]))    # inner reveal
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    return C.mesh_object(name, mesh, coll)


# ─── Materials ────────────────────────────────────────────────────────────────

def painting_material(pid, texture, kind):
    mat, nt, out = C.new_material(f"painting_{pid}")
    bsdf = C.principled(nt)
    img = C.image_node(nt, os.path.join(C.SOURCES_DIR, "tex", texture), -500, 0, extension="EXTEND")
    nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.62 if kind == "oil" else 0.8
    # canvas weave / paper tooth as a fine bump
    noise = C.node(nt, "ShaderNodeTexNoise", -500, -350)
    noise.inputs["Scale"].default_value = 900.0
    noise.inputs["Detail"].default_value = 2.0
    bump = C.node(nt, "ShaderNodeBump", -200, -350)
    bump.inputs["Strength"].default_value = 0.08 if kind == "oil" else 0.04
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return mat


def simple_material(name, color, roughness=0.5, metallic=0.0, specular=0.5):
    mat, nt, out = C.new_material(name)
    bsdf = C.principled(nt)
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Specular IOR Level"].default_value = specular
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return mat


def water_material():
    """Still, dark water read as a black mirror: refraction shows the floor
    straight down, a boosted Fresnel mirror takes over towards the walls."""
    mat, nt, out = C.new_material("water")
    refr = C.node(nt, "ShaderNodeBsdfRefraction", 0, 150)
    refr.inputs["Color"].default_value = (0.5, 0.58, 0.58, 1)
    refr.inputs["Roughness"].default_value = 0.0
    refr.inputs["IOR"].default_value = 1.333
    gloss = C.node(nt, "ShaderNodeBsdfGlossy", 0, -50)
    gloss.inputs["Color"].default_value = (0.92, 0.95, 0.97, 1)
    gloss.inputs["Roughness"].default_value = 0.006
    fres = C.node(nt, "ShaderNodeFresnel", -400, 250)
    fres.inputs["IOR"].default_value = 1.333
    remap = C.node(nt, "ShaderNodeMapRange", -200, 250)
    remap.inputs["To Min"].default_value = REFLECT_MIN
    remap.inputs["To Max"].default_value = 1.0
    nt.links.new(fres.outputs[0], remap.inputs["Value"])
    mix = C.node(nt, "ShaderNodeMixShader", 300, 0)
    nt.links.new(remap.outputs["Result"], mix.inputs[0])
    nt.links.new(refr.outputs[0], mix.inputs[1])
    nt.links.new(gloss.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def haze_material(density):
    mat, nt, out = C.new_material("haze")
    vol = C.node(nt, "ShaderNodeVolumePrincipled", 200, 0)
    vol.inputs["Density"].default_value = density
    vol.inputs["Anisotropy"].default_value = 0.35
    vol.inputs["Color"].default_value = (0.85, 0.9, 1.0, 1)
    nt.links.new(vol.outputs[0], out.inputs["Volume"])
    return mat


# ─── Build ────────────────────────────────────────────────────────────────────

def build(preview=True):
    scene = C.clear_scene()
    C.use_gpu(scene)
    room = C.collection("Room")
    art = C.collection("Art")
    lights = C.collection("Lights")

    # World: never seen (closed room) but keep it black so nothing leaks.
    wnt = scene.world
    wnt.use_nodes = True
    bg = next(n for n in wnt.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0, 0, 0, 1)

    # Room shell -------------------------------------------------------------
    wall_mat = C.pbr_material("wall", "plastered_wall_04", scale=1 / 3.2, tint=WALL_TINT, roughness_mul=1.0, bump=0.25, mapping="OBJECT")
    ceil_mat = C.pbr_material("ceiling", "plastered_wall_04", scale=1 / 3.2, tint=(0.05, 0.055, 0.06), bump=0.2, mapping="OBJECT")
    floor_mat = C.pbr_material("floor", "square_floor", scale=1 / 2.0, tint=(0.12, 0.125, 0.13), roughness_mul=0.8, bump=0.4, mapping="OBJECT")
    dais_mat = C.pbr_material("dais", "oak_wood_planks", scale=1 / 1.2, tint=(0.32, 0.27, 0.23), roughness_mul=0.9, bump=0.5, mapping="OBJECT")

    span = ROOM * 2
    height = CEILING - FLOOR_Z
    for yaw in (0, 90, 180, 270):
        w = quad(f"wall_{yaw}", span, height, room, uv=False)
        place_on_wall(w, yaw, 0.0, FLOOR_Z + height / 2)
        C.assign(w, wall_mat)

    bpy.ops.mesh.primitive_plane_add(size=span, location=(0, 0, FLOOR_Z))
    floor = bpy.context.active_object
    floor.name = "floor"
    C.assign(floor, floor_mat)

    bpy.ops.mesh.primitive_plane_add(size=span, location=(0, 0, WATER_Z))
    water = bpy.context.active_object
    water.name = "water"
    C.assign(water, water_material())
    C.set_mask(water, (1, 0, 0))

    bpy.ops.mesh.primitive_plane_add(size=span, location=(0, 0, CEILING))
    ceiling = bpy.context.active_object
    ceiling.name = "ceiling"
    ceiling.data.flip_normals()
    C.assign(ceiling, ceil_mat)

    dais = box("dais", (1.4, 1.4, DAIS_TOP - FLOOR_Z), room, (0, 0, (DAIS_TOP + FLOOR_Z) / 2))
    C.assign(dais, dais_mat)

    for obj in (floor, water, ceiling):
        for c in obj.users_collection:
            c.objects.unlink(obj)
        room.objects.link(obj)

    # Paintings ----------------------------------------------------------------
    frame_mat = simple_material("frame_black", (0.012, 0.012, 0.012), roughness=0.35)
    gilt_mat = simple_material("frame_bronze", (0.30, 0.22, 0.13), roughness=0.38, metallic=0.85)
    mat_board = simple_material("mat_board", (0.80, 0.77, 0.70), roughness=0.9)
    fixture_mat = simple_material("fixture", (0.02, 0.02, 0.02), roughness=0.4, metallic=0.6)
    lens_mat = C.emission_material("fixture_lens", LIGHT_COLOR, 6.0)

    geometry = []
    for pid, texture, yaw, h, kind in PAINTINGS:
        img = bpy.data.images.load(os.path.join(C.SOURCES_DIR, "tex", texture), check_existing=True)
        aspect = img.size[0] / img.size[1]
        w = h * aspect

        canvas = quad(f"canvas_{pid}", w, h, art)
        place_on_wall(canvas, yaw, 0.075 if kind == "oil" else 0.05, HANG)
        C.assign(canvas, painting_material(pid, texture, kind))

        if kind == "print":
            margin = 0.26
            mw, mh = w + margin * 2, h + margin * 2
            board = quad(f"mat_{pid}", mw, mh, art, uv=False)
            place_on_wall(board, yaw, 0.045, HANG)
            C.assign(board, mat_board)
            fr = frame_mesh(f"frame_{pid}", mw + 0.09, mh + 0.09, mw, mh, 0.055, art)
            place_on_wall(fr, yaw, 0.0, HANG)
            # frame front sits at the wall minus its depth
            fr.location -= yaw_dir(yaw) * 0.055
            C.assign(fr, frame_mat)
            outer_h = mh + 0.09
        else:
            fw = 0.11
            fr = frame_mesh(f"frame_{pid}", w + fw * 2, h + fw * 2, w, h, 0.09, art)
            place_on_wall(fr, yaw, 0.0, HANG)
            fr.location -= yaw_dir(yaw) * 0.09
            C.assign(fr, gilt_mat)
            outer_h = h + fw * 2

        dist = ROOM - (0.075 if kind == "oil" else 0.05)
        deg = math.degrees
        geometry.append({
            "id": pid,
            "yaw": yaw,
            "pitch": round(deg(math.atan2(HANG - EYE, dist)), 3),
            "halfWidth": round(deg(math.atan2(w / 2, dist)), 3),
            "top": round(deg(math.atan2(HANG + h / 2 - EYE, dist)), 3),
            "bottom": round(deg(math.atan2(HANG - h / 2 - EYE, dist)), 3),
            "frameBottom": round(deg(math.atan2(HANG - outer_h / 2 - EYE, ROOM)), 3),
            # metric description of the canvas plane for exact hit-testing
            "distance": round(dist, 4),
            "width": round(w, 4),
            "height": round(h, 4),
            "centerY": round(HANG - EYE, 4),
        })

        # Ceiling spot aimed at the canvas centre
        d = yaw_dir(yaw)
        spot_pos = d * (ROOM - 1.9) + Vector((0, 0, CEILING - 0.35))
        target = d * (ROOM - 0.08) + Vector((0, 0, HANG))
        ld = bpy.data.lights.new(f"spot_{pid}", "SPOT")
        ld.energy = 480
        ld.color = LIGHT_COLOR
        dist = (target - spot_pos).length
        half = max(w, outer_h) / 2 + 0.35
        ld.spot_size = 2 * math.atan(half / dist) + math.radians(6)
        ld.spot_blend = 0.55
        ld.shadow_soft_size = 0.06
        lo = bpy.data.objects.new(f"spot_{pid}", ld)
        lo.location = spot_pos
        lo.rotation_euler = (target - spot_pos).to_track_quat("-Z", "Y").to_euler()
        lights.objects.link(lo)

        # Visible fixture: a small can on a stem, lens facing the painting
        bpy.ops.mesh.primitive_cylinder_add(radius=0.065, depth=0.2, vertices=32, location=spot_pos)
        can = bpy.context.active_object
        can.name = f"fixture_{pid}"
        can.rotation_euler = lo.rotation_euler
        can.location = spot_pos - (target - spot_pos).normalized() * 0.11
        C.assign(can, fixture_mat)
        bpy.ops.mesh.primitive_circle_add(radius=0.055, vertices=32, fill_type="NGON", location=spot_pos)
        lens = bpy.context.active_object
        lens.name = f"lens_{pid}"
        lens.rotation_euler = lo.rotation_euler
        lens.location = spot_pos - (target - spot_pos).normalized() * 0.005
        C.assign(lens, lens_mat)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.012, depth=0.3, location=(spot_pos.x, spot_pos.y, CEILING - 0.15))
        stem = bpy.context.active_object
        stem.name = f"stem_{pid}"
        C.assign(stem, fixture_mat)
        for o in (can, lens, stem):
            for c in o.users_collection:
                c.objects.unlink(o)
            lights.objects.link(o)

    # Wall washers: hidden linear lights along the top of each wall graze the
    # plaster with a cool wash that fades towards the water, so the room reads
    # as a space without competing with the paintings.
    for yaw in (0, 90, 180, 270):
        wd = bpy.data.lights.new(f"washer_{yaw}", "AREA")
        wd.shape = "RECTANGLE"
        wd.size = span - 0.4
        wd.size_y = 0.08
        wd.energy = WASHER_POWER
        wd.color = COVE_COLOR
        wd.spread = math.radians(70)
        wo = bpy.data.objects.new(f"washer_{yaw}", wd)
        d = yaw_dir(yaw)
        wo.location = d * (ROOM - 0.35) + Vector((0, 0, CEILING - 0.04))
        # point down and slightly towards the wall
        aim = d * 0.45 + Vector((0, 0, -1))
        # local Y stays in the vertical plane, so the long X side runs along the wall
        wo.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()
        wo.visible_camera = False
        wo.visible_glossy = False
        lights.objects.link(wo)

    # Faint cool fill from above so the corners are not pure black
    fill = bpy.data.lights.new("fill", "AREA")
    fill.shape = "SQUARE"
    fill.size = 3.0
    fill.energy = 35
    fill.color = (0.62, 0.72, 0.9)
    fo = bpy.data.objects.new("fill", fill)
    fo.location = (0, 0, CEILING - 0.05)
    fo.visible_camera = False
    lights.objects.link(fo)

    # Atmosphere: a whisper of haze so the light cones read
    haze = box("haze", (span - 0.02, span - 0.02, CEILING - WATER_Z - 0.02), room, (0, 0, (CEILING + WATER_Z) / 2))
    C.assign(haze, haze_material(0.0035))
    haze["volume_only"] = True

    cam = C.pano_camera(EYE)

    # Hand the exact painting geometry to the web viewer (hotspots, zoom-in).
    import json
    out = os.path.join(C.ROOT, "src", "data", "hub-geometry.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"eye": EYE, "water": EYE - WATER_Z, "room": ROOM, "paintings": geometry}, f, indent=2)

    # Render settings ----------------------------------------------------------
    cy = scene.cycles
    cy.samples = 256 if preview else 1024
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.01
    cy.use_denoising = True
    cy.max_bounces = 8
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 4
    cy.transmission_bounces = 8
    cy.volume_bounces = 0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.blur_glossy = 1.0
    cy.sample_clamp_indirect = 8.0
    C.set_view_transform("AgX", "AgX - Base Contrast", exposure=0.6)
    C.set_resolution(1024 if preview else 8192)
    return scene


if __name__ == "__main__":
    build()
