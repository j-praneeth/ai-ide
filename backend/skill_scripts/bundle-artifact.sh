#!/usr/bin/env bash
# bundle-artifact.sh — bundle the React artifact into a single self-contained HTML file
# Usage: bash scripts/bundle-artifact.sh  (run from project root)
#
# What this script does:
#   1. Runs `npm run build` (Vite build)
#   2. Reads dist/index.html
#   3. Inlines all referenced JS and CSS files into the HTML
#   4. Writes bundle.html to the project root

set -euo pipefail

DIST_DIR="dist"
OUT_FILE="bundle.html"

# ── Step 1: Vite build ───────────────────────────────────────────────────────
echo "→ Building with Vite ..."
if ! npm run build; then
  echo "Error: 'npm run build' failed. Fix build errors before bundling." >&2
  exit 1
fi

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "Error: $DIST_DIR/index.html not found after build." >&2
  exit 1
fi

echo "→ Inlining assets ..."

# ── Step 2 & 3: Read and inline assets using Python ─────────────────────────
# Python is used for reliable regex inlining of <script src> and <link href> tags.
python3 - "$DIST_DIR" "$OUT_FILE" << 'PYTHON_EOF'
import sys
import re
from pathlib import Path

dist_dir = Path(sys.argv[1])
out_file  = Path(sys.argv[2])

html = (dist_dir / "index.html").read_text(encoding="utf-8")

# ── Inline <script src="..."> tags ──────────────────────────────────────────
def inline_script(match):
    attrs    = match.group(1)  # attributes before src
    src_attr = match.group(2)  # the src value
    # Skip external URLs
    if src_attr.startswith("http://") or src_attr.startswith("https://") or src_attr.startswith("//"):
        return match.group(0)
    asset_path = dist_dir / src_attr.lstrip("/")
    if not asset_path.exists():
        print(f"  Warning: asset not found, skipping inline: {asset_path}", file=sys.stderr)
        return match.group(0)
    content = asset_path.read_text(encoding="utf-8")
    # Strip any type="module" — inlined scripts should not be modules
    attrs_clean = re.sub(r'\s*type=["\']module["\']', '', attrs)
    print(f"  Inlined JS: {src_attr} ({len(content):,} bytes)")
    return f"<script{attrs_clean}>{content}</script>"

html = re.sub(
    r'<script([^>]*?)\s+src=["\']([^"\']+)["\']([^>]*)>.*?</script>',
    inline_script,
    html,
    flags=re.DOTALL,
)

# ── Inline <link rel="stylesheet" href="..."> tags ──────────────────────────
def inline_style(match):
    href = match.group(1)
    if href.startswith("http://") or href.startswith("https://") or href.startswith("//"):
        return match.group(0)
    asset_path = dist_dir / href.lstrip("/")
    if not asset_path.exists():
        print(f"  Warning: stylesheet not found, skipping inline: {asset_path}", file=sys.stderr)
        return match.group(0)
    content = asset_path.read_text(encoding="utf-8")
    print(f"  Inlined CSS: {href} ({len(content):,} bytes)")
    return f"<style>{content}</style>"

html = re.sub(
    r'<link[^>]+rel=["\']stylesheet["\'][^>]+href=["\']([^"\']+)["\'][^>]*\/?>',
    inline_style,
    html,
)

# Also handle href-first ordering: <link href="..." rel="stylesheet">
html = re.sub(
    r'<link[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\']stylesheet["\'][^>]*\/?>',
    inline_style,
    html,
)

# ── Step 4: Write bundle.html ────────────────────────────────────────────────
out_file.write_text(html, encoding="utf-8")
print(f"\nWrote {out_file} ({out_file.stat().st_size:,} bytes)")
PYTHON_EOF

echo ""
echo "bundle.html created — share this file as an artifact"
