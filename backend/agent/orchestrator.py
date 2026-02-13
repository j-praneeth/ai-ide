import logging
import json
import re
from .planner import plan, extract_json, _fix_json_newlines
from .executor import execute

logger = logging.getLogger(__name__)

MAX_STEPS = 12

# Known tool names for recovery
KNOWN_TOOLS = {
    "read_file", "write_file", "edit_file", "delete_file",
    "file_search", "list_dir", "grep_search", "codebase_search", "run_command",
}

# Patterns that indicate the model is being conversational instead of using tools
CONVERSATIONAL_PATTERNS = [
    r"(?i)^(here are|here is|i will|i'll|let me|let's|i plan to|i would|i can)",
    r"(?i)(steps i|steps to|here's what|i'll need to|i should|my plan)",
    r"(?i)(first,?\s+i|second,?\s+i|third,?\s+i|next,?\s+i)",
    r"(?i)^(based on|to address|to fix|to resolve|to handle|to implement)",
    r"(?i)(```bash|```shell|```sh)\s*\n",  # Shell commands in text
    r"(?i)(i'll use the|i will use|let me use|i need to use)",
    r"(?i)(await your|your confirmation|do you want|shall i|should i)",
]


def _is_conversational(text):
    """Check if text looks like a conversational response instead of an action."""
    if not text or len(text) < 30:
        return False
    for pattern in CONVERSATIONAL_PATTERNS:
        if re.search(pattern, text):
            return True
    return False


def _ensure_decision(decision):
    """Ensure we have a valid decision dict with action and optional input."""
    if not isinstance(decision, dict):
        return {"action": "final", "answer": f"Invalid response type: {type(decision).__name__}"}
    action = decision.get("action")
    if not action or not isinstance(action, str):
        if "tool" in decision:
            decision["action"] = decision.pop("tool")
        elif "name" in decision:
            decision["action"] = decision.pop("name")
        else:
            return {"action": "final", "answer": "Missing or invalid 'action' in response."}
    return decision


def _try_recover_tool_call(text):
    """Try to extract a tool call from text that was incorrectly returned as a final answer."""
    if not text or '{' not in text:
        return None
    try:
        cleaned = extract_json(text)
        try:
            obj = json.loads(cleaned)
        except Exception:
            try:
                obj = json.loads(_fix_json_newlines(cleaned))
            except Exception:
                return None
        if isinstance(obj, dict) and obj.get("action") in KNOWN_TOOLS:
            logger.info("Recovered tool call from final answer: %s", obj.get("action"))
            return obj
    except Exception:
        pass
    return None


def _needs_tool_retry(answer, step, tools_called):
    """Check if we should force the model to use tools instead of giving this answer."""
    if not answer:
        return True
    # If no tools were called yet and it's early, always retry
    if step <= 2 and not tools_called:
        # Check if it's conversational (describing what it will do)
        if _is_conversational(answer):
            return True
        # Very short answers without tool usage are suspicious
        if len(answer) < 100:
            return True
    return False


_FORCE_TOOL_NUDGE = (
    "[System] WRONG. You gave a text response instead of a JSON tool call. "
    "You MUST output ONLY a JSON object like {\"action\": \"grep_search\", \"input\": {\"query\": \"search term\"}}. "
    "DO NOT explain. DO NOT describe steps. DO NOT ask permission. "
    "Call grep_search or file_search NOW to find the relevant file, then read_file to read it, then edit_file to fix it. "
    "Output ONLY the JSON tool call."
)


def run_agent(user_prompt, conversation_history=None):
    context_parts = []
    tools_called = []

    for step in range(1, MAX_STEPS + 1):
        logger.info("Agent step %d/%d", step, MAX_STEPS)
        context = "\n".join(context_parts) if context_parts else ""

        try:
            decision = plan(user_prompt, context, conversation_history=conversation_history)
        except Exception as e:
            logger.exception("Planner failed at step %d: %s", step, e)
            return f"Agent error: planning failed ({e}). Please try again."

        decision = _ensure_decision(decision)
        action = decision.get("action", "")

        # Handle "final" responses
        if action == "final":
            answer = decision.get("answer", "")

            # Recovery: check if the "answer" is actually a tool call JSON
            recovered = _try_recover_tool_call(answer)
            if recovered:
                decision = recovered
                action = decision["action"]
                # Fall through to tool execution below
            else:
                # Force tool usage if the model is being conversational or gave no real answer
                if _needs_tool_retry(answer, step, tools_called):
                    logger.warning("Step %d: Model gave text response without tools. Forcing retry.", step)
                    context_parts.append(_FORCE_TOOL_NUDGE)
                    continue

                logger.info("Agent finished at step %d with final answer (tools used: %s)", step, tools_called)
                return answer if answer else "I completed the task. Let me know if you need anything else."

        # It's a tool call (either original or recovered)
        tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}

        logger.info("Agent calling tool: %s with input: %s", action, str(tool_input)[:200])

        try:
            result = execute(action, tool_input)
        except Exception as e:
            logger.exception("Executor failed for action %s: %s", action, e)
            result = f"Tool error: {e}"

        tools_called.append(action)

        if isinstance(result, dict):
            result_str = json.dumps(result, default=str)
        else:
            result_str = str(result)

        max_result_len = 6000
        if len(result_str) > max_result_len:
            result_str = result_str[:max_result_len] + "\n... (truncated)"

        context_parts.append(f"[Step {step}] Tool: {action}\nInput: {json.dumps(tool_input, default=str)}\nResult:\n{result_str}")

    logger.warning("Agent stopped after max steps (%d). Tools called: %s", MAX_STEPS, tools_called)
    return "Agent stopped after maximum steps. Try asking something more specific or in smaller steps."


def run_agent_stream(user_prompt, conversation_history=None):
    """Generator version of run_agent that yields step events for SSE streaming."""
    context_parts = []
    tools_called = []

    yield {"type": "thinking", "text": "Analyzing the request..."}

    for step in range(1, MAX_STEPS + 1):
        context = "\n".join(context_parts) if context_parts else ""

        if step > 1:
            yield {"type": "thinking", "text": "Determining next action..."}

        try:
            decision = plan(user_prompt, context, conversation_history=conversation_history)
        except Exception as e:
            yield {"type": "error", "message": f"Planning failed: {e}"}
            yield {"type": "done", "answer": f"Agent error: {e}"}
            return

        decision = _ensure_decision(decision)
        action = decision.get("action", "")

        if action == "final":
            answer = decision.get("answer", "")

            # Recovery: check if the "answer" is actually a tool call JSON
            recovered = _try_recover_tool_call(answer)
            if recovered:
                decision = recovered
                action = decision["action"]
                # Fall through to tool execution below
            else:
                # Force tool usage if the model is being conversational or gave no real answer
                if _needs_tool_retry(answer, step, tools_called):
                    logger.warning("Step %d: Model gave text instead of tool call. Forcing retry.", step)
                    context_parts.append(_FORCE_TOOL_NUDGE)
                    yield {"type": "thinking", "text": "Switching to direct action..."}
                    continue

                final_text = answer if answer else "I completed the task. Let me know if you need anything else."
                yield {"type": "done", "answer": final_text}
                return

        # It's a tool call
        tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}

        # Generate human-readable step description
        step_desc = _describe_tool_call(action, tool_input)
        yield {"type": "step", "message": step_desc, "tool": action}

        try:
            result = execute(action, tool_input)
        except Exception as e:
            result = f"Tool error: {e}"

        tools_called.append(action)

        if isinstance(result, dict):
            result_str = json.dumps(result, default=str)
        else:
            result_str = str(result)

        # Show result (more detail for Cursor-style display)
        brief = result_str[:800] + "\n..." if len(result_str) > 800 else result_str
        yield {"type": "tool_result", "tool": action, "result": brief}

        max_result_len = 6000
        if len(result_str) > max_result_len:
            result_str = result_str[:max_result_len] + "\n... (truncated)"

        context_parts.append(f"[Step {step}] Tool: {action}\nInput: {json.dumps(tool_input, default=str)}\nResult:\n{result_str}")

    yield {"type": "done", "answer": "Agent stopped after maximum steps."}


def _describe_tool_call(action, input_data):
    """Generate a human-readable description of a tool call."""
    path = input_data.get("path", "")
    query = input_data.get("query", "")
    command = input_data.get("command", "")

    descriptions = {
        "read_file": f"Reading `{path}`...",
        "write_file": f"Writing to `{path}`...",
        "edit_file": f"Editing `{path}`...",
        "delete_file": f"Deleting `{path}`...",
        "file_search": f"Searching for files matching `{query}`...",
        "list_dir": f"Listing directory `{path or '.'}`...",
        "grep_search": f"Searching for `{query}` in files...",
        "codebase_search": f"Searching codebase for `{query}`...",
        "run_command": f"Running command: `{command[:60]}`...",
    }
    return descriptions.get(action, f"Calling {action}...")
