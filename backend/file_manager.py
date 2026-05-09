from fastapi import APIRouter
from pathlib import Path
from pydantic import BaseModel
import os
import sys
from typing import Optional, Tuple, Any, List

router = APIRouter()

# NOTE: The desktop app should start with *no* workspace open so the Welcome
# screen is shown on first launch. The workspace is set explicitly via
# /files/open-folder or --project-root.
PROJECT_ROOT: Optional[Path] = None


def _require_project_root() -> Tuple[Optional[Path], Optional[dict]]:
    root = PROJECT_ROOT
    if not root:
        return None, {"error": "No workspace is open. Open a folder to get started."}
    return root, None


def _is_within_root(target: Path, root: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def set_project_root_path(path_str: Any):
    """Set the project root from an external source (e.g. CLI args, Electron)."""
    global PROJECT_ROOT
    p = (str(path_str).strip() if path_str is not None else "")
    if not p:
        PROJECT_ROOT = None
        return False
    target = Path(p).expanduser().resolve()
    if target.exists() and target.is_dir():
        PROJECT_ROOT = target
        return True
    return False


@router.get("/workspace")
def get_workspace():
    """Return the current project root path."""
    if not PROJECT_ROOT:
        return {"open": False, "path": "", "name": ""}
    return {"open": True, "path": str(PROJECT_ROOT), "name": PROJECT_ROOT.name}


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


class ResolvePathRequest(BaseModel):
    folder_name: str
    entries: List[str] = []


_SKIP_DIRS = {
    'node_modules', '.git', '__pycache__', 'venv', '.venv', 'env', '.env',
    'dist', 'build', '$Recycle.Bin', 'Windows', 'Program Files',
    'Program Files (x86)', 'System Volume Information', 'PerfLogs',
    'Recovery', 'ProgramData', 'AppData', 'Temp', 'tmp',
}


def _search_for_folder(root: Path, folder_name: str, entry_set: set, max_depth: int):
    """BFS search for a directory named folder_name inside root up to max_depth."""
    matches = []
    if max_depth <= 0:
        return matches
    try:
        for p in root.iterdir():
            if not p.is_dir() or p.name in _SKIP_DIRS or p.name.startswith('$'):
                continue
            if p.name == folder_name:
                score = 0
                if entry_set:
                    try:
                        actual = {c.name for c in p.iterdir()}
                        score = len(entry_set & actual)
                    except Exception:
                        pass
                matches.append((score, str(p)))
            elif max_depth > 1:
                matches.extend(_search_for_folder(p, folder_name, entry_set, max_depth - 1))
    except PermissionError:
        pass
    return matches


@router.post("/resolve-path")
def resolve_path_from_name(body: ResolvePathRequest):
    """Auto-detect the absolute path of a browser-opened folder by its name + file listing."""
    name = (body.folder_name or "").strip()
    if not name or '/' in name or '\\' in name:
        return {"found": False, "path": None}

    entry_set = set(body.entries or [])
    home = Path.home()

    # Ordered search roots: most-likely locations first, drive roots last
    roots = []
    for d in [home, home / "Desktop", home / "Documents", home / "Downloads"]:
        if d.exists():
            roots.append((d, 3))
    for dev in ["projects", "source", "src", "code", "dev", "repos", "workspace", "work", "sites"]:
        d = home / dev
        if d.exists():
            roots.append((d, 3))

    if sys.platform == "win32":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:\\")
            try:
                if drive.exists():
                    roots.append((drive, 2))
            except OSError:
                pass
    else:
        roots.append((Path("/"), 2))

    all_matches = []
    for root, depth in roots:
        all_matches.extend(_search_for_folder(root, name, entry_set, depth))

    if not all_matches:
        return {"found": False, "path": None}

    # Rank: most file overlap first, then shortest path (less nesting = more likely)
    all_matches.sort(key=lambda x: (-x[0], len(x[1])))
    best_path = all_matches[0][1]

    # Also set as the project root
    global PROJECT_ROOT
    PROJECT_ROOT = Path(best_path)

    return {"found": True, "path": best_path}


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
                folders.append({"name": p.name, "path": str(p)})
    except PermissionError:
        pass

    parent = str(target.parent) if target.parent != target else ""

    return {
        "current": str(target),
        "parent": parent,
        "folders": folders,
    }

# Directories and files to skip in the tree
MAX_TREE_DEPTH = 10


def _list_dir(dir_path, show_hidden=False):
    """List all children of a directory — nothing is filtered or skipped."""
    items = []
    try:
        entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return []

    for p in entries:
        if p.is_dir():
            items.append({
                "name": p.name,
                "type": "folder",
                "children": [],
                "hasChildren": True,
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
    if not PROJECT_ROOT:
        return []
    return _list_dir(PROJECT_ROOT, show_hidden=show_hidden)


@router.get("/tree-children")
def get_tree_children(path: str, show_hidden: bool = False):
    """Return children of a subdirectory (lazy loading on expand). show_hidden: include dotfiles/dotdirs."""
    root, err = _require_project_root()
    if err:
        return []

    target = (root / path).resolve()

    # Security: prevent reading outside project root
    if not _is_within_root(target, root):
        return {"error": "Access denied"}

    if not target.exists() or not target.is_dir():
        return []

    return _list_dir(target, show_hidden=show_hidden)


@router.get("/read")
def read_file(path: str):
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / path).resolve()

    # Security: prevent reading outside project root
    if not _is_within_root(file_path, root):
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
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / path).resolve()

    # Security: prevent writing outside project root
    if not _is_within_root(file_path, root):
        return {"error": "Access denied: path outside project directory"}

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding='utf-8')
        return {"status": "saved"}
    except Exception as e:
        return {"error": str(e)}


@router.post("/create")
def create_file(path: str, is_folder: bool = False):
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / path).resolve()

    if not _is_within_root(file_path, root):
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
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / path).resolve()

    if not _is_within_root(file_path, root):
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
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / path).resolve()
    if not _is_within_root(file_path, root):
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
        rel = new_path.relative_to(root)
        return {"status": "renamed", "path": str(rel)}
    except Exception as e:
        return {"error": str(e)}


@router.post("/move")
def move_path(path: str, dest: str):
    """Move a file or folder to a new location. dest is the destination directory path (relative to project root)."""
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / path).resolve()
    dest_dir = (root / dest).resolve()
    if not _is_within_root(file_path, root) or not _is_within_root(dest_dir, root):
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
        rel = new_path.relative_to(root)
        return {"status": "moved", "path": str(rel)}
    except Exception as e:
        return {"error": str(e)}


@router.get("/search")
def search_files(query: str, case_sensitive: bool = False):
    """Search for text across all project files."""
    root, err = _require_project_root()
    if err:
        return {"results": [], "truncated": False}

    results = []
    max_results = 200

    for root_dir, dirs, files in os.walk(root):
        # Skip dirs that are useless to search (node_modules, caches, build output)
        _SEARCH_SKIP = {'node_modules', '__pycache__', '.git', 'dist', 'build',
                        '.next', '.cache', 'venv', '.venv', 'coverage', 'vendor'}
        dirs[:] = [d for d in dirs if d not in _SEARCH_SKIP and not d.startswith('.')]

        for file in files:
            if file in SKIP_FILES or file.startswith('.'):
                continue

            full_path = os.path.join(root_dir, file)
            rel_path = os.path.relpath(full_path, root)

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
