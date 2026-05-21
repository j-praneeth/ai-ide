---
name: pptx
description: Create and edit PowerPoint presentations (.pptx). Use when asked to build slide decks, presentations, or work with .pptx files.
---

Create and edit PowerPoint presentations with strong visual design.

CORE COMMANDS:
```bash
# Extract text content
python -m markitdown presentation.pptx

# Generate slide thumbnails (requires LibreOffice + Pillow)
python backend/skill_scripts/thumbnail.py presentation.pptx --out-dir ./thumbs

# Edit XML directly: unpack → modify → repack
unzip presentation.pptx -d unpacked/
# edit unpacked/ppt/slides/slide1.xml
cd unpacked && zip -r ../edited.pptx .
```

PYTHON CREATION (python-pptx):
```python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "Title"
slide.placeholders[1].text = "Content"
prs.save("output.pptx")
```

DESIGN PRINCIPLES:
- Match colors to the specific topic — avoid default blue
- 60–70% one primary color, supporting accents for hierarchy
- "Sandwich" structure: dark/bold backgrounds for opening + closing slides
- Repeat one distinctive visual motif consistently
- Every slide needs a visual element — no text-only slides

TYPOGRAPHY:
- Body: left-aligned, 14–16pt
- Titles: 36–44pt
- Substantial size contrast between elements; no centered body text

QA PROCESS: After creating, generate thumbnails with `thumbnail.py` and visually check for overlapping elements, text overflow, and contrast issues. Iterate until clean.

DEPENDENCIES: `pip install python-pptx markitdown Pillow`
