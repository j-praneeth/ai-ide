from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Request
import asyncio
import collections
import json
import subprocess
import os
import platform
import getpass
import re
import shutil
import time
import uuid

router = APIRouter()

# CLI auth is now handled by the desktop app (electron/cli-bundle.js): it
# unpacks a shipped, encrypted credential bundle into ~/.claude and ~/.codex
# at startup. The previous /cli/env endpoint that injected env vars over
# loopback has been removed; the CLIs authenticate themselves from on-disk
# config files, including when run from a shell outside Nebula.

# ── CLI Data Relay (for mobile companion) ─────────────────────────────
_cli_data_history = []
MAX_CLI_HISTORY = 100

@router.post("/cli/data")
async def receive_cli_data(request: Request):
    """Receive PTY data from Electron and relay to mobile."""
    try:
        payload = await request.json()
        data = payload.get("data", "")
        if not data:
            return {"status": "no_data"}

        event = {
            "type": "cli_data",
            "data": data,
            "timestamp": time.time(),
        }

        # Store in history for new mobile connections
        _cli_data_history.append(event)
        if len(_cli_data_history) > MAX_CLI_HISTORY:
            _cli_data_history.pop(0)

        # Broadcast to mobile
        from mobile_bridge import broadcast
        await broadcast(event)
        
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

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

import file_manager


def _get_project_root_dir() -> str:
    """Return the active workspace root, or a safe fallback when no workspace is open."""
    try:
        root = getattr(file_manager, "PROJECT_ROOT", None)
        if root:
            root_str = str(root)
            if os.path.isdir(root_str):
                return root_str
    except Exception:
        pass

    # No workspace open → default terminal sessions to the user's home directory.
    try:
        home = os.path.expanduser("~")
        if os.path.isdir(home):
            return home
    except Exception:
        pass

    return os.getcwd()

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
CLI_SPECS = {
    "claude": {
        "label": "Claude CLI",
        "command": "claude",
        "package_name": "@anthropic-ai/claude-code",
    },
    "codex": {
        "label": "Codex CLI",
        "command": "codex",
        "package_name": "@openai/codex",
    },
}


def _quote_for_powershell(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _quote_for_bash(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


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
    npm_bin = _get_npm_global_bin_dir()
    if npm_bin:
        path_key = next((k for k in env.keys() if k.lower() == "path"), "PATH")
        current = env.get(path_key, "")
        parts = [p for p in current.split(os.pathsep) if p]
        if npm_bin not in parts:
            env[path_key] = os.pathsep.join([npm_bin, *parts])
    return env


def _get_npm_global_bin_dir():
    """Return the npm global bin dir if npm is available."""
    npm_cmd = "npm.cmd" if IS_WINDOWS else "npm"
    try:
        result = subprocess.run(
            [npm_cmd, "config", "get", "prefix"],
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ},
            shell=False,
        )
        prefix = (result.stdout or "").strip()
        if not prefix:
            return None
        return prefix if IS_WINDOWS else os.path.join(prefix, "bin")
    except Exception:
        return None


def _find_git_bash():
    """Best-effort lookup for Git Bash on Windows."""
    if not IS_WINDOWS:
        return None

    candidates = [
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "bin", "bash.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "usr", "bin", "bash.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Git", "bin", "bash.exe"),
        shutil.which("bash"),
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def _get_cli_status(tool: str):
    spec = CLI_SPECS.get(tool, CLI_SPECS["claude"])
    env = _build_env()
    command_path = shutil.which(spec["command"], path=env.get(next((k for k in env.keys() if k.lower() == "path"), "PATH")))
    installed = command_path is not None

    preferred_shell = _get_shell_name()
    shell_path = None
    notes = []

    if IS_WINDOWS and tool == "claude":
        bash_path = _find_git_bash()
        if bash_path:
            preferred_shell = "git-bash"
            shell_path = bash_path
        else:
            preferred_shell = "powershell"
            notes.append("Claude Code on Windows works best with Git Bash or WSL.")
    elif IS_WINDOWS:
        preferred_shell = "powershell"
    else:
        shell_path = os.environ.get("SHELL", "/bin/bash")

    if not installed:
        notes.append(f"{spec['label']} was not found on PATH.")
        notes.append(f"Install command: npm install -g {spec['package_name']}")

    return {
        "tool": tool,
        "label": spec["label"],
        "command": spec["command"],
        "package_name": spec["package_name"],
        "installed": installed,
        "command_path": command_path,
        "preferred_shell": preferred_shell,
        "shell_path": shell_path,
        "notes": notes,
    }


def _build_cli_shell_command(tool: str, status: dict):
    """Build a shell command that launches the actual CLI and keeps the shell open."""
    spec = CLI_SPECS.get(tool, CLI_SPECS["claude"])
    command_path = status.get("command_path") or spec["command"]

    if IS_WINDOWS:
        if tool == "claude" and status.get("shell_path"):
            cli_cmd = _quote_for_bash(command_path)
            return [status["shell_path"], "--login", "-i", "-c", f"{cli_cmd}; exec bash -i"]

        cli_cmd = f"& {_quote_for_powershell(command_path)}"
        return ["powershell.exe", "-NoExit", "-NoProfile", "-Command", cli_cmd]

    shell_path = os.environ.get("SHELL", "/bin/zsh")
    cli_cmd = _quote_for_bash(command_path)
    cwd = _get_project_root_dir()
    # -l = login shell: loads ~/.zprofile / ~/.bash_profile so PATH includes
    # npm global bin, nvm shims, etc. — critical for Claude CLI to find itself.
    # exec replaces the shell process so signals reach Claude directly.
    return [shell_path, "-l", "-c",
            f"cd {_quote_for_bash(cwd)} && exec {cli_cmd}"]


@router.get("/cli/status")
def cli_status(tool: str = "claude"):
    """Return install/shell status for the requested CLI tool."""
    return _get_cli_status(tool)


@router.post("/run")
def run_command(command: str, session: str = "default", shell: str = None):
    """Run a terminal command with persistent cwd tracking per session."""
    project_root = _get_project_root_dir()

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
                    if shell == 'cmd':
                        result = subprocess.run(
                            ["cmd.exe", "/c", remaining],
                            capture_output=True,
                            text=True,
                            timeout=30,
                            cwd=cwd,
                            env=_build_env(),
                        )
                    else:
                        # Default to PowerShell on Windows for better compatibility
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
    project_root = _get_project_root_dir()
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

# ── Claude session persistence ─────────────────────────────────────────
# Each entry keeps the subprocess alive across WebSocket disconnects.
# Reconnecting clients receive the scrollback then join the live stream.

_SCROLLBACK_MAX = 500        # max chunks kept per session
_SESSION_IDLE_TIMEOUT = 1800 # seconds before an idle session is reaped
_janitor_started = False


_MAX_RESPAWNS = 5


class _ClaudeSession:
    def __init__(self, process: subprocess.Popen, tool: str, cwd: str):
        self.process = process
        self.scrollback: collections.deque = collections.deque(maxlen=_SCROLLBACK_MAX)
        self.waiters: list[asyncio.Queue] = []
        self.tool = tool
        self.cwd = cwd
        self.created_at = time.time()
        self.last_active = time.time()
        self.reader_task: asyncio.Task | None = None
        self.explicitly_terminated = False

    def _broadcast(self, text: str) -> None:
        self.scrollback.append(text)
        for q in list(self.waiters):
            try:
                q.put_nowait(text)
            except asyncio.QueueFull:
                pass

    async def run_reader(self) -> None:
        """Single background reader with auto-respawn on crash.

        Stays alive across process restarts so connected WebSockets never drop.
        A clean exit (code 0, e.g. user typed /exit) notifies subscribers and
        stops the loop.  A crash (non-zero exit) respawns with exponential
        backoff up to _MAX_RESPAWNS times.
        """
        respawn_count = 0

        while True:
            # ── read stdout until the process exits ──────────────────
            try:
                while True:
                    data = await asyncio.to_thread(self.process.stdout.read, 1024)
                    if not data:
                        break
                    text = data.decode("utf-8", errors="replace")
                    self._broadcast(text)
                    self.last_active = time.time()
            except Exception:
                pass

            exit_code = self.process.poll()

            # Explicit kill or clean exit (/exit command) → stop loop
            if self.explicitly_terminated or exit_code == 0:
                break

            # Crash or unexpected exit → try to respawn
            if respawn_count >= _MAX_RESPAWNS:
                self._broadcast(
                    f"\r\n\x1b[31m  [Claude crashed {_MAX_RESPAWNS} times — "
                    f"giving up. Reload the panel to try again.]\x1b[0m\r\n"
                )
                break

            respawn_count += 1
            delay = min(2 ** respawn_count, 30)
            self._broadcast(
                f"\r\n\x1b[33m  [Claude exited (code {exit_code}) — "
                f"restarting in {delay}s ({respawn_count}/{_MAX_RESPAWNS})]\x1b[0m\r\n"
            )
            await asyncio.sleep(delay)

            if self.explicitly_terminated:
                break

            try:
                status = _get_cli_status(self.tool)
                env = _build_env()
                cmd = _build_cli_shell_command(self.tool, status)
                self.process = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    shell=False,
                    bufsize=0,
                    env=env,
                    cwd=self.cwd,
                )
                self._broadcast("\r\n\x1b[32m  [Claude restarted]\x1b[0m\r\n")
            except Exception as exc:
                self._broadcast(
                    f"\r\n\x1b[31m  [Respawn failed: {exc}]\x1b[0m\r\n"
                )
                break

        # Signal EOF to all waiting WebSocket pumps
        for q in list(self.waiters):
            try:
                q.put_nowait(None)
            except Exception:
                pass


_claude_sessions: dict[str, _ClaudeSession] = {}


def _ensure_janitor() -> None:
    global _janitor_started
    if _janitor_started:
        return
    _janitor_started = True
    asyncio.create_task(_session_janitor())


async def _session_janitor() -> None:
    while True:
        await asyncio.sleep(60)
        now = time.time()
        dead = [
            sid for sid, s in list(_claude_sessions.items())
            if s.process.poll() is not None
            or (now - s.last_active) > _SESSION_IDLE_TIMEOUT
        ]
        for sid in dead:
            s = _claude_sessions.pop(sid, None)
            if s and s.process.poll() is None:
                try:
                    s.process.terminate()
                except Exception:
                    pass


@router.get("/cli/sessions")
def list_cli_sessions():
    """List all active persistent Claude sessions."""
    return [
        {
            "session_id": sid,
            "tool": s.tool,
            "cwd": s.cwd,
            "created_at": s.created_at,
            "last_active": s.last_active,
            "alive": s.process.poll() is None,
        }
        for sid, s in _claude_sessions.items()
    ]


@router.websocket("/ws/cli")
async def cli_websocket(websocket: WebSocket, tool: str = "claude", session_id: str = None):
    await websocket.accept()

    # ── Reattach to an existing session or spawn a new one ─────────
    session: _ClaudeSession | None = None
    is_new = True

    if session_id and session_id in _claude_sessions:
        s = _claude_sessions[session_id]
        if s.process.poll() is None:
            session = s
            is_new = False
        else:
            _claude_sessions.pop(session_id, None)

    if is_new:
        status = _get_cli_status(tool)
        if not status["installed"]:
            await websocket.send_text(
                f"\r\n{status['label']} is not installed.\r\n"
                f"Run: npm install -g {status['package_name']}\r\n\r\n"
            )
            for note in status["notes"]:
                await websocket.send_text(f"{note}\r\n")
            await websocket.close()
            return

        env = _build_env()
        cwd = _get_project_root_dir()
        cmd = _build_cli_shell_command(tool, status)

        try:
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                shell=False,
                bufsize=0,
                env=env,
                cwd=cwd,
            )
        except Exception as e:
            await websocket.send_text(f"Failed to start terminal shell: {e}\r\n")
            await websocket.close()
            return

        session_id = uuid.uuid4().hex[:12]
        session = _ClaudeSession(process, tool, cwd)
        _claude_sessions[session_id] = session
        session.reader_task = asyncio.create_task(session.run_reader())
        _ensure_janitor()

    # ── Handshake: send session_id so the client can persist it ────
    await websocket.send_text(json.dumps({"type": "session_id", "session_id": session_id}))

    # ── Replay scrollback for reconnecting clients ──────────────────
    for chunk in list(session.scrollback):
        try:
            await websocket.send_text(chunk)
        except Exception:
            await websocket.close()
            return

    # ── Subscribe to live output via a per-connection queue ─────────
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    session.waiters.append(q)

    async def pump_to_ws() -> None:
        while True:
            try:
                chunk = await q.get()
            except Exception:
                break
            if chunk is None:   # process exited
                try:
                    await websocket.close()
                except Exception:
                    pass
                break
            try:
                await websocket.send_text(chunk)
            except Exception:
                break

    pump_task = asyncio.create_task(pump_to_ws())

    try:
        while True:
            data = await websocket.receive_text()
            # Check if reader decided the process is permanently gone
            if session.process.poll() is not None and not session.waiters:
                _claude_sessions.pop(session_id, None)
                break
            session.last_active = time.time()
            if session.process.stdin:
                try:
                    session.process.stdin.write(data.encode("utf-8"))
                    session.process.stdin.flush()
                except Exception:
                    break
    except WebSocketDisconnect:
        pass  # Keep the process alive — client will reconnect
    finally:
        try:
            session.waiters.remove(q)
        except ValueError:
            pass
        pump_task.cancel()
