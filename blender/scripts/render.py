"""Command-line renderer for the final panoramas (runs outside the live
Blender session so long renders never block it).

    blender -b blender/<scene>.blend -P blender/scripts/render.py -- \
        --name hub --width 8192 --samples 512 [--no-mask] [--no-beauty]

Writes blender/renders/<name>/beauty.png (16-bit) and mask.png (RGBA 8-bit).
"""

import argparse
import os
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Another add-on may already have loaded a module named "common": make sure
# the import below resolves to this folder's common.py.
sys.modules.pop("common", None)
import common as C  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--width", type=int, default=8192)
ap.add_argument("--samples", type=int, default=512)
ap.add_argument("--mask-width", type=int, default=2048)
ap.add_argument("--no-mask", action="store_true")
ap.add_argument("--no-beauty", action="store_true")
ap.add_argument("--passes", default="", help="comma list of extra passes: normal,depth,id (rendered at --width)")
a = ap.parse_args(argv)

scene = bpy.context.scene
print("device:", C.use_gpu(scene))
out_dir = os.path.join(C.RENDERS_DIR, a.name)

if not a.no_beauty:
    C.set_resolution(a.width)
    t = time.time()
    C.render_beauty(os.path.join(out_dir, "beauty.png"), samples=a.samples)
    print(f"beauty {a.width}px in {time.time() - t:.0f}s")

for kind in [p for p in a.passes.split(",") if p]:
    C.set_resolution(a.width)
    t = time.time()
    C.render_pass(os.path.join(out_dir, f"{kind}.png"), kind, samples=8 if kind == "id" else 16, depth="8" if kind == "id" else "16")
    print(f"{kind} {a.width}px in {time.time() - t:.0f}s")

if not a.no_mask:
    C.set_resolution(a.mask_width)
    t = time.time()
    C.render_mask(os.path.join(out_dir, "mask.png"), samples=16)
    print(f"mask {a.mask_width}px in {time.time() - t:.0f}s")
