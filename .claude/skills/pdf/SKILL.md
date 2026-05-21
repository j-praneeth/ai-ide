---
name: pdf
description: Read, create, edit, merge, split, and extract data from PDF files. Use when the input or output is a PDF, or when asked to process PDF content.
---

Process PDFs using Python libraries and CLI tools.

TOOL SELECTION:
| Task | Best Tool |
|---|---|
| Merge / split | pypdf |
| Extract text with layout | pdfplumber |
| Extract tables | pdfplumber → pandas |
| Create PDFs | reportlab |
| CLI merge/split | qpdf |
| OCR scanned PDFs | pytesseract + pdf2image |
| Fill forms | pdf-lib (JS) or pypdf |

COMMON PATTERNS:
```python
# Extract text
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = "\n".join(p.extract_text() or "" for p in pdf.pages)

# Extract tables
with pdfplumber.open("file.pdf") as pdf:
    tables = pdf.pages[0].extract_tables()

# Merge
from pypdf import PdfWriter
writer = PdfWriter()
for f in ["a.pdf", "b.pdf"]:
    writer.append(f)
writer.write("merged.pdf")

# Create
from reportlab.pdfgen import canvas
c = canvas.Canvas("output.pdf")
c.drawString(100, 750, "Hello World")
c.save()
```

CRITICAL — REPORTLAB SUBSCRIPTS/SUPERSCRIPTS:
- NEVER use Unicode sub/superscript chars (₀₁², ⁰¹²) — renders as black boxes
- Use `<sub>text</sub>` and `<super>text</super>` inside `Paragraph()` objects instead

INSTALL: `pip install pypdf pdfplumber reportlab pytesseract pdf2image`
