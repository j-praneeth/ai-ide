from fastapi import APIRouter
import subprocess
import os
import platform
import getpass
import re

router = APIRouter()

# Use the actual project root (parent of backend/)
import file_manager

# Per-session cwd tracking (key = session id string, value = cwd path string)
_session_cwds: dict = {}

# Blocked dangerous commands
BLOCKED_PATTERNS = [
    "rm -rf /",
    "rm -rf ~",
    "shutdown",
    "reboot",
    "mkfs",
    "dd if=",
    ":(){:|:&};:",
    "fork bomb",
    "sudo rm",
    "chmod -R 777 /",
]


def _get_hostname():
    """Get short hostname."""
    try:
        return platform.node().split('.')[0]
    except Exception:
        return "localhost"


def _get_username():
    """Get current username."""
    try:
        return getpass.getuser()
    except Exception:
        return "user"


def _get_short_dir(full_path, project_root):
    """Get shortened directory name for prompt (like VS Code)."""
    try:
        full = os.path.realpath(full_path)
        root = os.path.realpath(str(project_root))
        if full == root:
            return os.path.basename(root)
        if full.startswith(root):
            rel = os.path.relpath(full, root)
            return os.path.basename(root) + "/" + rel
        home = os.path.expanduser("~")
        if full.startswith(home):
            return "~" + full[len(home):]
        return full
    except Exception:
        return os.path.basename(full_path)


def _extract_cd(command):
    """Extract cd target from a command like 'cd foo', 'cd..', 'cd foo && ls'.
    Returns (cd_target, remaining_command) or (None, command) if no cd."""
    stripped = command.strip()
    # Handle simple 'cd' or 'cd '
    if stripped == 'cd' or stripped == 'cd ':
        return os.path.expanduser("~"), None
    # Handle 'cd..' / 'cd...' / 'cd~' / 'cd/' (no space after cd)
    m_nospace = re.match(r'^cd(\.\.*|~[^\s]*|/[^\s]*)(\s.*)?$', stripped)
    if m_nospace:
        target = m_nospace.group(1)
        rest = (m_nospace.group(2) or '').strip()
        if rest.startswith('&&'):
            rest = rest[2:].strip()
        elif rest.startswith(';'):
            rest = rest[1:].strip()
        elif rest:
            return None, command
        return target, rest if rest else None
    # Match 'cd <path>' possibly followed by && or ; 
    m = re.match(r'^cd\s+("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[^\s;&|]+)\s*(.*)', stripped)
    if m:
        target = m.group(1).strip('"').strip("'")
        rest = m.group(2).strip()
        # Handle chained commands
        if rest.startswith('&&'):
            rest = rest[2:].strip()
        elif rest.startswith(';'):
            rest = rest[1:].strip()
        elif rest:
            # Something unexpected, treat whole thing as command
            return None, command
        return target, rest if rest else None
    return None, command


@router.post("/run")
def run_command(command: str, session: str = "default"):
    """Run a terminal command with persistent cwd tracking per session."""
    # Security: block dangerous commands
    for pattern in BLOCKED_PATTERNS:
        if pattern in command:
            return {"error": "Blocked: dangerous command pattern detected"}

    project_root = str(file_manager.PROJECT_ROOT)

    # Get current cwd for this session
    cwd = _session_cwds.get(session, project_root)
    if not os.path.isdir(cwd):
        cwd = project_root
        _session_cwds[session] = cwd

    output = ""
    exit_code = 0
    remaining = command.strip()

    # Handle shell builtins that need special treatment
    if remaining == 'pwd':
        return {"output": cwd + "\n", "exit_code": 0, "cwd": cwd}
    if remaining.startswith('export '):
        # export commands are session-only; silently accept
        return {"output": "", "exit_code": 0, "cwd": cwd}

    # Process cd commands to track directory changes
    while remaining:
        cd_target, rest = _extract_cd(remaining)
        if cd_target is not None:
            # Resolve the cd target
            if cd_target == '-':
                # cd - is not tracked, just note it
                pass
            elif cd_target.startswith('/'):
                new_cwd = cd_target
            elif cd_target.startswith('~'):
                new_cwd = os.path.expanduser(cd_target)
            else:
                new_cwd = os.path.join(cwd, cd_target)

            new_cwd = os.path.realpath(new_cwd)
            if os.path.isdir(new_cwd):
                cwd = new_cwd
                _session_cwds[session] = cwd
            else:
                output += f"cd: no such file or directory: {cd_target}\n"
                exit_code = 1
                break

            remaining = rest
        else:
            # Not a cd command, run it
            try:
                result = subprocess.run(
                    remaining,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    cwd=cwd,
                    env={**os.environ, "TERM": "xterm-256color"},
                )
                output += result.stdout or ""
                if result.stderr:
                    output += result.stderr
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                output += "Command timed out after 30 seconds\n"
                exit_code = -1
            except Exception as e:
                output += f"Error: {str(e)}\n"
                exit_code = -1
            break

    return {
        "output": output,
        "exit_code": exit_code,
        "cwd": cwd,
    }


@router.get("/info")
def get_terminal_info(session: str = "default"):
    """Return terminal info for prompt rendering."""
    project_root = str(file_manager.PROJECT_ROOT)
    cwd = _session_cwds.get(session, project_root)
    if not os.path.isdir(cwd):
        cwd = project_root
        _session_cwds[session] = cwd

    return {
        "username": _get_username(),
        "hostname": _get_hostname(),
        "cwd": cwd,
        "short_cwd": _get_short_dir(cwd, project_root),
        "project_root": project_root,
    }
