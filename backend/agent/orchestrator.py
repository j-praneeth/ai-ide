import logging
import json
from .planner import plan, extract_json, _fix_json_newlines
from .executor import execute

logger = logging.getLogger(__name__)

MAX_STEPS = 10

# Known tool names for recovery
KNOWN_TOOLS = {
    "read_file", "write_file", "edit_file", "delete_file",
    "file_search", "list_dir", "grep_search", "codebase_search", "run_command",
}

# Keywords that suggest the user wants an ACTION performed, not just an answer
ACTION_KEYWORDS = [
    "create", "add", "write", "edit", "modify", "change", "update", "delete",
    "remove", "fix", "rename", "move", "insert", "append", "prepend", "replace",
    "refactor", "install", "run", "execute", "build", "make",
]

# Keywords that suggest the user wants INFORMATION / EXPLANATION
INFO_KEYWORDS = [
    "explain", "how does", "what is", "what are", "describe", "show me",
    "architecture", "diagram", "overview", "summarize", "summary", "analyze",
    "analysis", "compare", "difference", "why does", "how to", "tell me",
    "list the", "what happens", "walk me through", "help me understand",
    "documentation", "high level", "low level", "design pattern",
]


def _user_wants_action(prompt):
    """Check if the user's prompt implies they want the agent to DO something (not just explain)."""
    lower = prompt.lower()
    # If it looks like an informational query, don't treat it as an action
    if _user_wants_info(lower):
        return False
    return any(kw in lower for kw in ACTION_KEYWORDS)


def _user_wants_info(prompt):
    """Check if the user's prompt is asking for information/explanation."""
    lower = prompt.lower() if not isinstance(prompt, str) or prompt == prompt.lower() else prompt.lower()
    return any(kw in lower for kw in INFO_KEYWORDS)


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
                # Safety check: if user wanted an action but no tools were called,
                # nudge the LLM to actually do something
                if step == 1 and not tools_called and _user_wants_action(user_prompt):
                    logger.warning("LLM gave final answer on step 1 without calling any tools. Retrying with nudge.")
                    context_parts.append(
                        "[System] You responded with a final answer without performing any action. "
                        "The user asked you to DO something. You MUST use tools (read_file, write_file, edit_file, etc.) "
                        "to perform the requested action. Do NOT just describe what to do — actually do it. "
                        "Look at the file tree and find the file, then make the change."
                    )
                    continue

                # Safety check: if user wanted INFO but got a very short answer without exploring
                if step <= 2 and not tools_called and _user_wants_info(user_prompt) and len(answer) < 200:
                    logger.warning("LLM gave short answer for info query without exploring codebase. Nudging.")
                    context_parts.append(
                        "[System] You gave a very short answer without exploring the codebase first. "
                        "The user is asking for detailed information. You MUST first use tools to explore: "
                        "use list_dir to see the project structure, read_file to read key files, "
                        "grep_search to find relevant code. Then provide a COMPREHENSIVE, DETAILED answer "
                        "with markdown formatting (headers, bullet points, code blocks, diagrams). "
                        "Your answer should be at least several paragraphs long. NEVER give a one-line answer."
                    )
                    continue

                logger.info("Agent finished at step %d with final answer (tools used: %s)", step, tools_called)
                return answer if answer else "I completed the analysis. Let me know if you need more details."

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

        # Normalize result to string for context
        if isinstance(result, dict):
            result_str = json.dumps(result, default=str)
        else:
            result_str = str(result)

        # Truncate very long results in context to avoid token overflow
        max_result_len = 4000
        if len(result_str) > max_result_len:
            result_str = result_str[:max_result_len] + "\n... (truncated)"

        context_parts.append(f"[Step {step}] Tool: {action}\nInput: {json.dumps(tool_input, default=str)}\nResult:\n{result_str}")

    logger.warning("Agent stopped after max steps (%d). Tools called: %s", MAX_STEPS, tools_called)
    return "Agent stopped after maximum steps. Try asking something more specific or in smaller steps."


def run_agent_stream(user_prompt, conversation_history=None):
    """Generator version of run_agent that yields step events for SSE streaming."""
    context_parts = []
    tools_called = []

    yield {"type": "thinking", "text": f"Understanding the request and analyzing the codebase to determine the best approach..."}

    for step in range(1, MAX_STEPS + 1):
        context = "\n".join(context_parts) if context_parts else ""

        # Yield thinking about what to do next
        if step > 1:
            yield {"type": "thinking", "text": f"Analyzing results from previous step and determining next action..."}

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
                yield {"type": "thinking", "text": "Recovered tool call from response, executing the action..."}
                # Fall through to tool execution below
            else:
                # Safety check: user wanted action but no tools called
                if step == 1 and not tools_called and _user_wants_action(user_prompt):
                    context_parts.append(
                        "[System] You responded without performing any action. "
                        "The user asked you to DO something. Use tools to perform the action. "
                        "Start by using read_file to read the relevant file, then use edit_file to make changes."
                    )
                    yield {"type": "thinking", "text": "Need to use tools to perform the requested action. Re-planning..."}
                    continue

                # Safety check: info query with short answer and no exploration
                if step <= 2 and not tools_called and _user_wants_info(user_prompt) and len(answer) < 200:
                    context_parts.append(
                        "[System] You gave a very short answer without exploring the codebase first. "
                        "The user is asking for detailed information. You MUST first use tools to explore: "
                        "use list_dir to see the project structure, read_file to read key files, "
                        "grep_search to find relevant code. Then provide a COMPREHENSIVE, DETAILED answer "
                        "with markdown formatting (headers, bullet points, code blocks, diagrams). "
                        "Your answer should be at least several paragraphs long. NEVER give a one-line answer."
                    )
                    yield {"type": "thinking", "text": "Need to explore the codebase first to give a thorough answer..."}
                    continue

                final_text = answer if answer else "I completed the analysis. Let me know if you need more details."
                yield {"type": "done", "answer": final_text}
                return

        # It's a tool call (either original or recovered)
        tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}

        # Yield thinking about why we're calling this tool
        thinking_text = _describe_thinking(action, tool_input, step)
        yield {"type": "thinking", "text": thinking_text}

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

        # Show brief result
        brief = result_str[:150] + "..." if len(result_str) > 150 else result_str
        yield {"type": "tool_result", "tool": action, "result": brief}

        max_result_len = 4000
        if len(result_str) > max_result_len:
            result_str = result_str[:max_result_len] + "\n... (truncated)"

        context_parts.append(f"[Step {step}] Tool: {action}\nInput: {json.dumps(tool_input, default=str)}\nResult:\n{result_str}")

    yield {"type": "done", "answer": "Agent stopped after maximum steps."}


def _describe_thinking(action, input_data, step):
    """Generate thinking text that describes the agent's reasoning."""
    path = input_data.get("path", "")
    query = input_data.get("query", "")
    instructions = input_data.get("instructions", "")
    command = input_data.get("command", "")

    if action == "read_file":
        return f"I need to read the file `{path}` to understand its current contents before making any changes."
    elif action == "edit_file":
        old_content = input_data.get("old_content", "")
        new_content = input_data.get("new_content", "")
        if old_content and new_content is not None:
            if not new_content:
                return f"Now I'll remove the specified text from `{path}` using a precise find-and-replace."
            else:
                return f"Now I'll edit `{path}` by replacing the matching text with the updated version."
        reason = instructions if instructions else "apply the requested changes"
        return f"Now I'll edit `{path}` to {reason}."
    elif action == "write_file":
        return f"I'll write the content to `{path}`. This will create or overwrite the file with the new content."
    elif action == "delete_file":
        return f"Deleting the file `{path}` as requested."
    elif action == "grep_search":
        return f"Searching the codebase for `{query}` to find relevant code locations."
    elif action == "file_search":
        return f"Looking for files matching `{query}` in the project to locate the right file."
    elif action == "codebase_search":
        return f"Performing a semantic search for `{query}` to find the most relevant code."
    elif action == "list_dir":
        return f"Listing the contents of `{path or '.'}` to understand the project structure."
    elif action == "run_command":
        return f"Running the command `{command[:80]}` to execute the requested operation."
    else:
        return f"Calling tool `{action}` with the provided parameters."


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
