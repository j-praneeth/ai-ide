---
name: xlsx
description: Open, read, edit, create, and fix spreadsheet files (.xlsx, .xlsm, .csv, .tsv). Use any time a spreadsheet file is the primary input or output. Do NOT trigger for Word docs, HTML reports, database pipelines, or Google Sheets API integrations.
---

Work with Excel and CSV files using openpyxl and pandas.

TOOL SELECTION:
- `pandas` — data analysis, bulk ops, simple CSV/XLSX export
- `openpyxl` — complex formatting, formulas, Excel-specific features

MANDATORY AFTER ANY FORMULA WRITING:
```bash
python backend/skill_scripts/recalc.py output.xlsx
```
Returns: `{ "status": "success"|"errors_found", "total_errors": N, "error_summary": {...} }`

OUTPUT REQUIREMENTS:
- Professional font (Arial or Times New Roman) unless instructed otherwise
- Zero formula errors: #REF!, #DIV/0!, #VALUE!, #N/A, #NAME? are mandatory failures
- When updating templates: exactly match existing format/style/conventions

FINANCIAL MODEL COLOR CODING:
- Blue `(0,0,255)` — hardcoded inputs users change for scenarios
- Black `(0,0,0)` — ALL formulas and calculated values
- Green `(0,128,0)` — links from other worksheets in same workbook
- Red `(255,0,0)` — external links to other files
- Yellow bg `(255,255,0)` — key assumptions needing attention

NUMBER FORMATTING:
- Years: text strings ("2024" not "2,024")
- Currency: `$#,##0` — always specify units in headers
- Zeros: `$#,##0;($#,##0);-` (renders as "–")
- Percentages: `0.0%` | Multiples: `0.0x` | Negatives: `(123)` not `-123`

FORMULA RULES:
- ALWAYS use Excel formulas — never hardcode calculated values in Python
- All assumptions in separate cells; use cell references, not magic numbers
- Document hardcodes: "Source: [System], [Date], [Reference]"

openpyxl NOTES:
- Cell indices are 1-based: `ws.cell(row=1, column=1)`
- `data_only=True` reads values but destroys formulas on save — use carefully

INSTALL: `pip install openpyxl pandas`
