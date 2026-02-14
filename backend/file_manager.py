from fastapi import APIRouter
from pathlib import Path
import os

router = APIRouter()

# Auto-detect the actual project root: the parent of the backend/ directory
# This ensures the full project (frontend + backend + everything) is visible
_BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = _BACKEND_DIR.parent  # /Users/.../ai-ide/


def set_project_root_path(path_str):
    """Set the project root from an external source (e.g. CLI args, Electron)."""
    global PROJECT_ROOT
    target = Path(path_str).resolve()
    if target.exists() and target.is_dir():
        PROJECT_ROOT = target


@router.get("/workspace")
def get_workspace():
    """Return the current project root path."""
    return {"path": str(PROJECT_ROOT), "name": PROJECT_ROOT.name}


@router.post("/open-folder")
def open_folder(path: str):
    """Change the project root to a new folder."""
    global PROJECT_ROOT

    target = Path(path).expanduser().resolve()

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


def _list_dir(dir_path, show_hidden=False):
    """List immediate children of a directory (one level only). Fast.
    show_hidden: if True, include files/folders whose names start with '.' (hidden)."""
    items = []
    try:
        entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return []

    for p in entries:
        if not show_hidden and p.name.startswith(".") and p.name not in ('.env', '.gitignore', '.editorconfig'):
            continue
        if p.name in SKIP_FILES and not (show_hidden and p.name.startswith('.')):
            continue

        if p.is_dir():
            if p.name in SKIP_DIRS:
                continue
            # Check if folder has visible children (for chevron indicator)
            has_children = False
            try:
                for child in p.iterdir():
                    if not show_hidden and child.name.startswith(".") and child.name not in ('.env', '.gitignore', '.editorconfig'):
                        continue
                    if child.name in SKIP_FILES and not (show_hidden and child.name.startswith('.')):
                        continue
                    if child.is_dir() and child.name in SKIP_DIRS:
                        continue
                    has_children = True
                    break
            except PermissionError:
                pass
            items.append({
                "name": p.name,
                "type": "folder",
                "children": [],  # Lazy — loaded on expand
                "hasChildren": has_children,
            })
        else:
            try:
                size = p.stat().st_size
            except Exception:
                size = 0
            items.append({
                "name": p.name,
                "type": "file",
                "size": size,
            })

    return items


@router.get("/tree")
def get_tree(show_hidden: bool = False):
    """Return the top-level directory listing (one level). Fast. show_hidden: include dotfiles/dotdirs."""
    return _list_dir(PROJECT_ROOT, show_hidden=show_hidden)


@router.get("/tree-children")
def get_tree_children(path: str, show_hidden: bool = False):
    """Return children of a subdirectory (lazy loading on expand). show_hidden: include dotfiles/dotdirs."""
    target = (PROJECT_ROOT / path).resolve()

    # Security: prevent reading outside project root
    if not str(target).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied"}

    if not target.exists() or not target.is_dir():
        return []

    return _list_dir(target, show_hidden=show_hidden)


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


@router.post("/rename")
def rename_path(path: str, new_name: str):
    """Rename a file or folder. new_name is the new base name (not full path)."""
    file_path = (PROJECT_ROOT / path).resolve()
    if not str(file_path).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied: path outside project directory"}
    if not file_path.exists():
        return {"error": "File or folder not found"}
    if not new_name or new_name.strip() != new_name or "/" in new_name or "\\" in new_name:
        return {"error": "Invalid new name"}
    new_path = file_path.parent / new_name.strip()
    if new_path.exists():
        return {"error": "A file or folder with that name already exists"}
    try:
        file_path.rename(new_path)
        rel = new_path.relative_to(PROJECT_ROOT)
        return {"status": "renamed", "path": str(rel)}
    except Exception as e:
        return {"error": str(e)}


@router.post("/move")
def move_path(path: str, dest: str):
    """Move a file or folder to a new location. dest is the destination directory path (relative to project root)."""
    file_path = (PROJECT_ROOT / path).resolve()
    dest_dir = (PROJECT_ROOT / dest).resolve()
    if not str(file_path).startswith(str(PROJECT_ROOT)) or not str(dest_dir).startswith(str(PROJECT_ROOT)):
        return {"error": "Access denied: path outside project directory"}
    if not file_path.exists():
        return {"error": "File or folder not found"}
    if not dest_dir.is_dir():
        return {"error": "Destination is not a directory"}
    # Prevent moving a directory into itself or a descendant
    try:
        file_path.relative_to(dest_dir)
        return {"error": "Cannot move a folder into itself"}
    except ValueError:
        pass
    if str(dest_dir).startswith(str(file_path)) and file_path.is_dir():
        return {"error": "Cannot move a folder into its own subfolder"}
    new_path = dest_dir / file_path.name
    if new_path.exists():
        return {"error": "A file or folder with that name already exists at the destination"}
    try:
        import shutil
        shutil.move(str(file_path), str(new_path))
        rel = new_path.relative_to(PROJECT_ROOT)
        return {"status": "moved", "path": str(rel)}
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
