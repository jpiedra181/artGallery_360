"""Shared helpers for the Inside the Frame Blender scenes.

Every world is generated from code so it can be rebuilt and tweaked
reproducibly. Run a scene script inside Blender with:

    exec(open(r"<repo>/blender/scripts/<scene>.py").read())

Conventions
-----------
* Z is up, the viewer stands at the origin looking down +Y (yaw 0).
* The equirectangular camera maps +Y to the image centre and +X to the right,
  which is what the web viewer expects (yaw grows clockwise seen from above).
"""

import math
import os

import bpy

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..")) if "__file__" in globals() else r"C:/Desarrollo/Javier/Work/Art Gallery"
BLENDER_DIR = os.path.join(ROOT, "blender")
SOURCES_DIR = os.path.join(BLENDER_DIR, "sources")
RENDERS_DIR = os.path.join(BLENDER_DIR, "renders")


# ─── Scene lifecycle ──────────────────────────────────────────────────────────

def clear_scene():
    """Remove every datablock that a scene script creates, keeping preferences
    and add-ons intact (read_factory_settings would disable the MCP add-on)."""
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(scene.collection.children):
        scene.collection.children.unlink(coll)
    for datablocks in (
        bpy.data.collections,
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.images,
        bpy.data.textures,
        bpy.data.node_groups,
        bpy.data.worlds,
    ):
        for block in list(datablocks):
            datablocks.remove(block)
    world = bpy.data.worlds.new("World")
    scene.world = world
    return scene


def use_gpu(scene=None):
    scene = scene or bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.refresh_devices()
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == backend
            scene.cycles.device = "GPU"
            return backend
    scene.cycles.device = "CPU"
    return "CPU"


def pano_camera(height=1.6, name="Pano"):
    data = bpy.data.cameras.new(name)
    data.type = "PANO"
    data.panorama_type = "EQUIRECTANGULAR"
    data.clip_start = 0.02
    data.clip_end = 5000
    cam = bpy.data.objects.new(name, data)
    cam.location = (0.0, 0.0, height)
    cam.rotation_euler = (math.radians(90), 0.0, 0.0)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def set_resolution(width, height=None, scene=None):
    scene = scene or bpy.context.scene
    scene.render.resolution_x = width
    scene.render.resolution_y = height or width // 2
    scene.render.resolution_percentage = 100


def set_view_transform(name, look=None, exposure=0.0, scene=None):
    scene = scene or bpy.context.scene
    vs = scene.view_settings
    vs.view_transform = name
    if look:
        try:
            vs.look = look
        except TypeError:
            vs.look = "None"
    vs.exposure = exposure


# ─── Collections / objects ────────────────────────────────────────────────────

def collection(name):
    coll = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if coll.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(coll)
    return coll


def link(obj, coll=None):
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def mesh_object(name, mesh, coll=None, location=(0, 0, 0), rotation=(0, 0, 0)):
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    return link(obj, coll)


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def set_mask(obj, rgb):
    """Colour used by the mask pass (R water, G sky/atmosphere, B emitters/ids).

    The mask is rendered through the Standard (sRGB) view transform, so the
    value is linearised here and lands in the PNG exactly as given."""
    obj["mask"] = tuple(_srgb_to_linear(c) for c in rgb)


# ─── Materials ────────────────────────────────────────────────────────────────

def node(nt, kind, x=0, y=0, **props):
    n = nt.nodes.new(kind)
    n.location = (x, y)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def sock(sockets, identifier):
    """Find a socket by identifier (names are ambiguous on Mix nodes)."""
    return next(s for s in sockets if s.identifier == identifier)


def mix_color(nt, a, b, factor=1.0, blend="MIX", x=0, y=0):
    """Colour Mix node; a/b/factor may be sockets or constant values."""
    mix = node(nt, "ShaderNodeMix", x, y)
    mix.data_type = "RGBA"
    mix.blend_type = blend
    for ident, value in (("Factor_Float", factor), ("A_Color", a), ("B_Color", b)):
        target = sock(mix.inputs, ident)
        if hasattr(value, "is_output"):
            nt.links.new(value, target)
        elif ident == "Factor_Float":
            target.default_value = value
        else:
            target.default_value = (*value[:3], 1.0)
    return sock(mix.outputs, "Result_Color")


def new_material(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = node(nt, "ShaderNodeOutputMaterial", 600, 0)
    return mat, nt, out


def principled(nt):
    return node(nt, "ShaderNodeBsdfPrincipled", 200, 0)


def image_node(nt, path, x=-400, y=0, non_color=False, extension="REPEAT"):
    img = bpy.data.images.load(path, check_existing=True)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    n = node(nt, "ShaderNodeTexImage", x, y)
    n.image = img
    n.extension = extension
    return n


TEXTURES_DIR = os.path.join(BLENDER_DIR, "textures")


def pbr_material(name, texture, scale=1.0, tint=None, roughness_mul=1.0, bump=0.3, mapping="UV"):
    """Principled material from a Poly Haven texture set saved in blender/textures.

    texture: asset id, e.g. "plastered_wall_04" (expects *_Diffuse/_Rough/_nor_gl_2k.jpg).
    mapping: "UV" or "OBJECT" (box projection in object space, metres).
    tint: optional RGB multiplied over the albedo (to darken / recolour).
    """
    mat, nt, out = new_material(name)
    bsdf = principled(nt)
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    coord = node(nt, "ShaderNodeTexCoord", -1200, 0)
    mp = node(nt, "ShaderNodeMapping", -1000, 0)
    mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(coord.outputs["UV" if mapping == "UV" else "Object"], mp.inputs["Vector"])

    def tex(suffix, y, non_color):
        n = image_node(nt, os.path.join(TEXTURES_DIR, f"{texture}_{suffix}_2k.jpg"), -700, y, non_color)
        if mapping != "UV":
            n.projection = "BOX"
            n.projection_blend = 0.2
        nt.links.new(mp.outputs[0], n.inputs["Vector"])
        return n

    diff = tex("Diffuse", 300, False)
    rough = tex("Rough", 0, True)
    nor = tex("nor_gl", -300, True)
    albedo = diff.outputs["Color"]
    if tint is not None:
        mix = node(nt, "ShaderNodeMix", -300, 300)
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        sock(mix.inputs, "Factor_Float").default_value = 1.0
        nt.links.new(albedo, sock(mix.inputs, "A_Color"))
        sock(mix.inputs, "B_Color").default_value = (*tint, 1.0)
        albedo = sock(mix.outputs, "Result_Color")
    nt.links.new(albedo, bsdf.inputs["Base Color"])
    rmul = node(nt, "ShaderNodeMath", -300, 0, operation="MULTIPLY")
    rmul.inputs[1].default_value = roughness_mul
    nt.links.new(rough.outputs["Color"], rmul.inputs[0])
    nt.links.new(rmul.outputs[0], bsdf.inputs["Roughness"])
    nmap = node(nt, "ShaderNodeNormalMap", -300, -300)
    nmap.inputs["Strength"].default_value = bump
    nt.links.new(nor.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs[0], bsdf.inputs["Normal"])
    return mat


def emission_material(name, color, strength=1.0):
    mat, nt, out = new_material(name)
    em = node(nt, "ShaderNodeEmission", 300, 0)
    em.inputs["Color"].default_value = (*color, 1.0)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return mat


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


# ─── Render passes ────────────────────────────────────────────────────────────

def _override_material(kind):
    """Emission-only material used to render data passes.

    mask    each object's custom "mask" colour (R water, G sky, B emitters)
    normal  world-space normal, packed as n * 0.5 + 0.5
    depth   inverse distance 1 / (1 + d / 20): 1 at the camera, -> 0 far away
    id      the object's "line_id" colour; objects sharing an id get no
            outline where they touch (see render_pass)
    """
    name = f"__override_{kind}"
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat, nt, out = new_material(name)
    em = node(nt, "ShaderNodeEmission", 300, 0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    if kind == "mask":
        attr = node(nt, "ShaderNodeAttribute", -200, 0)
        attr.attribute_type = "OBJECT"
        attr.attribute_name = "mask"
        nt.links.new(attr.outputs["Color"], em.inputs["Color"])
    elif kind == "normal":
        geo = node(nt, "ShaderNodeNewGeometry", -500, 0)
        mad = node(nt, "ShaderNodeVectorMath", -200, 0, operation="MULTIPLY_ADD")
        mad.inputs[1].default_value = (0.5, 0.5, 0.5)
        mad.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(geo.outputs["Normal"], mad.inputs[0])
        nt.links.new(mad.outputs[0], em.inputs["Color"])
    elif kind == "depth":
        lp = node(nt, "ShaderNodeLightPath", -700, 0)
        div = node(nt, "ShaderNodeMath", -500, 0, operation="DIVIDE")
        div.inputs[1].default_value = 20.0
        add = node(nt, "ShaderNodeMath", -350, 0, operation="ADD")
        add.inputs[1].default_value = 1.0
        inv = node(nt, "ShaderNodeMath", -200, 0, operation="DIVIDE")
        inv.inputs[0].default_value = 1.0
        nt.links.new(lp.outputs["Ray Length"], div.inputs[0])
        nt.links.new(div.outputs[0], add.inputs[0])
        nt.links.new(add.outputs[0], inv.inputs[1])
        nt.links.new(inv.outputs[0], em.inputs["Color"])
    elif kind == "id":
        attr = node(nt, "ShaderNodeAttribute", -200, 0)
        attr.attribute_type = "OBJECT"
        attr.attribute_name = "line_id"
        nt.links.new(attr.outputs["Color"], em.inputs["Color"])
    return mat


def render_pass(path, kind, samples=16, depth="8", scene=None):
    """Render a data pass with every surface replaced by an emission override.
    The background renders transparent (alpha 0); volumes are skipped."""
    scene = scene or bpy.context.scene
    layer = scene.view_layers[0]
    vs = scene.view_settings
    saved = {
        "override": layer.material_override,
        "samples": scene.cycles.samples,
        "transparent": scene.render.film_transparent,
        "view": vs.view_transform,
        "look": vs.look,
        "exposure": vs.exposure,
        "denoise": scene.cycles.use_denoising,
        "filter": scene.cycles.filter_width,
    }
    if kind == "id":
        import random
        rng = random.Random(1)
        groups = {}
        for obj in scene.objects:
            group = obj.get("line_group", obj.name)
            if group not in groups:
                groups[group] = (rng.random(), rng.random(), rng.random())
            obj["line_id"] = groups[group]
    hidden = []
    for obj in scene.objects:
        if (obj.get("volume_only") or obj.get(f"skip_{kind}")) and not obj.hide_render:
            obj.hide_render = True
            hidden.append(obj)
    try:
        layer.material_override = _override_material(kind)
        scene.cycles.samples = samples
        scene.cycles.use_denoising = False
        scene.render.film_transparent = True
        if kind == "id":
            scene.cycles.filter_width = 0.01  # no blending of ids across edges
        vs.view_transform = "Standard"
        vs.look = "None"
        vs.exposure = 0.0
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.image_settings.color_depth = depth
        scene.render.filepath = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.render.render(write_still=True)
    finally:
        layer.material_override = saved["override"]
        scene.cycles.samples = saved["samples"]
        scene.render.film_transparent = saved["transparent"]
        vs.view_transform = saved["view"]
        vs.look = saved["look"]
        vs.exposure = saved["exposure"]
        scene.cycles.use_denoising = saved["denoise"]
        scene.cycles.filter_width = saved["filter"]
        for obj in hidden:
            obj.hide_render = False
    return path


def render_beauty(path, samples=None, scene=None):
    """Render the final image as a 16-bit PNG through the scene's view transform."""
    scene = scene or bpy.context.scene
    if samples:
        scene.cycles.samples = samples
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "16"
    scene.render.filepath = path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    return path


def render_mask(path, samples=16, scene=None):
    return render_pass(path, "mask", samples=samples, scene=scene)


def save_blend(name):
    path = os.path.join(BLENDER_DIR, f"{name}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=False)
    return path
