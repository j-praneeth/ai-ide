"""Module to store pending commands awaiting user approval."""
import time
from typing import Dict, Any

# Store pending commands: {command_id: {tool, tool_input, command, timestamp}}
_pending_commands: Dict[str, Dict[str, Any]] = {}


def store_pending_command(command_id: str, tool: str, tool_input: Dict[str, Any], command: str):
    """Store a pending command awaiting approval."""
    _pending_commands[command_id] = {
        "tool": tool,
        "tool_input": tool_input,
        "command": command,
        "timestamp": time.time(),
    }


def get_pending_command(command_id: str) -> Dict[str, Any]:
    """Get a pending command by ID."""
    return _pending_commands.get(command_id)


def remove_pending_command(command_id: str):
    """Remove a pending command (after approval/rejection)."""
    _pending_commands.pop(command_id, None)


def cleanup_old_commands(max_age_seconds: int = 3600):
    """Remove commands older than max_age_seconds."""
    current_time = time.time()
    to_remove = [
        cmd_id for cmd_id, cmd_data in _pending_commands.items()
        if current_time - cmd_data["timestamp"] > max_age_seconds
    ]
    for cmd_id in to_remove:
        remove_pending_command(cmd_id)
