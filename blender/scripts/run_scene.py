"""Build a scene from its script in a background Blender, optionally save the
.blend and render a preview. Used when the interactive session is busy.

    blender -b --factory-startup -P blender/scripts/run_scene.py -- \
        --scene stillness [--final] [--save] [--preview 1536] [--samples 48]
"""

import argparse
import importlib
import os
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
sys.modules.pop("common", None)
import common as C  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--scene", required=True)
ap.add_argument("--final", action="store_true", help="build with final render settings")
ap.add_argument("--save", action="store_true")
ap.add_argument("--preview", type=int, default=0, help="render a preview this wide")
ap.add_argument("--samples", type=int, default=0)
a = ap.parse_args(argv)

t = time.time()
mod = importlib.import_module(a.scene)
scene = mod.build(preview=not a.final)
print(f"built {a.scene} in {time.time() - t:.1f}s")
if a.save:
    print("saved", C.save_blend(a.scene))
if a.preview:
    C.use_gpu(scene)
    C.set_resolution(a.preview)
    t = time.time()
    C.render_beauty(os.path.join(C.RENDERS_DIR, a.scene, "preview.png"), samples=a.samples or None)
    print(f"preview in {time.time() - t:.1f}s")
