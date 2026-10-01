"""Painterly filter: run Blender's anisotropic Kuwahara compositor node over
an image, from the command line (no scene needed).

    blender -b --factory-startup -P blender/scripts/paint_filter.py -- \
        --in input.png --out output.png --size 10 [--uniformity 4]
        [--sharpness 0.6] [--eccentricity 1.0]

Wrapping of equirectangular panoramas is handled by the caller
(scripts/looks.py pads the image horizontally before calling this).
"""

import argparse
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--in", dest="src", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--size", type=float, default=10)
ap.add_argument("--uniformity", type=int, default=4)
ap.add_argument("--sharpness", type=float, default=0.6)
ap.add_argument("--eccentricity", type=float, default=1.0)
a = ap.parse_args(argv)

scene = bpy.context.scene
img = bpy.data.images.load(a.src)
img.colorspace_settings.name = "sRGB"
w, h = img.size

tree = bpy.data.node_groups.new("paint", "CompositorNodeTree")
scene.compositing_node_group = tree
nodes, links = tree.nodes, tree.links

src = nodes.new("CompositorNodeImage")
src.image = img
kw = nodes.new("CompositorNodeKuwahara")
kw.inputs["Size"].default_value = a.size
kw.inputs["Uniformity"].default_value = a.uniformity
kw.inputs["Sharpness"].default_value = a.sharpness
kw.inputs["Eccentricity"].default_value = a.eccentricity
kw.inputs["High Precision"].default_value = True
links.new(src.outputs["Image"], kw.inputs["Image"])

# Blender 5 compositor graphs end in a Group Output
tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
out = nodes.new("NodeGroupOutput")
links.new(kw.outputs["Image"], out.inputs[0])

scene.render.resolution_x = w
scene.render.resolution_y = h
scene.render.resolution_percentage = 100
scene.render.use_compositing = True
scene.render.use_sequencer = False
scene.render.engine = "BLENDER_WORKBENCH"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_depth = "16"
scene.render.filepath = a.out
if scene.camera is None:
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
bpy.ops.render.render(write_still=True)
print("painted", w, h, "->", a.out)
