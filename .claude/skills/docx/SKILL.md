---
name: docx
description: Read, create, and edit Word (.docx) files. Use when the input or output is a .docx file, or when asked to work with Word documents.
---

Work with Word documents using pandoc and the `docx` npm package.

KEY TOOLS:
- `pandoc` — extract text: `pandoc input.docx -t markdown`
- `docx` npm package — create/edit programmatically
- Python ZIP manipulation — for direct XML editing

CRITICAL IMPLEMENTATION DETAILS:
- Always set page dimensions explicitly (Letter = 12240×15840 dxa; A4 = 11906×16838 dxa)
- Use `WidthType.DXA` for table widths — required for Google Docs compatibility
- Never insert Unicode bullet characters manually — use the `numbering` configuration API
- .docx = ZIP of XML files; can unpack/edit/repack:
  ```bash
  unzip doc.docx -d unpacked/
  # edit unpacked/word/document.xml
  cd unpacked && zip -r ../edited.docx .
  ```

CREATING WITH docx npm:
```javascript
import { Document, Paragraph, TextRun, Packer } from "docx";
const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("Hello")] })] }] });
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync("output.docx", buffer);
```

CREATING WITH python-docx:
```python
from docx import Document
doc = Document()
doc.add_heading("Title", 0)
doc.add_paragraph("Body text.")
doc.save("output.docx")
```
