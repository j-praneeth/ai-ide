from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pathlib import Path
from pydantic import BaseModel
import os
import sys
import json
import re as _re
import fnmatch
import time as _time
from typing import Optional, Tuple, Any, List
import subprocess

# Hard cap on how many directory entries we will ever iterate.
# This prevents node_modules / .git from taking minutes to scan.
_SCAN_HARD_CAP = 3000

# Performance logging helper
def _perf_log(label: str, t0: float):
    dt = (_time.perf_counter() - t0) * 1000
    if dt > 100:
        print(f"[PERF] {label}: {dt:.1f}ms  ⚠ SLOW", flush=True)
    else:
        print(f"[PERF] {label}: {dt:.1f}ms", flush=True)

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
def open_folder(path: str, show_hidden: bool = False):
    """Change the project root to a new folder and return the top-level tree."""
    global PROJECT_ROOT

    target = Path(path).expanduser().resolve()

    if not target.exists():
        return {"error": f"Path does not exist: {path}"}
    if not target.is_dir():
        return {"error": f"Path is not a directory: {path}"}

    PROJECT_ROOT = target

    t0 = _time.perf_counter()
    tree = _list_dir(target, show_hidden=show_hidden, skip_size=True)
    _perf_log("open-folder tree", t0)

    return {
        "status": "opened",
        "path": str(PROJECT_ROOT),
        "name": PROJECT_ROOT.name,
        "tree": tree,
    }


class ResolvePathRequest(BaseModel):
    folder_name: str
    entries: List[str] = []


class GitCheckIgnoreBody(BaseModel):
    paths: List[str] = []


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
        # Scan /Users (macOS) and /home (Linux) at depth 2 to catch other users'
        # home directories, but never walk the entire filesystem root ("/").
        for top in [Path("/Users"), Path("/home")]:
            if top.exists():
                roots.append((top, 2))

    all_matches = []
    for root, depth in roots:
        matches = _search_for_folder(root, name, entry_set, depth)
        all_matches.extend(matches)
        # Early-exit: a high-confidence match (overlapping entries) found under a
        # common user directory — no need to scan the rest of the filesystem.
        if any(score > 0 for score, _ in matches):
            break

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


_MAX_FILE_LIST = 2000  # max entries returned per directory

def _list_dir(dir_path, show_hidden=False, skip_size=False):
    """
    List directory contents efficiently using os.scandir().

    Key performance properties:
    - os.scandir() returns DirEntry objects whose is_dir() is FREE (from the OS
      readdir dirent, no extra syscall), unlike Path.iterdir() on some platforms.
    - follow_symlinks=False prevents following symlinks that may point to network
      mounts or slow remote filesystems.
    - Hard iteration cap (_SCAN_HARD_CAP) stops after N entries regardless of
      directory size — node_modules has 50k entries, we never need to read all of
      them just to display the first 2000.
    - stat() is deferred: file sizes are obtained via DirEntry.stat() which is
      cheaper than os.stat() because the data may already be cached from scandir.
    - skip_size=True skips stat entirely (zero-cost mode for initial tree load).
    """
    t0 = _time.perf_counter()
    dirs = []
    files = []
    _file_entries = []

    try:
        count = 0
        with os.scandir(str(dir_path)) as it:
            for entry in it:
                count += 1
                if count > _SCAN_HARD_CAP:
                    break
                if not show_hidden and entry.name.startswith('.'):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        dirs.append(entry.name)
                    else:
                        files.append(entry.name)
                        _file_entries.append(entry)
                except OSError:
                    continue
    except (PermissionError, OSError):
        return []

    dirs.sort(key=str.lower)

    # Sort files and their DirEntry objects in parallel
    paired = sorted(zip(files, _file_entries), key=lambda x: x[0].lower())
    if paired:
        files, _file_entries = zip(*paired)
    else:
        files, _file_entries = [], []

    items = []

    for name in dirs[:_MAX_FILE_LIST]:
        items.append({
            "name": name,
            "type": "folder",
            "children": [],
            "hasChildren": True,
        })

    remaining = _MAX_FILE_LIST - len(items)
    for i, name in enumerate(files[:remaining]):
        size = 0
        if not skip_size and i < len(_file_entries):
            try:
                size = _file_entries[i].stat(follow_symlinks=False).st_size
            except OSError:
                size = 0
        items.append({
            "name": name,
            "type": "file",
            "size": size,
        })

    _perf_log(f"_list_dir({dir_path.name}) = {len(items)} items", t0)
    return items


@router.get("/tree")
def get_tree(show_hidden: bool = False):
    """Return the top-level directory listing (one level). Fast. show_hidden: include dotfiles/dotdirs."""
    if not PROJECT_ROOT:
        return []
    t0 = _time.perf_counter()
    result = _list_dir(PROJECT_ROOT, show_hidden=show_hidden)
    _perf_log("GET /files/tree", t0)
    return result


@router.post("/tree-batch")
def get_tree_batch(paths: List[str], show_hidden: bool = False):
    """Return children for multiple paths in a single request.
    NOTE: This endpoint is deprecated. The frontend no longer pre-fetches all
    root folders at mount time (lazy loading is preferred). Kept for backward
    compatibility with older clients."""
    t0 = _time.perf_counter()
    root, err = _require_project_root()
    if err:
        return {}
    result = {}
    for p in paths[:100]:  # hard cap to prevent abuse
        target = (root / p).resolve()
        if not _is_within_root(target, root) or not target.is_dir():
            result[p] = []
            continue
        result[p] = _list_dir(target, show_hidden=show_hidden)
    _perf_log(f"POST /files/tree-batch ({len(paths)} paths)", t0)
    return result


@router.post("/git-check-ignore")
def git_check_ignore(body: GitCheckIgnoreBody):
    """Return which workspace-relative paths are ignored by git (same as VS Code dimmed files)."""
    root, err = _require_project_root()
    if err:
        return {"ignored": []}

    try:
        gr = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--git-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if gr.returncode != 0:
            return {"ignored": []}
    except (FileNotFoundError, OSError):
        return {"ignored": []}

    safe: List[str] = []
    for raw in (body.paths or [])[:3000]:
        s = str(raw).replace("\\", "/").strip()
        if not s or any(p == '..' for p in s.split('/')):
            continue
        safe.append(s)
    if not safe:
        return {"ignored": []}

    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "check-ignore", "--stdin"],
            input="\n".join(safe) + "\n",
            text=True,
            capture_output=True,
            timeout=30,
        )
        ignored = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
        return {"ignored": ignored}
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return {"ignored": []}


_GIT_NOT_FOUND = 127  # sentinel: git binary absent from PATH

def _run_git(root: Path, args: list, timeout: int = 10) -> tuple:
    """Run a git command in root; returns (stdout, returncode).
    returncode == _GIT_NOT_FOUND (127) means git is not in PATH.
    returncode == -1 means timeout or unexpected OS error.
    """
    try:
        r = subprocess.run(
            ["git", "-C", str(root)] + args,
            capture_output=True, text=True, timeout=timeout,
        )
        return (r.stdout or ""), r.returncode
    except FileNotFoundError:
        return "", _GIT_NOT_FOUND
    except OSError:
        return "", -1
    except subprocess.TimeoutExpired:
        return "", -1


_GIT_STATUS_TIMEOUT = 45   # seconds per git command in the status bundle


@router.get("/git-status-bundle")
def git_status_bundle():
    """
    Returns all SCM data needed by SourceControlPanel in a single request.
    All git commands run in parallel with a 45-second per-command timeout so
    slow repos (large history, network drives) never cause a visible timeout.
    Partial failures (e.g. no upstream) are handled gracefully — the response
    is always ok:True as long as at least status + branch succeed.
    """
    root, err = _require_project_root()
    if err:
        return {"error": err.get("error", "no workspace"), "ok": False}

    # Quick repo check — 5s is plenty for rev-parse
    _, rc = _run_git(root, ["rev-parse", "--git-dir"], timeout=5)
    if rc == _GIT_NOT_FOUND:
        return {"ok": False, "error": "git not found in PATH"}
    if rc != 0:
        return {"ok": False, "error": "not a git repository"}

    import concurrent.futures
    T = _GIT_STATUS_TIMEOUT
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        f_status   = ex.submit(_run_git, root, ["status", "--porcelain"], T)
        f_branch   = ex.submit(_run_git, root, ["branch", "--show-current"], T)
        f_upstream = ex.submit(_run_git, root,
                               ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], T)
        f_ab       = ex.submit(_run_git, root,
                               ["rev-list", "--left-right", "--count", "HEAD...@{u}"], T)

    status_out,   s_rc  = f_status.result()
    branch_out,   _     = f_branch.result()
    upstream_out, u_rc  = f_upstream.result()
    ab_out,       ab_rc = f_ab.result()

    ahead = behind = 0
    if ab_rc == 0 and ab_out.strip():
        parts = ab_out.strip().split()
        if len(parts) == 2:
            try: ahead, behind = int(parts[0]), int(parts[1])
            except ValueError: pass

    # Always return ok:True — the UI only needs status + branch to function.
    # Upstream / ahead-behind are bonus info; a timeout on those is not fatal.
    return {
        "ok": True,
        "status": status_out if s_rc == 0 else "",
        "branch": branch_out.strip(),
        "upstream": upstream_out.strip() if u_rc == 0 else "",
        "ahead": ahead,
        "behind": behind,
    }


@router.get("/git-show")
def git_show(path: str, ref: str = "HEAD"):
    """
    Return the content of a tracked file at a specific ref.

    ref values:
        "HEAD"  — content of the file as it appears in the HEAD commit
        "STAGE" — content of the file as it currently sits in the index
                  (i.e. what would be committed if you ran `git commit` now)
        otherwise — passed through verbatim, so callers can ask for any
                    arbitrary revision (branch / commit hash / tag).

    Returns:
        { ok: bool, content: str, exists: bool, error?: str }

        exists=False is the normal case for untracked / newly-added files —
        the diff viewer should render an empty left-hand pane.
    """
    root, err = _require_project_root()
    if err:
        return {"ok": False, "exists": False, "content": "", "error": err.get("error", "no workspace")}

    rel = (path or "").strip().lstrip("/").lstrip("\\")
    if not rel:
        return {"ok": False, "exists": False, "content": "", "error": "path required"}

    # Normalize to forward slashes for git (it accepts both but is consistent
    # with the porcelain output the renderer already sees).
    rel_for_git = rel.replace("\\", "/")

    ref_norm = (ref or "HEAD").strip().upper()
    if ref_norm == "HEAD":
        spec = f"HEAD:{rel_for_git}"
    elif ref_norm in ("STAGE", "STAGED", "INDEX", ":0"):
        spec = f":0:{rel_for_git}"
    else:
        # Caller-provided revision (branch / commit / tag). Keep their case.
        spec = f"{ref}:{rel_for_git}"

    try:
        r = subprocess.run(
            ["git", "-C", str(root), "show", spec],
            capture_output=True, timeout=30,
        )
    except FileNotFoundError:
        return {"ok": False, "exists": False, "content": "", "error": "git not found in PATH"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "exists": False, "content": "", "error": "git show timed out"}
    except Exception as e:
        return {"ok": False, "exists": False, "content": "", "error": str(e)}

    if r.returncode != 0:
        # The most common non-zero exit is "fatal: path X exists on disk but
        # not in <ref>" — i.e. an untracked / newly-added file. That's not an
        # error from the UI's perspective; report exists=False with no content.
        stderr = (r.stderr or b"").decode("utf-8", errors="replace")
        is_missing = (
            "exists on disk, but not in" in stderr
            or "does not exist" in stderr
            or "fatal: path" in stderr
        )
        if is_missing:
            return {"ok": True, "exists": False, "content": ""}
        return {"ok": False, "exists": False, "content": "", "error": stderr.strip() or "git show failed"}

    try:
        content = (r.stdout or b"").decode("utf-8")
    except UnicodeDecodeError:
        # Binary file — surface that so the renderer can show a placeholder
        # rather than a wall of mojibake.
        return {"ok": True, "exists": True, "content": "", "binary": True}

    return {"ok": True, "exists": True, "content": content}


class GitRunBody(BaseModel):
    args: list  # e.g. ["commit", "-m", "my message"]
    timeout: int = 60  # generous default — push/pull over slow networks can take a while


@router.post("/git-run")
def git_run(body: GitRunBody):
    """
    Run an arbitrary git command in the project root using subprocess argument
    lists — no shell interpolation, no platform quote-escaping issues.
    Works identically on Windows (PowerShell) and macOS/Linux.
    """
    root, err = _require_project_root()
    if err:
        return {"ok": False, "output": err.get("error", "no workspace"), "exit_code": 1}

    args = [str(a) for a in (body.args or [])]
    if not args:
        return {"ok": False, "output": "no git args provided", "exit_code": 1}

    try:
        r = subprocess.run(
            ["git", "-C", str(root)] + args,
            capture_output=True, text=True,
            timeout=body.timeout,
        )
        out = (r.stdout or "") + (r.stderr or "")
        return {"ok": r.returncode == 0, "output": out, "exit_code": r.returncode}
    except FileNotFoundError:
        return {"ok": False, "output": "git not found in PATH", "exit_code": 127}
    except subprocess.TimeoutExpired:
        return {"ok": False, "output": "git command timed out", "exit_code": -1}
    except Exception as e:
        return {"ok": False, "output": str(e), "exit_code": -1}


# ─── Branches / Remotes / Tags / In-progress detection ────────────────────────
#
# Read-only listing endpoints. Mutations (create/delete/rename, set-url, push
# tags, merge, rebase, abort) all go through /git-run so we don't duplicate
# the subprocess-wrapping boilerplate above. The frontend's gitService wraps
# both these and /git-run with the same backend-readiness + retry layer.


@router.get("/git-branches")
def git_branches():
    """
    Return local + remote branches and the current branch name.

    Shape:
      {
        ok: true,
        current: "main",
        local: [{ name, isCurrent, upstream, ahead, behind, sha }],
        remote: [{ name, sha }],     # e.g. "origin/main"
      }
    """
    root, err = _require_project_root()
    if err:
        return {"ok": False, "error": err.get("error", "no workspace"),
                "current": "", "local": [], "remote": []}

    # `for-each-ref` is the canonical way to enumerate branches with metadata
    # in one shot — it avoids three separate `git branch` calls.
    fmt_local  = "%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(upstream:track)"
    fmt_remote = "%(refname:short)%09%(objectname:short)"

    cur_out, _ = _run_git(root, ["rev-parse", "--abbrev-ref", "HEAD"], timeout=5)
    current = cur_out.strip()
    # "HEAD" means detached HEAD — surface as empty string so the UI shows the
    # raw SHA instead of pretending we're on a branch.
    if current == "HEAD":
        current = ""

    local_out, lrc = _run_git(root, [
        "for-each-ref", "--format", fmt_local, "refs/heads/"
    ], timeout=15)
    remote_out, rrc = _run_git(root, [
        "for-each-ref", "--format", fmt_remote, "refs/remotes/"
    ], timeout=15)

    def _parse_track(track: str):
        # "[ahead 2, behind 1]" / "[ahead 1]" / "[behind 3]" / "[gone]" / ""
        if not track:
            return 0, 0, False
        gone = "gone" in track
        ahead = behind = 0
        m_a = _re.search(r"ahead (\d+)", track)
        m_b = _re.search(r"behind (\d+)", track)
        if m_a: ahead = int(m_a.group(1))
        if m_b: behind = int(m_b.group(1))
        return ahead, behind, gone

    local = []
    if lrc == 0:
        for line in (local_out or "").splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            name     = parts[0] if len(parts) > 0 else ""
            sha      = parts[1] if len(parts) > 1 else ""
            upstream = parts[2] if len(parts) > 2 else ""
            track    = parts[3] if len(parts) > 3 else ""
            ahead, behind, gone = _parse_track(track)
            local.append({
                "name": name,
                "sha": sha,
                "isCurrent": name == current,
                "upstream": upstream,
                "ahead": ahead,
                "behind": behind,
                "gone": gone,
            })

    remote = []
    if rrc == 0:
        for line in (remote_out or "").splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            name = parts[0] if len(parts) > 0 else ""
            sha  = parts[1] if len(parts) > 1 else ""
            # Skip the symbolic "origin/HEAD" pointer — it's noise in the picker.
            if name.endswith("/HEAD"):
                continue
            remote.append({"name": name, "sha": sha})

    return {"ok": True, "current": current, "local": local, "remote": remote}


@router.get("/git-remotes")
def git_remotes():
    """
    Return configured remotes with their fetch/push URLs.

    Shape: { ok, remotes: [{ name, fetch, push }] }
    """
    root, err = _require_project_root()
    if err:
        return {"ok": False, "error": err.get("error", "no workspace"), "remotes": []}

    out, rc = _run_git(root, ["remote", "-v"], timeout=10)
    if rc != 0:
        return {"ok": True, "remotes": []}

    # `git remote -v` lines look like:
    #   origin  https://github.com/foo/bar.git (fetch)
    #   origin  https://github.com/foo/bar.git (push)
    by_name: dict = {}
    for line in (out or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        name, url, kind = parts[0], parts[1], parts[2].strip("()")
        entry = by_name.setdefault(name, {"name": name, "fetch": "", "push": ""})
        if kind == "fetch":
            entry["fetch"] = url
        elif kind == "push":
            entry["push"] = url
    return {"ok": True, "remotes": list(by_name.values())}


@router.get("/git-tags")
def git_tags():
    """
    Return all tags with their target SHA and annotation subject (if any).

    Shape: { ok, tags: [{ name, sha, subject, annotated }] }
    """
    root, err = _require_project_root()
    if err:
        return {"ok": False, "error": err.get("error", "no workspace"), "tags": []}

    fmt = "%(refname:short)%09%(objectname:short)%09%(objecttype)%09%(contents:subject)"
    out, rc = _run_git(root, ["for-each-ref", "--sort=-creatordate",
                              "--format", fmt, "refs/tags/"], timeout=15)
    if rc != 0:
        return {"ok": True, "tags": []}

    tags = []
    for line in (out or "").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        name      = parts[0] if len(parts) > 0 else ""
        sha       = parts[1] if len(parts) > 1 else ""
        obj_type  = parts[2] if len(parts) > 2 else ""
        subject   = parts[3] if len(parts) > 3 else ""
        tags.append({
            "name": name,
            "sha": sha,
            "annotated": obj_type == "tag",
            "subject": subject,
        })
    return {"ok": True, "tags": tags}


@router.get("/git-progress")
def git_progress():
    """
    Detect in-progress merge / rebase / cherry-pick / revert / bisect so the
    UI can offer Abort / Continue controls — same heuristics VS Code uses.

    Shape: { ok, inProgress: { merge, rebase, cherryPick, revert, bisect } }
    """
    root, err = _require_project_root()
    if err:
        return {"ok": False, "inProgress": {}}

    git_dir_out, rc = _run_git(root, ["rev-parse", "--git-dir"], timeout=5)
    if rc != 0:
        return {"ok": False, "inProgress": {}}

    git_dir = Path(git_dir_out.strip())
    if not git_dir.is_absolute():
        git_dir = (root / git_dir).resolve()

    progress = {
        "merge":      (git_dir / "MERGE_HEAD").exists(),
        "rebase":     (git_dir / "rebase-merge").exists() or (git_dir / "rebase-apply").exists(),
        "cherryPick": (git_dir / "CHERRY_PICK_HEAD").exists(),
        "revert":     (git_dir / "REVERT_HEAD").exists(),
        "bisect":     (git_dir / "BISECT_LOG").exists(),
    }
    return {"ok": True, "inProgress": progress}


class GitCloneBody(BaseModel):
    url: str
    target_dir: str            # absolute path of the directory to clone into
    depth: Optional[int] = None  # optional --depth N for shallow clone
    branch: Optional[str] = None # optional --branch
    timeout: int = 600         # 10 min default — large repos over slow links


@router.post("/git-clone")
def git_clone(body: GitCloneBody):
    """
    Clone a repository. Runs OUTSIDE the project root (target_dir may not even
    exist yet). The frontend is expected to call /files/open-folder afterwards
    to switch the workspace to the freshly cloned repo.

    Shape: { ok, output, exit_code, target }
    """
    url    = (body.url or "").strip()
    target = (body.target_dir or "").strip()
    if not url:
        return {"ok": False, "output": "url required", "exit_code": 1, "target": ""}
    if not target:
        return {"ok": False, "output": "target_dir required", "exit_code": 1, "target": ""}

    target_path = Path(target).expanduser().resolve()
    parent = target_path.parent
    if not parent.exists() or not parent.is_dir():
        return {"ok": False, "output": f"parent directory does not exist: {parent}",
                "exit_code": 1, "target": str(target_path)}

    args = ["clone", "--progress"]
    if body.depth and body.depth > 0:
        args += ["--depth", str(int(body.depth))]
    if body.branch:
        args += ["--branch", str(body.branch)]
    args += [url, str(target_path)]

    try:
        r = subprocess.run(
            ["git"] + args,
            capture_output=True, text=True,
            timeout=max(30, int(body.timeout or 600)),
        )
        out = (r.stdout or "") + (r.stderr or "")
        return {
            "ok": r.returncode == 0,
            "output": out,
            "exit_code": r.returncode,
            "target": str(target_path),
        }
    except FileNotFoundError:
        return {"ok": False, "output": "git not found in PATH",
                "exit_code": 127, "target": str(target_path)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "output": "git clone timed out",
                "exit_code": -1, "target": str(target_path)}
    except Exception as e:
        return {"ok": False, "output": str(e),
                "exit_code": -1, "target": str(target_path)}


class GitInitBody(BaseModel):
    target_dir: Optional[str] = None   # absolute path; defaults to current PROJECT_ROOT
    initial_branch: Optional[str] = "main"


@router.post("/git-init")
def git_init(body: GitInitBody):
    """
    Initialize a git repository.

    If target_dir is provided, init there (parent must exist). Otherwise
    init in the current workspace. Always passes -b <initial_branch> when
    the user's git supports it, defaulting to "main".

    Shape: { ok, output, exit_code, target }
    """
    target = (body.target_dir or "").strip()
    if target:
        target_path = Path(target).expanduser().resolve()
    else:
        root, err = _require_project_root()
        if err:
            return {"ok": False, "output": err.get("error", "no workspace"),
                    "exit_code": 1, "target": ""}
        target_path = root

    if not target_path.exists():
        try:
            target_path.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return {"ok": False, "output": f"could not create {target_path}: {e}",
                    "exit_code": 1, "target": str(target_path)}

    initial_branch = (body.initial_branch or "main").strip() or "main"

    # `-b <branch>` was added in git 2.28. If the user's git is older we'll
    # retry without it and rely on init.defaultBranch / the legacy `master`.
    def _try(args):
        try:
            r = subprocess.run(
                ["git", "-C", str(target_path)] + args,
                capture_output=True, text=True, timeout=30,
            )
            return (r.stdout or "") + (r.stderr or ""), r.returncode
        except FileNotFoundError:
            return "git not found in PATH", 127
        except Exception as e:
            return str(e), -1

    out, rc = _try(["init", "-b", initial_branch])
    if rc != 0 and "unknown option" in (out or "").lower():
        out, rc = _try(["init"])

    return {
        "ok": rc == 0,
        "output": out,
        "exit_code": rc,
        "target": str(target_path),
    }


@router.get("/tree-children")
def get_tree_children(path: str, show_hidden: bool = False):
    """Return children of a subdirectory (lazy loading on expand). show_hidden: include dotfiles/dotdirs."""
    t0 = _time.perf_counter()
    root, err = _require_project_root()
    if err:
        return []

    target = (root / path).resolve()

    # Security: prevent reading outside project root
    if not _is_within_root(target, root):
        return {"error": "Access denied"}

    if not target.exists() or not target.is_dir():
        return []

    result = _list_dir(target, show_hidden=show_hidden)
    _perf_log(f"GET /files/tree-children?path={path}", t0)
    return result


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
        size = file_path.stat().st_size
        if size > 2 * 1024 * 1024:  # 2 MB hard limit
            return {"error": f"File too large to open in editor ({size // 1024} KB). Use a terminal to view it."}
        return {"content": file_path.read_text(encoding='utf-8')}
    except UnicodeDecodeError:
        return {"error": "Cannot read binary file"}
    except Exception as e:
        return {"error": str(e)}


class _WriteRequest(BaseModel):
    path: str
    content: str


@router.post("/write")
def write_file(req: _WriteRequest):
    root, err = _require_project_root()
    if err:
        return err

    file_path = (root / req.path).resolve()

    # Security: prevent writing outside project root
    if not _is_within_root(file_path, root):
        return {"error": "Access denied: path outside project directory"}

    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(req.content, encoding='utf-8')
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


# NOTE: /git-check-ignore is registered exactly once near the top of this file
# using a real `git check-ignore --stdin` subprocess. A second duplicate
# handler that used an fnmatch-based parser was removed — FastAPI only honoured
# the last registration, so the manual parser was overriding the authoritative
# git-driven implementation. Always trust git's own ignore semantics.


_SEARCH_SKIP = {
    'node_modules', '__pycache__', '.git', 'dist', 'build',
    '.next', '.cache', 'venv', '.venv', 'coverage', 'vendor',
}


def _search_generator(root, query: str, case_sensitive: bool, use_regex: bool, max_results: int):
    """Generator that yields matching lines one at a time — mirrors ripgrep stdout streaming."""
    count = 0
    flags = 0 if case_sensitive else _re.IGNORECASE

    if use_regex:
        try:
            pattern = _re.compile(query, flags)
        except _re.error:
            return
        def matches(line): return bool(pattern.search(line))
    else:
        needle = query if case_sensitive else query.lower()
        def matches(line): return needle in (line if case_sensitive else line.lower())

    for root_dir, dirs, files in os.walk(str(root)):
        dirs[:] = [d for d in dirs if d not in _SEARCH_SKIP and not d.startswith('.')]

        for file in sorted(files):
            if file.startswith('.'):
                continue
            full_path = os.path.join(root_dir, file)
            rel_path = os.path.relpath(full_path, str(root)).replace(os.sep, '/')
            try:
                if os.path.getsize(full_path) > 1_000_000:
                    continue
            except OSError:
                continue
            try:
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                    for i, line in enumerate(f, 1):
                        if matches(line):
                            yield {'file': rel_path, 'line': i, 'text': line.strip()[:200]}
                            count += 1
                            if count >= max_results:
                                return
            except OSError:
                continue


@router.get("/search")
def search_files(query: str, case_sensitive: bool = False, use_regex: bool = False):
    """Batch search — returns all results at once (kept for backwards compat)."""
    root, err = _require_project_root()
    if err:
        return {"results": [], "truncated": False}

    results = list(_search_generator(root, query, case_sensitive, use_regex, 200))
    truncated = len(results) >= 200
    return {"results": results, "truncated": truncated}


@router.get("/glob-search")
def glob_search(query: str = ""):
    """Search for files by name/pattern in the project directory. Returns matching file paths."""
    root, err = _require_project_root()
    if err or not query:
        return {"results": []}
    query_lower = query.strip().lower()
    results = []
    count = 0
    for dirpath, _, filenames in os.walk(root):
        # Skip hidden directories and node_modules
        if "/." in dirpath or "/node_modules" in dirpath or "/.git" in dirpath:
            continue
        for f in filenames:
            if query_lower in f.lower():
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, root)
                results.append(rel)
                count += 1
                if count >= 50:
                    return {"results": results, "truncated": True}
    return {"results": results, "truncated": False}


@router.get("/search-stream")
def search_files_stream(query: str, case_sensitive: bool = False, use_regex: bool = False):
    """
    SSE streaming search — mirrors VS Code's ripgrep stdout streaming.

    Each match is emitted as an SSE event immediately, so the UI can
    display results before the search completes. The frontend uses an
    80 ms RunOnceScheduler to batch DOM updates (same as VS Code).
    """
    root, err = _require_project_root()
    if err:
        def empty():
            yield 'data: {"done":true,"truncated":false}\n\n'
        return StreamingResponse(empty(), media_type='text/event-stream')

    def generate():
        count = 0
        for match in _search_generator(root, query, case_sensitive, use_regex, 500):
            yield f'data: {json.dumps(match)}\n\n'
            count += 1
        yield f'data: {json.dumps({"done": True, "truncated": count >= 500})}\n\n'

    return StreamingResponse(
        generate(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    )
