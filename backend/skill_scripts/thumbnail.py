"""
thumbnail.py — Generate PNG thumbnails for each slide in a PPTX file.

Usage:
    python thumbnail.py presentation.pptx
    python thumbnail.py presentation.pptx --out-dir ./thumbs --width 960

Outputs: slide-01.png, slide-02.png, ... in the output directory.
Requires: LibreOffice (for conversion) + Pillow (for image handling).
"""
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Pillow not installed — run: pip install Pillow")
    sys.exit(1)


def _pptx_to_images(src: Path, out_dir: Path, width: int = 1280) -> list[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            ["libreoffice", "--headless", "--impress", "--convert-to", "png",
             "--outdir", tmp, str(src)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice failed: {result.stderr.strip()}")

        slides = sorted(Path(tmp).glob("*.png"))
        if not slides:
            raise RuntimeError("LibreOffice produced no PNG files")

        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = []
        for i, slide in enumerate(slides, 1):
            img = Image.open(slide)
            if img.width > width:
                ratio = width / img.width
                img = img.resize((width, int(img.height * ratio)), Image.LANCZOS)
            dest = out_dir / f"slide-{i:02d}.png"
            img.save(dest, "PNG", optimize=True)
            outputs.append(dest)
            print(f"  {dest}")
        return outputs


def main():
    if len(sys.argv) < 2:
        print("Usage: python thumbnail.py <file.pptx> [--out-dir DIR] [--width N]")
        sys.exit(1)

    src = Path(sys.argv[1])
    if not src.exists():
        print(f"File not found: {src}")
        sys.exit(1)

    out_dir = Path("thumbs")
    width = 1280
    args = sys.argv[2:]
    for i, a in enumerate(args):
        if a == "--out-dir" and i + 1 < len(args):
            out_dir = Path(args[i + 1])
        if a == "--width" and i + 1 < len(args):
            width = int(args[i + 1])

    print(f"Generating thumbnails for {src.name} → {out_dir}/")
    slides = _pptx_to_images(src, out_dir, width)
    print(f"Done — {len(slides)} slide(s).")


if __name__ == "__main__":
    main()
