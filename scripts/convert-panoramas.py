"""
Convierte panorámicas HDR/EXR a JPEG equirectangular con tone mapping Reinhard.

Busca archivos .hdr y .exr en raw/, los convierte a JPEG 8-bit y genera
thumbnails reducidos. Los resultados se guardan en public/images/panoramas/
y public/images/thumbnails/ respectivamente.

Uso:
    python scripts/convert-panoramas.py
    npm run convert
"""

import os
import sys
import glob
import time

# Forzar UTF-8 en Windows para caracteres especiales en la consola
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

import cv2
import numpy as np
from PIL import Image

# ─── Rutas ────────────────────────────────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "raw")
PANO_DIR = os.path.join(ROOT, "public", "images", "panoramas")
THUMB_DIR = os.path.join(ROOT, "public", "images", "thumbnails")

JPEG_QUALITY = 90
THUMB_WIDTH = 800


def fmt_size(size_bytes: int) -> str:
    """Formatea bytes a unidad legible."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def find_hdr_files() -> list[str]:
    """Busca archivos .hdr y .exr en raw/."""
    patterns = [
        os.path.join(RAW_DIR, "*.hdr"),
        os.path.join(RAW_DIR, "*.HDR"),
        os.path.join(RAW_DIR, "*.exr"),
        os.path.join(RAW_DIR, "*.EXR"),
    ]
    files: list[str] = []
    for pattern in patterns:
        files.extend(glob.glob(pattern))
    # Eliminar duplicados (case-insensitive en Windows)
    seen: set[str] = set()
    unique: list[str] = []
    for f in files:
        key = os.path.normcase(f)
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return sorted(unique)


def convert_hdr(src_path: str) -> None:
    """Convierte un archivo HDR/EXR a JPEG con tone mapping Reinhard."""
    basename = os.path.splitext(os.path.basename(src_path))[0]
    ext = os.path.splitext(src_path)[1].lower()
    src_size = os.path.getsize(src_path)

    print(f"\n{'─' * 60}")
    print(f"  Archivo:  {os.path.basename(src_path)}")
    print(f"  Formato:  {ext.upper().lstrip('.')} (HDR)")
    print(f"  Peso:     {fmt_size(src_size)}")

    # Leer imagen HDR con OpenCV (soporta .hdr y .exr)
    img_hdr = cv2.imread(src_path, cv2.IMREAD_ANYDEPTH | cv2.IMREAD_ANYCOLOR)
    if img_hdr is None:
        print(f"  ERROR: No se pudo leer {src_path}")
        return

    h, w = img_hdr.shape[:2]
    print(f"  Resolución original: {w} × {h}")

    # Tone mapping Reinhard con gamma 2.2 (corrección sRGB estándar)
    # + intensidad positiva para levantar la exposición general
    tonemap = cv2.createTonemapReinhard(gamma=2.2, intensity=0.8, light_adapt=0.8, color_adapt=0.0)
    img_ldr = tonemap.process(img_hdr.astype(np.float32))

    # Clamp y convertir a 8-bit
    img_ldr = np.clip(img_ldr * 255, 0, 255).astype(np.uint8)

    # ── Guardar panorámica JPEG ──────────────────────────────
    os.makedirs(PANO_DIR, exist_ok=True)
    pano_path = os.path.join(PANO_DIR, f"{basename}.jpg")
    cv2.imwrite(pano_path, img_ldr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    pano_size = os.path.getsize(pano_path)

    print(f"  → Panorámica: {pano_path}")
    print(f"    Peso JPEG:  {fmt_size(pano_size)}")
    print(f"    Reducción:  {(1 - pano_size / src_size) * 100:.1f}%")

    # ── Generar thumbnail ────────────────────────────────────
    os.makedirs(THUMB_DIR, exist_ok=True)
    thumb_path = os.path.join(THUMB_DIR, f"{basename}.jpg")

    # Usar Pillow para el resize con mejor calidad
    pil_img = Image.fromarray(cv2.cvtColor(img_ldr, cv2.COLOR_BGR2RGB))
    ratio = THUMB_WIDTH / w
    thumb_h = int(h * ratio)
    pil_thumb = pil_img.resize((THUMB_WIDTH, thumb_h), Image.LANCZOS)
    pil_thumb.save(thumb_path, "JPEG", quality=JPEG_QUALITY)
    thumb_size = os.path.getsize(thumb_path)

    print(f"  → Thumbnail:  {thumb_path}")
    print(f"    Resolución: {THUMB_WIDTH} × {thumb_h}")
    print(f"    Peso:       {fmt_size(thumb_size)}")


def main() -> None:
    print("=" * 60)
    print("  Conversor de panorámicas HDR/EXR → JPEG")
    print("=" * 60)

    if not os.path.isdir(RAW_DIR):
        print(f"\nERROR: No existe la carpeta raw/ en {ROOT}")
        print("Crea la carpeta y añade archivos .hdr o .exr.")
        sys.exit(1)

    files = find_hdr_files()

    if not files:
        print(f"\nNo se encontraron archivos .hdr o .exr en {RAW_DIR}")
        print("Añade tus panorámicas HDR/EXR a la carpeta raw/ y vuelve a ejecutar.")
        sys.exit(0)

    print(f"\nEncontrados {len(files)} archivo(s) HDR/EXR")

    t0 = time.time()
    for f in files:
        convert_hdr(f)

    elapsed = time.time() - t0
    print(f"\n{'─' * 60}")
    print(f"  Completado: {len(files)} archivo(s) en {elapsed:.1f}s")
    print(f"{'─' * 60}\n")


if __name__ == "__main__":
    main()
