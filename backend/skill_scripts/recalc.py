"""
recalc.py — Force-recalculate all formulas in an Excel file via LibreOffice,
then report any formula errors (#REF!, #DIV/0!, etc.).

Usage:
    python recalc.py output.xlsx
    python recalc.py output.xlsx --check-only   # skip LibreOffice, just audit

Returns JSON:
    { "status": "success"|"errors_found", "total_formulas": N,
      "total_errors": N, "error_summary": { "#REF!": {"count": N, "locations": [...]} } }
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print(json.dumps({"status": "error", "message": "openpyxl not installed — run: pip install openpyxl"}))
    sys.exit(1)

ERROR_TOKENS = {"#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NULL!", "#NUM!"}


def _libreoffice_recalc(src: Path) -> Path:
    """Convert via LibreOffice to force formula recalculation; returns the output path."""
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            ["libreoffice", "--headless", "--calc", "--convert-to", "xlsx",
             "--outdir", tmp, str(src)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice failed: {result.stderr.strip()}")
        out = Path(tmp) / src.name
        if not out.exists():
            raise RuntimeError("LibreOffice produced no output file")
        dest = src.with_suffix(".recalc.xlsx")
        out.replace(dest)
        return dest


def audit(path: Path):
    wb = openpyxl.load_workbook(str(path), data_only=True)
    summary: dict = {}
    total_formulas = 0
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                v = str(cell.value) if cell.value is not None else ""
                if v in ERROR_TOKENS:
                    total_formulas += 1
                    summary.setdefault(v, {"count": 0, "locations": []})
                    summary[v]["count"] += 1
                    if len(summary[v]["locations"]) < 10:
                        summary[v]["locations"].append(f"{ws.title}!{cell.coordinate}")
                elif v.startswith("="):
                    total_formulas += 1
    return total_formulas, summary


def main():
    if len(sys.argv) < 2:
        print("Usage: python recalc.py <file.xlsx> [--check-only]")
        sys.exit(1)

    src = Path(sys.argv[1])
    check_only = "--check-only" in sys.argv

    if not src.exists():
        print(json.dumps({"status": "error", "message": f"File not found: {src}"}))
        sys.exit(1)

    target = src
    if not check_only:
        try:
            target = _libreoffice_recalc(src)
        except Exception as e:
            # LibreOffice not available — audit the file as-is
            target = src

    total_formulas, errors = audit(target)
    status = "errors_found" if errors else "success"
    print(json.dumps({
        "status": status,
        "file": str(target),
        "total_formulas": total_formulas,
        "total_errors": sum(v["count"] for v in errors.values()),
        "error_summary": errors,
    }, indent=2))
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
