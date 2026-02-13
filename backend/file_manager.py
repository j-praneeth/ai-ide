from fastapi import APIRouter
from pathlib import Path
import os

router = APIRouter()

# Auto-detect the actual project root: the parent of the backend/ directory
# This ensures the full project (frontend + backend + everything) is visible
_BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = _BACKEND_DIR.parent  # /Users/.../ai-ide/


@router.get("/workspace")
def get_workspace():
    """Return the current project root path."""
    return {"path": str(PROJECT_ROOT), "name": PROJECT_ROOT.name}


@router.post("/open-folder")
def open_folder(path: str):
    """Change the project root to a new folder."""
    global PROJECT_ROOT

    target = Path(path).resolve()

    if not target.exists():
        return {"error": f"Path does not exist: {path}"}
    if not target.is_dir():
        return {"error": f"Path is not a directory: {path}"}

    PROJECT_ROOT = target
    return {"status": "opened", "path": str(PROJECT_ROOT), "name": PROJECT_ROOT.name}


@router.get("/list-folders")
def list_folders(path: str = "~"):
    """List subdirectories of a given path for the Open Folder browser."""
    target = Path(path).expanduser().resolve()

    if not target.exists() or not target.is_dir():
        return {"error": f"Invalid directory: {path}", "folders": [], "parent": ""}

    folders = []
    try:
        for p in sorted(target.iterdir(), key=lambda x: x.name.lower()):
            if p.is_dir() and not p.name.startswith('.'):
                folders.append({
                    "name": p.name,
                    "path": str(p),
                })
    except PermissionError:
        pass

    parent = str(target.parent) if target.parent != target else ""

    return {
        "current": str(target),
        "parent": parent,
        "folders": folders,
    }

# Directories and files to skip in the tree
SKIP_DIRS = {
    'node_modules', '.git', '__pycache__', '.next', '.cache',
    'venv', 'env', '.env', 'dist', 'build', '.idea', '.vscode',
    '.cursor', 'coverage', '.pytest_cache', '.mypy_cache',
    'egg-info', '.tox', '.nox', 'target', 'vendor',
}

SKIP_FILES = {
    '.DS_Store', 'Thumbs.db', '.gitkeep',
}

MAX_TREE_DEPTH = 10


@router.get("/tree")
def get_tree():
    def build_tree(path, depth=0):
        if depth > MAX_TREE_DEPTH:
            return []

        tree = []
        try:
            entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return []

        for p in entries:
            # Skip hidden files/dirs and known directories
            if p.name.startswith(".") and p.name not in ('.env', '.gitignore', '.editorconfig'):
                continue
            if p.name in SKIP_FILES:
                continue

            if p.is_dir():
                if p.name in SKIP_DIRS:
                    continue
                children = build_tree(p, depth + 1)
                tree.append({
                    "name": p.name,
                    "type": "folder",
                    "children": children
                })
            else:
                tree.append({
                    "name": p.name,
                    "type": "file",
                    "size": p.stat().st_size if p.exists() else 0,
                })

        return tree

    return build_tree(PROJECT_ROOT)


@router.get("/read")
def read_file(path: str):
    file_path = (PROJECT_ROOT / path).resolve()

    # Security: prevent reading outside project root
    if not str(file_path).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied: path outside project directory"}

    if not file_path.exists():
        return {"error": "File not found"}

    if not file_path.is_file():
        return {"error": "Not a file"}

    try:
        return {"content": file_path.read_text(encoding='utf-8')}
    except UnicodeDecodeError:
        return {"error": "Cannot read binary file"}
    except Exception as e:
        return {"error": str(e)}


@router.post("/write")
def write_file(path: str, content: str):
    file_path = (PROJECT_ROOT / path).resolve()

    # Security: prevent writing outside project root
    if not str(file_path).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied: path outside project directory"}

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding='utf-8')
        return {"status": "saved"}
    except Exception as e:
        return {"error": str(e)}


@router.post("/create")
def create_file(path: str, is_folder: bool = False):
    file_path = (PROJECT_ROOT / path).resolve()

    if not str(file_path).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied: path outside project directory"}

    try:
        if is_folder:
            file_path.mkdir(parents=True, exist_ok=True)
            return {"status": "folder created"}
        else:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.touch()
            return {"status": "file created"}
    except Exception as e:
        return {"error": str(e)}


@router.delete("/delete")
def delete_file(path: str):
    file_path = (PROJECT_ROOT / path).resolve()

    if not str(file_path).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied: path outside project directory"}

    try:
        if file_path.is_dir():
            import shutil
            shutil.rmtree(file_path)
        else:
            file_path.unlink()
        return {"status": "deleted"}
    except Exception as e:
        return {"error": str(e)}


@router.get("/search")
def search_files(query: str, case_sensitive: bool = False):
    """Search for text across all project files."""
    results = []
    max_results = 200

    for root_dir, dirs, files in os.walk(PROJECT_ROOT):
        # Skip hidden/known directories
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]

        for file in files:
            if file in SKIP_FILES or file.startswith('.'):
                continue

            full_path = os.path.join(root_dir, file)
            rel_path = os.path.relpath(full_path, PROJECT_ROOT)

            # Skip binary/large files
            try:
                size = os.path.getsize(full_path)
                if size > 1_000_000:  # Skip files > 1MB
                    continue
            except:
                continue

            try:
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                    for i, line in enumerate(f, 1):
                        search_line = line if case_sensitive else line.lower()
                        search_query = query if case_sensitive else query.lower()

                        if search_query in search_line:
                            results.append({
                                "file": rel_path,
                                "line": i,
                                "text": line.strip()[:200],
                            })
                            if len(results) >= max_results:
                                return {"results": results, "truncated": True}
            except:
                continue

    return {"results": results, "truncated": False}
