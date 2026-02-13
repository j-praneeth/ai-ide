import os
import re
import fnmatch
import subprocess
import difflib
from pathlib import Path
from typing import Dict, Any

from .indexer import search_codebase
from .diff_engine import generate_diff

# Default: parent of backend/ directory (the actual full project root)
_project_root = Path(__file__).resolve().parent.parent.parent

# Directories to skip when building the file tree
_SKIP_DIRS = {
    'node_modules', '.git', '__pycache__', '.next', '.cache',
    'venv', 'env', '.env', 'dist', 'build', '.idea', '.vscode',
    '.cursor', 'coverage', '.pytest_cache', '.mypy_cache',
    'egg-info', '.tox', '.nox', 'target', 'vendor',
}


def set_project_root(path):
    """Update the project root (called by ai.py to sync with file_manager)."""
    global _project_root
    _project_root = Path(path).resolve()


def get_project_root() -> Path:
    return _project_root


def get_project_file_tree(max_files=200) -> str:
    """Build a compact file tree string of the project for the LLM context."""
    root = get_project_root()
    if not root or not root.exists():
        return "(no project open)"
    lines = []
    count = 0

    def _walk(directory, prefix=""):
        nonlocal count
        if count >= max_files:
            return
        try:
            entries = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return
        for entry in entries:
            if count >= max_files:
                lines.append(f"{prefix}... (truncated at {max_files} files)")
                return
            if entry.name.startswith('.') and entry.name not in ('.env', '.gitignore', '.editorconfig'):
                continue
            if entry.is_dir():
                if entry.name in _SKIP_DIRS:
                    continue
                rel = str(entry.relative_to(root))
                lines.append(f"{prefix}{rel}/")
                _walk(entry, prefix)
            else:
                rel = str(entry.relative_to(root))
                lines.append(f"{prefix}{rel}")
                count += 1

    _walk(root)
    return "\n".join(lines) if lines else "(empty project)"


# ---------------------------
# Utility: Safe Path Resolver
# ---------------------------
def safe_path(path_str: str) -> Path:
    root = get_project_root()
    path = (root / path_str).resolve()
    if not str(path).startswith(str(root)):
        raise Exception("Access outside project directory is not allowed.")
    return path


# ---------------------------
# 1. codebase_search
# ---------------------------
def codebase_search(input_data: Dict[str, Any]) -> str:
    query = input_data.get("query") or ""
    target_directories = input_data.get("target_directories") or []
    if not query.strip():
        return "Error: query is required."
    try:
        results = search_codebase(query, root=str(get_project_root()))
        if target_directories:
            allowed = {str(safe_path(d)) for d in target_directories}
            results = [(p, c) for p, c in results if any(p.startswith(a) for a in allowed)]
        if not results:
            return "No matching code found."
        return "\n\n".join([f"{path}:\n{chunk}" for path, chunk in results])
    except Exception as e:
        return f"codebase_search error: {str(e)}"


# ---------------------------
# 2. read_file (with start_line / end_line)
# ---------------------------
def read_file(input_data: Dict[str, Any]) -> str:
    try:
        path_in = input_data.get("path", "")
        path = safe_path(path_in)
        if not path.exists() or not path.is_file():
            filename = os.path.basename(path_in)
            suggestions = file_search({"query": filename})
            hint = ""
            if suggestions and "No matching" not in suggestions:
                hint = f"\n\nDid you mean one of these files?\n{suggestions}"
            return f"Error: File '{path_in}' not found.{hint}"
        text = path.read_text(encoding="utf-8", errors="replace")
        if not text.strip():
            return f"(File '{path_in}' exists but is EMPTY — 0 lines. Use write_file to add content.)"
        start_line = input_data.get("start_line")
        end_line = input_data.get("end_line")
        if start_line is not None or end_line is not None:
            lines = text.splitlines()
            n = len(lines)
            i = max(0, (start_line or 1) - 1)
            j = min(n, end_line or n)
            if i >= j:
                return "(Requested line range is empty.)"
            text = "\n".join(lines[i:j])
        total_lines = len(text.splitlines())
        return f"({total_lines} lines)\n{text}"
    except Exception as e:
        return str(e)


# ---------------------------
# 3. run_command (hardened)
# ---------------------------
def run_command(input_data: Dict[str, Any]) -> str:
    import platform as _platform
    command = input_data.get("command")
    if not command:
        return "Error: command is required."

    blocked_keywords = [
        "rm -rf",
        "shutdown",
        "reboot",
        "mkfs",
        "dd ",
        "dotnet tool install",
        "npm install -g",
        "pip install",
        "brew install",
        "sudo",
        "format c:",
        "del /s /q c:",
        "rd /s /q c:",
    ]
    cmd_lower = command.lower()
    if any(b in cmd_lower for b in blocked_keywords):
        return "Blocked: Dangerous or global installation command not allowed."

    try:
        is_windows = _platform.system() == "Windows"
        if is_windows:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", command],
                capture_output=True,
                text=True,
                timeout=30,
                cwd=str(get_project_root()),
            )
        else:
            result = subprocess.run(
                command,
                shell=True,
                cwd=str(get_project_root()),
                capture_output=True,
                text=True,
                timeout=30,
            )
        return (result.stdout or "") + (result.stderr or "")
    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 30s."
    except Exception as e:
        return str(e)


# ---------------------------
# 4. list_dir (with type indicators)
# ---------------------------
def list_dir(input_data: Dict[str, Any]) -> str:
    try:
        path = safe_path(input_data.get("path", "."))
        if not path.exists():
            return f"Error: Directory {path} not found."
        if not path.is_dir():
            return f"Error: {path} is not a directory."
        entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        lines = []
        for p in entries:
            prefix = "📁 " if p.is_dir() else "📄 "
            lines.append(prefix + p.name)
        return "\n".join(lines)
    except Exception as e:
        return str(e)


# ---------------------------
# 5. grep_search (regex / pattern search)
# ---------------------------
def grep_search(input_data: Dict[str, Any]) -> str:
    query = input_data.get("query") or ""
    include_pattern = input_data.get("include_pattern")
    case_sensitive = input_data.get("case_sensitive", False)
    if not query:
        return "Error: query (pattern) is required."

    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(query, flags)
    except re.error:
        return f"Error: Invalid regex pattern: {query}"

    results = []
    root = get_project_root()
    for root_dir, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith('.')]
        rel_root = os.path.relpath(root_dir, root)
        if rel_root.startswith(".."):
            continue
        for f in files:
            if include_pattern and not fnmatch.fnmatch(f, include_pattern):
                continue
            abs_path = os.path.join(root_dir, f)
            rel_path = os.path.join(rel_root, f) if rel_root != "." else f
            try:
                with open(abs_path, "r", encoding="utf-8", errors="ignore") as fp:
                    for i, line in enumerate(fp, 1):
                        if pattern.search(line):
                            results.append(f"{rel_path}:{i}: {line.rstrip()}")
                            if len(results) >= 50:
                                return "\n".join(results) + "\n... (50 match limit)"
            except (OSError, UnicodeDecodeError):
                continue
    return "\n".join(results) if results else "No matches found."


# ---------------------------
# 6. edit_file (SAFE find-and-replace approach)
# ---------------------------
import logging as _logging
_edit_logger = _logging.getLogger("edit_file")

def edit_file(input_data: Dict[str, Any]) -> Dict[str, Any]:
    """Edit a file using safe find-and-replace.
    
    Supports multiple approaches (tries each in order):
    1. Find-and-replace: "old_content" -> "new_content" (PREFERRED)
    2. Insert: "new_content" only with "position" = "beginning" or "end"
    3. Legacy: "code_edit" with markers (fallback)
    """
    path_in = input_data.get("path")
    if not path_in:
        return {"status": "error", "message": "path is required"}

    try:
        path = safe_path(path_in)
        if not path.exists() or not path.is_file():
            filename = os.path.basename(path_in)
            suggestions = file_search({"query": filename})
            hint = ""
            if suggestions and "No matching" not in suggestions:
                hint = f" Did you mean: {suggestions}"
            return {"status": "error", "message": f"File not found: '{path_in}'.{hint}"}

        content = path.read_text(encoding="utf-8", errors="replace")

        # Normalize model input - it might use different key names
        # IMPORTANT: Don't use `or` chains for new_content because "" is a valid value (means delete)
        old_content = input_data.get("old_content")
        if old_content is None:
            old_content = input_data.get("old_text")
        if old_content is None:
            old_content = ""

        new_content = input_data.get("new_content")
        if new_content is None:
            new_content = input_data.get("new_text")
        if new_content is None:
            new_content = input_data.get("content")
        # At this point new_content can be: a string (including ""), or None (not provided at all)

        position = input_data.get("position", "")
        instructions = input_data.get("instructions", "")
        code_edit = input_data.get("code_edit", "")

        _edit_logger.info("edit_file called: path=%s, old_content=%r, new_content=%r, position=%r, code_edit=%r, instructions=%r",
                         path_in, (old_content or "")[:100], (str(new_content) or "")[:100], position, (code_edit or "")[:100], instructions[:100])

        # ──── Approach 1: Find-and-replace (old_content -> new_content) ────
        if old_content and new_content is not None:
            return _do_find_replace(path, path_in, content, old_content, str(new_content))

        # ──── Approach 2: Insert new content (no old_content, just new_content) ────
        if new_content and not old_content:
            new_text = str(new_content)
            pos = position.lower() if position else ""
            
            # Determine where to insert based on position or instructions
            insert_at_end = any(kw in pos for kw in ["end", "bottom", "append"]) or \
                           any(kw in instructions.lower() for kw in ["end", "bottom", "append", "after"])
            
            if insert_at_end:
                # Add to end
                if content.endswith('\n'):
                    new_file = content + new_text + '\n'
                else:
                    new_file = content + '\n' + new_text + '\n'
            else:
                # Default: add to beginning
                new_file = new_text + '\n' + content
            
            diff_text = _make_diff(content, new_file, path_in)
            path.write_text(new_file, encoding="utf-8")
            return {"status": "success", "message": f"Content added to '{path_in}'.", "diff": diff_text}

        # ──── Approach 3: Legacy code_edit (fallback) ────
        if code_edit:
            # Handle empty files
            if not content.strip():
                marker = re.compile(r"(?:#|//|--|)\s*\.\.\.\s*existing\s+code\s*\.\.\.\s*", re.IGNORECASE)
                clean_edit = re.sub(marker, "", code_edit).strip()
                if not clean_edit:
                    return {"status": "error", "message": "No content to write."}
                path.write_text(clean_edit + "\n", encoding="utf-8")
                return {"status": "success", "message": f"File was empty. Wrote new content to '{path_in}'."}

            # Try to apply code_edit safely
            new_file = _apply_code_edit_safe(content, code_edit)
            if new_file is None:
                return {"status": "error", "message": "Could not safely apply the edit. Try using old_content/new_content format instead."}

            diff_text = _make_diff(content, new_file, path_in)
            path.write_text(new_file, encoding="utf-8")
            return {"status": "success", "message": f"Edit applied to '{path_in}'.", "diff": diff_text}

        # ──── Last resort: try to extract old/new from instructions ────
        if instructions and not old_content and not new_content and not code_edit:
            return {"status": "error", "message": f"edit_file needs old_content and new_content. Read the file first, then specify exactly what to find (old_content) and what to replace it with (new_content)."}

        return {"status": "error", "message": "edit_file requires: old_content + new_content (to find and replace), OR just new_content (to insert), OR code_edit (legacy). Please provide the correct parameters."}

    except Exception as e:
        _edit_logger.exception("edit_file error")
        return {"status": "error", "message": str(e)}


def _do_find_replace(path, path_in, content, old_content, new_content):
    """Execute a find-and-replace edit. Safe - only touches matched text."""
    if old_content in content:
        # Exact match
        if new_content:
            new_file = content.replace(old_content, new_content, 1)
        else:
            new_file = content.replace(old_content, "", 1)
            while '\n\n\n' in new_file:
                new_file = new_file.replace('\n\n\n', '\n\n')
            new_file = new_file.lstrip('\n')
        diff_text = _make_diff(content, new_file, path_in)
        path.write_text(new_file, encoding="utf-8")
        return {"status": "success", "message": f"Edit applied to '{path_in}'.", "diff": diff_text}

    # Try fuzzy line-by-line match (handles whitespace differences)
    old_lines = [l.strip() for l in old_content.strip().splitlines()]
    content_lines = content.splitlines()
    match_start = None
    for i in range(len(content_lines)):
        if content_lines[i].strip() == old_lines[0]:
            match = True
            for j in range(1, len(old_lines)):
                if i + j >= len(content_lines) or content_lines[i + j].strip() != old_lines[j]:
                    match = False
                    break
            if match:
                match_start = i
                break

    if match_start is not None:
        match_end = match_start + len(old_lines)
        if new_content.strip():
            new_lines = new_content.splitlines()
            result_lines = content_lines[:match_start] + new_lines + content_lines[match_end:]
        else:
            result_lines = content_lines[:match_start] + content_lines[match_end:]
        new_file = '\n'.join(result_lines)
        if content.endswith('\n') and not new_file.endswith('\n'):
            new_file += '\n'
        diff_text = _make_diff(content, new_file, path_in)
        path.write_text(new_file, encoding="utf-8")
        return {"status": "success", "message": f"Edit applied to '{path_in}'.", "diff": diff_text}

    # Try substring match (in case old_content is a partial line)
    for i, line in enumerate(content_lines):
        if old_content.strip() in line:
            if new_content.strip():
                content_lines[i] = line.replace(old_content.strip(), new_content.strip())
            else:
                content_lines.pop(i)
            new_file = '\n'.join(content_lines)
            if content.endswith('\n') and not new_file.endswith('\n'):
                new_file += '\n'
            diff_text = _make_diff(content, new_file, path_in)
            path.write_text(new_file, encoding="utf-8")
            return {"status": "success", "message": f"Edit applied to '{path_in}'.", "diff": diff_text}

    return {"status": "error", "message": f"Could not find the specified text in '{path_in}'. Read the file first and copy old_content exactly."}


def _make_diff(old_content, new_content, path_in):
    """Generate a unified diff string."""
    return "\n".join(
        difflib.unified_diff(
            old_content.splitlines(),
            new_content.splitlines(),
            lineterm="",
            fromfile=path_in,
            tofile=path_in,
        )
    )


def _apply_code_edit_safe(file_content: str, code_edit: str) -> str:
    """Apply a code_edit to file content SAFELY. Returns new content or None if unsafe."""
    file_lines = file_content.splitlines()
    edit_lines = code_edit.strip().splitlines()
    orig_count = len(file_lines)

    if not edit_lines:
        return None

    # Check for marker pattern
    marker_pat = re.compile(r"(?:#|//|--|)\s*\.\.\.\s*existing\s+code\s*\.\.\.\s*", re.IGNORECASE)
    has_marker = bool(marker_pat.search(code_edit))

    if has_marker:
        # Marker-based edit — use marker logic
        parts = marker_pat.split(code_edit)

        if len(parts) == 2:
            before = parts[0].strip()
            after = parts[1].strip()
            before_lines = before.splitlines() if before else []
            after_lines = after.splitlines() if after else []

            if before_lines and not after_lines:
                # Prepend or replace top
                anchor = before_lines[-1].strip()
                for i, line in enumerate(file_lines):
                    if line.strip() == anchor:
                        result = before_lines + file_lines[i + 1:]
                        return '\n'.join(result) + '\n'
                return '\n'.join(before_lines) + '\n' + file_content

            elif not before_lines and after_lines:
                # Append or replace bottom
                anchor = after_lines[0].strip()
                for i, line in enumerate(file_lines):
                    if line.strip() == anchor:
                        result = file_lines[:i] + after_lines
                        return '\n'.join(result) + '\n'
                return file_content + '\n'.join(after_lines) + '\n'

        # Fallback for markers: strip markers, check safety
        clean = re.sub(marker_pat, "", code_edit).strip()
        if clean:
            clean_lines = clean.splitlines()
            if len(clean_lines) >= orig_count * 0.5:
                return clean + '\n'
        return None

    # No markers — this is a "full replacement" attempt
    # SAFETY: only allow if the edit preserves most of the file
    if len(edit_lines) < orig_count * 0.5 and orig_count > 5:
        # Edit is too short compared to original — likely the model only sent a snippet
        # REJECT this to prevent file destruction
        return None

    new_content = code_edit.strip() + '\n'
    return new_content


# ---------------------------
# 7. write_file
# ---------------------------
def write_file(input_data: Dict[str, Any]) -> str:
    try:
        path_in = input_data.get("path", "")
        path = safe_path(path_in)
        content = input_data.get("content", "")
        is_new = not path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        action = "Created" if is_new else "Written"
        return f"{action}: '{path_in}' ({len(content.splitlines())} lines)"
    except Exception as e:
        return str(e)


# ---------------------------
# 8. delete_file
# ---------------------------
def delete_file_tool(input_data: Dict[str, Any]) -> str:
    path_in = input_data.get("path")
    if not path_in:
        return "Error: path is required."
    try:
        path = safe_path(path_in)
        if not path.exists():
            return f"Error: File {path} not found."
        if not path.is_file():
            return f"Error: Not a file (cannot delete directory): {path}"
        path.unlink()
        return f"Deleted {path}"
    except Exception as e:
        return str(e)


# ---------------------------
# 9. file_search (fuzzy filename search)
# ---------------------------
def file_search(input_data: Dict[str, Any]) -> str:
    query = (input_data.get("query") or "").strip().lower()
    if not query:
        return "Error: query (partial filename) is required."
    results = []
    root = get_project_root()
    for root_dir, _, files in os.walk(root):
        rel_root = os.path.relpath(root_dir, root)
        if rel_root.startswith(".."):
            continue
        for f in files:
            if query in f.lower():
                results.append(os.path.join(rel_root, f) if rel_root != "." else f)
    results.sort()
    return "\n".join(results) if results else "No matching files found."


# ---------------------------
# TOOLS map (Cursor-style names)
# ---------------------------
TOOLS = {
    "codebase_search": codebase_search,
    "read_file": read_file,
    "run_command": run_command,
    "list_dir": list_dir,
    "grep_search": grep_search,
    "edit_file": edit_file,
    "write_file": write_file,
    "delete_file": delete_file_tool,
    "file_search": file_search,
}
