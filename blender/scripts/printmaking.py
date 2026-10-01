"""Helpers for the two woodblock-print worlds (Hokusai, Hiroshige).

Everything is lit by emission only: flat colours, exactly as specified, so
the render reads like inked and printed blocks. Outlines and paper grain are
added afterwards from data passes (see scripts/looks.py).
"""

import math

import bpy
import numpy as np

import common as C


def hex_to_linear(h):
    h = h.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(C._srgb_to_linear(c) for c in rgb)


def flat(name, color_hex):
    """Unlit flat colour."""
    return C.emission_material(name, hex_to_linear(color_hex), 1.0)


def setup_render(scene, samples=48):
    scene.render.engine = "CYCLES"
    C.use_gpu(scene)
    cy = scene.cycles
    cy.samples = samples
    cy.use_adaptive_sampling = False
    cy.use_denoising = False
    cy.max_bounces = 0
    cy.diffuse_bounces = 0
    cy.glossy_bounces = 0
    cy.transmission_bounces = 0
    cy.volume_bounces = 0
    cy.transparent_max_bounces = 8
    cy.filter_width = 1.2
    C.set_view_transform("Standard", "None", 0.0)


def mesh_from_arrays(name, verts, faces, coll=None):
    """Build a mesh quickly from numpy arrays (verts N×3, quad faces M×4)."""
    mesh = bpy.data.meshes.new(name)
    verts = np.asarray(verts, dtype=np.float32)
    faces = np.asarray(faces, dtype=np.int32)
    mesh.vertices.add(len(verts))
    mesh.vertices.foreach_set("co", verts.ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.ravel())
    mesh.polygons.add(len(faces))
    sides = faces.shape[1]
    mesh.polygons.foreach_set("loop_start", np.arange(0, faces.size, sides, dtype=np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(len(faces), sides, dtype=np.int32))
    mesh.update(calc_edges=True)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def add_point_attribute(obj, name, values):
    attr = obj.data.attributes.new(name, "FLOAT", "POINT")
    attr.data.foreach_set("value", np.asarray(values, dtype=np.float32))


def add_uv(obj, uv_per_vertex):
    """UV layer from per-vertex coordinates (N×2)."""
    mesh = obj.data
    layer = mesh.uv_layers.new(name="UVMap")
    idx = np.zeros(len(mesh.loops), dtype=np.int32)
    mesh.loops.foreach_get("vertex_index", idx)
    uv = np.asarray(uv_per_vertex, dtype=np.float32)[idx]
    layer.data.foreach_set("uv", uv.ravel())


def grid_faces(rows, cols, wrap_cols=False):
    """Quad indices for a rows×cols vertex grid."""
    r, c = np.meshgrid(np.arange(rows - 1), np.arange(cols if wrap_cols else cols - 1), indexing="ij")
    c1 = (c + 1) % cols
    a = r * cols + c
    b = r * cols + c1
    d = (r + 1) * cols + c
    e = (r + 1) * cols + c1
    return np.stack([a, b, e, d], -1).reshape(-1, 4)


def catmull_rom(points, samples):
    """Smooth curve through 2D/3D points, resampled evenly by arc length."""
    p = np.asarray(points, dtype=np.float64)
    p = np.vstack([p[0] * 2 - p[1], p, p[-1] * 2 - p[-2]])
    dense = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for t in np.linspace(0, 1, 24, endpoint=False):
            t2, t3 = t * t, t * t * t
            dense.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    dense.append(p[-2])
    dense = np.array(dense)
    seg = np.linalg.norm(np.diff(dense, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    target = np.linspace(0, s[-1], samples)
    return np.stack([np.interp(target, s, dense[:, k]) for k in range(dense.shape[1])], -1)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def sky_world(scene, stops, clouds=None):
    """Gradient sky by elevation. stops: [(elevation 0..1, hex)], where 0 is the
    horizon and 1 the zenith. Optional soft clouds: dict(color, scale, cover)."""
    world = scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = C.node(nt, "ShaderNodeOutputWorld", 900, 0)
    bg = C.node(nt, "ShaderNodeBackground", 700, 0)
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    coord = C.node(nt, "ShaderNodeTexCoord", -900, 0)
    sep = C.node(nt, "ShaderNodeSeparateXYZ", -700, 0)
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    # Generated coords of the world are the view direction
    ramp = C.node(nt, "ShaderNodeValToRGB", -400, 0)
    cr = ramp.color_ramp
    cr.interpolation = "EASE"
    while len(cr.elements) > 1:
        cr.elements.remove(cr.elements[-1])
    first = True
    for pos, hx in stops:
        el = cr.elements[0] if first else cr.elements.new(pos)
        el.position = pos
        el.color = (*hex_to_linear(hx), 1)
        first = False
    clampz = C.node(nt, "ShaderNodeMath", -550, 0, operation="MAXIMUM")
    clampz.inputs[1].default_value = 0.0
    nt.links.new(sep.outputs["Z"], clampz.inputs[0])
    nt.links.new(clampz.outputs[0], ramp.inputs["Fac"])
    color = ramp.outputs["Color"]
    if clouds:
        noise = C.node(nt, "ShaderNodeTexNoise", -700, -300)
        noise.inputs["Scale"].default_value = clouds.get("scale", 3.0)
        noise.inputs["Detail"].default_value = 3.0
        noise.inputs["Roughness"].default_value = 0.45
        mapping = C.node(nt, "ShaderNodeMapping", -850, -300)
        mapping.inputs["Scale"].default_value = (1.0, 1.0, 3.0)  # flatten clouds into bands
        nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs[0], noise.inputs["Vector"])
        band = C.node(nt, "ShaderNodeMapRange", -500, -300)
        band.inputs["From Min"].default_value = clouds.get("low", 0.06)
        band.inputs["From Max"].default_value = clouds.get("high", 0.5)
        band.interpolation_type = "SMOOTHSTEP"
        nt.links.new(sep.outputs["Z"], band.inputs["Value"])
        shape = C.node(nt, "ShaderNodeMapRange", -500, -500)
        shape.inputs["From Min"].default_value = clouds.get("cover", 0.55)
        shape.inputs["From Max"].default_value = clouds.get("cover", 0.55) + 0.06
        nt.links.new(noise.outputs["Fac"], shape.inputs["Value"])
        mul = C.node(nt, "ShaderNodeMath", -300, -400, operation="MULTIPLY")
        nt.links.new(shape.outputs["Result"], mul.inputs[0])
        nt.links.new(band.outputs["Result"], mul.inputs[1])
        color = C.mix_color(nt, color, hex_to_linear(clouds["color"]), mul.outputs[0], x=200, y=-200)
    nt.links.new(color, bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    return world
