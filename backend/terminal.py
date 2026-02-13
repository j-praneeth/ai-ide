from fastapi import APIRouter
import subprocess
import os
import platform
import getpass
import re

router = APIRouter()

# ── Mobile bridge event emission ──────────────────────────────────────
def _emit_terminal_event(command: str, output: str, exit_code: int, cwd: str):
    """Emit terminal activity to connected mobile clients."""
    try:
        from mobile_bridge import emit_sync
        emit_sync({
            "type": "terminal_output",
            "source": "desktop",
            "command": command,
            "output": output[:500],  # Truncate for mobile
            "exit_code": exit_code,
            "cwd": cwd,
        })
    except Exception:
        pass  # Don't break terminal if mobile bridge is unavailable

# Use the actual project root (parent of backend/)
import file_manager

# Detect platform
IS_WINDOWS = platform.system() == "Windows"

# Per-session cwd tracking (key = session id string, value = cwd path string)
_session_cwds: dict = {}

# Blocked dangerous commands (cross-platform)
BLOCKED_PATTERNS_UNIX = [
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

BLOCKED_PATTERNS_WINDOWS = [
    "format c:",
    "format d:",
    "del /s /q c:\\",
    "rd /s /q c:\\",
    "shutdown",
    "restart",
    "rmdir /s /q c:\\",
]

BLOCKED_PATTERNS = BLOCKED_PATTERNS_WINDOWS if IS_WINDOWS else BLOCKED_PATTERNS_UNIX


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


def _get_prompt_char():
    """Get the prompt character based on platform."""
    if IS_WINDOWS:
        return ">"
    return "%"


def _get_shell_name():
    """Get the default shell name for display."""
    if IS_WINDOWS:
        return "powershell"
    # Try to detect the shell
    shell = os.environ.get("SHELL", "/bin/zsh")
    return os.path.basename(shell)


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

    # Windows-style drive navigation: 'cd C:\path' or 'cd D:\'
    if IS_WINDOWS:
        m_win = re.match(r'^cd\s+([A-Za-z]:\\[^\s;&|]*)\s*(.*)', stripped)
        if m_win:
            target = m_win.group(1)
            rest = m_win.group(2).strip()
            if rest.startswith('&&'):
                rest = rest[2:].strip()
            elif rest.startswith('&'):
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
        elif IS_WINDOWS and rest.startswith('&'):
            rest = rest[1:].strip()
        elif rest:
            # Something unexpected, treat whole thing as command
            return None, command
        return target, rest if rest else None
    return None, command


def _build_env():
    """Build environment variables for subprocess, platform-aware."""
    env = {**os.environ}
    if not IS_WINDOWS:
        env["TERM"] = "xterm-256color"
    return env


@router.post("/run")
def run_command(command: str, session: str = "default"):
    """Run a terminal command with persistent cwd tracking per session."""
    # Security: block dangerous commands
    cmd_lower = command.lower()
    for pattern in BLOCKED_PATTERNS:
        if pattern.lower() in cmd_lower:
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
    if remaining == 'pwd' or (IS_WINDOWS and remaining.lower() == 'cd'):
        return {"output": cwd + "\n", "exit_code": 0, "cwd": cwd}
    if remaining.startswith('export '):
        # export commands are session-only; silently accept
        return {"output": "", "exit_code": 0, "cwd": cwd}
    # Windows: handle 'set' for environment variables
    if IS_WINDOWS and remaining.lower().startswith('set '):
        return {"output": "", "exit_code": 0, "cwd": cwd}

    # Handle 'clear' / 'cls' commands
    if remaining in ('clear', 'cls'):
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
            elif IS_WINDOWS and len(cd_target) >= 2 and cd_target[1] == ':':
                # Windows absolute path like C:\Users
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
                if IS_WINDOWS:
                    # Use PowerShell on Windows for better compatibility
                    result = subprocess.run(
                        ["powershell", "-NoProfile", "-Command", remaining],
                        capture_output=True,
                        text=True,
                        timeout=30,
                        cwd=cwd,
                        env=_build_env(),
                    )
                else:
                    result = subprocess.run(
                        remaining,
                        shell=True,
                        capture_output=True,
                        text=True,
                        timeout=30,
                        cwd=cwd,
                        env=_build_env(),
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

    # Emit to mobile companion
    _emit_terminal_event(command.strip(), output, exit_code, cwd)

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
        "shell": _get_shell_name(),
        "prompt_char": _get_prompt_char(),
        "platform": platform.system().lower(),
    }
