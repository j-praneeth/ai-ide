import logging
import json
import re
from .planner import plan, extract_json, _fix_json_newlines
from .executor import execute

logger = logging.getLogger(__name__)

# Agent runs until task is complete (final answer). Upper bound to prevent infinite loops.
MAX_STEPS = 500

# Known tool names for recovery
KNOWN_TOOLS = {
    "read_file", "write_file", "edit_file", "delete_file",
    "file_search", "list_dir", "grep_search", "codebase_search", "run_command",
}

# Read-only tools (allowed in Chat mode)
READ_ONLY_TOOLS = {
    "read_file", "file_search", "list_dir", "grep_search", "codebase_search",
}

# Write tools (only allowed in Agent mode)
WRITE_TOOLS = {
    "write_file", "edit_file", "delete_file", "run_command",
}

# Patterns that indicate the model is being conversational instead of using tools
CONVERSATIONAL_PATTERNS = [
    r"(?i)^(here are|here is|i will|i'll|let me|let's|i plan to|i would|i can|we will|we'll)",
    r"(?i)(steps i|steps to|here's what|i'll need to|i should|my plan|let's create|let's start|let's make|let's build)",
    r"(?i)(first,?\s+i|second,?\s+i|third,?\s+i|next,?\s+i|finally,?\s+i)",
    r"(?i)^(based on|to address|to fix|to resolve|to handle|to implement|to create)",
    r"(?i)(```bash|```shell|```sh|```js|```jsx|```ts|```tsx|```css|```html|```json|```python|```py)\s*\n",  # Any code blocks
    r"(?i)(i'll use the|i will use|let me use|i need to use|i'll create|i will create)",
    r"(?i)(await your|your confirmation|do you want|shall i|should i|would you like)",
    r"(?i)(to fix.*i will|to fix.*i'll|to fix.*let me|to fix.*let's|to create.*i will|to create.*i'll)",
    r"(?i)(follow these steps|i will follow|let's start by|we'll start|we will start)",
    r"(?i)(reading the|editing the|modifying the|creating the).*(file|code|css|component|app|website)",
    r"(?i)(cat |nano |vim |open |mkdir |cd |npm |npx ).*\.(css|js|py|tsx|jsx|json|html)",  # Shell commands for files
    r"(?i)^\s*\d+\.\s+[A-Z]",  # Numbered lists starting with capital letter
]


def _is_conversational(text):
    """Check if text looks like a conversational response instead of an action."""
    if not text or len(text) < 30:
        return False
    
    # Check for markdown code blocks (```language)
    if re.search(r'```\s*\w+', text):
        return True
    
    # Check for conversational patterns
    for pattern in CONVERSATIONAL_PATTERNS:
        if re.search(pattern, text):
            return True
    
    # Check for step-by-step patterns
    if re.search(r'(?i)(step\s+\d+|step\s+1|step\s+2|step\s+3|first|second|third|next|then|finally)', text):
        return True
    
    # Check for "Understood" or "I will follow" patterns
    if re.search(r'(?i)^(understood|i will follow|i\'ll follow|let me|let\'s|based on|to address)', text):
        return True
    
    # Check for numbered lists at the start
    if re.search(r'(?i)^\s*\d+\.\s+[A-Z]', text[:500]):
        return True
    
    # Check if text before first JSON brace is too long (likely conversational intro)
    first_brace = text.find('{')
    if first_brace > 0 and first_brace > 50:
        # Check if there's significant non-whitespace text before the brace
        pre_brace = text[:first_brace].strip()
        if len(pre_brace) > 30 and not pre_brace.startswith('{'):
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
    
    # First, try to find JSON objects in the text (might be multiple)
    json_objects = []
    start = 0
    while True:
        start = text.find('{', start)
        if start == -1:
            break
        
        # Try to extract complete JSON object
        depth = 0
        end = start
        for i in range(start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        
        if end > start:
            json_str = text[start:end]
            json_objects.append((start, end, json_str))
            start = end
        else:
            start += 1
    
    # Try to parse each JSON object found
    for start_pos, end_pos, json_str in json_objects:
        try:
            # Try direct parse
            obj = json.loads(json_str)
            if isinstance(obj, dict) and obj.get("action") in KNOWN_TOOLS:
                logger.info("Recovered tool call from final answer: %s", obj.get("action"))
                return obj
        except Exception:
            try:
                # Try with fixed newlines
                fixed = _fix_json_newlines(json_str)
                obj = json.loads(fixed)
                if isinstance(obj, dict) and obj.get("action") in KNOWN_TOOLS:
                    logger.info("Recovered tool call from final answer (fixed): %s", obj.get("action"))
                    return obj
            except Exception:
                continue
    
    # If no complete JSON found, try the original extraction method
    try:
        cleaned = extract_json(text)
        try:
            obj = json.loads(cleaned)
            if isinstance(obj, dict) and obj.get("action") in KNOWN_TOOLS:
                logger.info("Recovered tool call from final answer (extracted): %s", obj.get("action"))
                return obj
        except Exception:
            try:
                obj = json.loads(_fix_json_newlines(cleaned))
                if isinstance(obj, dict) and obj.get("action") in KNOWN_TOOLS:
                    logger.info("Recovered tool call from final answer (extracted+fixed): %s", obj.get("action"))
                    return obj
            except Exception:
                pass
    except Exception:
        pass
    
    return None


def _needs_tool_retry(answer, step, tools_called):
    """Check if we should force the model to use tools instead of giving this answer."""
    if not answer:
        return True
    
    # ALWAYS retry if it contains markdown code blocks or conversational patterns
    if _is_conversational(answer):
        return True
    
    # CRITICAL: If answer contains JSON tool call structure, we MUST retry to extract and execute it
    # Check for common tool call patterns in the answer
    if '{' in answer and '"action"' in answer:
        # Check if it looks like a tool call JSON
        tool_call_patterns = [
            r'"action"\s*:\s*"(write_file|edit_file|read_file|delete_file|run_command|codebase_search|file_search|grep_search|list_dir)"',
        ]
        for pattern in tool_call_patterns:
            if re.search(pattern, answer):
                logger.warning("Step %d: Found tool call JSON in final answer, will attempt recovery.", step)
                return True
    
    # If no tools were called yet and it's early, always retry
    if step <= 2 and not tools_called:
        # Very short answers without tool usage are suspicious
        if len(answer) < 100:
            return True
        # Answers that look like they're describing a plan
        if re.search(r'(?i)(will|going to|plan to|steps?|process)', answer):
            return True
    
    return False


_FORCE_TOOL_NUDGE = (
    "[System] CRITICAL ERROR: Your response was REJECTED because it contained conversational text, code examples, or descriptions instead of a JSON tool call. "
    "You MUST output ONLY a JSON object. NO markdown code blocks (```). NO 'Step 1', 'Step 2'. NO 'I will...'. NO 'Understood...'. "
    "NO explanations. NO code examples. NO descriptions of what you plan to do. NO 'Let's create...'. NO 'Here are the steps...'. "
    "IMMEDIATELY call a tool. For 'create' tasks, use write_file to create files or run_command for shell commands. "
    "Examples: "
    "{\"action\": \"write_file\", \"input\": {\"path\": \"file.js\", \"content\": \"code here\"}} "
    "{\"action\": \"run_command\", \"input\": {\"command\": \"npm init -y\"}} "
    "{\"action\": \"codebase_search\", \"input\": {\"query\": \"search term\"}} "
    "Output ONLY the JSON. Nothing else. No text before or after."
)


def run_agent(user_prompt, conversation_history=None, mode="agent"):
    """
    Run the AI agent.
    
    Args:
        user_prompt: The user's prompt/query
        conversation_history: Previous conversation messages for context
        mode: "agent" (can make changes) or "chat" (read-only, information only)
    """
    context_parts = []
    tools_called = []
    
    # Add mode context to system
    if mode == "chat":
        context_parts.append("[System] MODE: CHAT - You are in read-only mode. You can explore the codebase but CANNOT make changes. Use only read-only tools: read_file, codebase_search, grep_search, file_search, list_dir. DO NOT use edit_file, write_file, delete_file, or run_command.")
    else:
        context_parts.append("[System] MODE: AGENT - You can make changes to files and run commands. Complete the FULL task before giving a final answer. Do NOT stop until everything is done.")

    step = 0
    while step < MAX_STEPS:
        step += 1
        logger.info("Agent step %d/%d", step, MAX_STEPS)
        context = "\n".join(context_parts) if context_parts else ""

        try:
            decision = plan(user_prompt, context, conversation_history=conversation_history, mode=mode)
        except Exception as e:
            logger.exception("Planner failed at step %d: %s", step, e)
            return f"Agent error: planning failed ({e}). Please try again."

        decision = _ensure_decision(decision)
        action = decision.get("action", "")

        # Handle "final" responses
        if action == "final":
            answer = decision.get("answer", "")

            # Check for special marker indicating conversational response was detected
            if answer == "[CONVERSATIONAL_RESPONSE_DETECTED]":
                logger.warning("Step %d: Conversational response detected by planner. Forcing retry.", step)
                context_parts.append(_FORCE_TOOL_NUDGE)
                continue

            # CRITICAL: Recovery - check if the "answer" is actually a tool call JSON
            # This handles cases where the model outputs JSON as text instead of proper tool call
            recovered = _try_recover_tool_call(answer)
            if recovered:
                logger.info("Step %d: Successfully recovered tool call from final answer: %s", step, recovered.get("action"))
                decision = recovered
                action = decision["action"]
                # Fall through to tool execution below
            else:
                # Check if answer contains JSON tool call patterns that need recovery
                if _needs_tool_retry(answer, step, tools_called):
                    # Try one more time with more aggressive extraction
                    if '{' in answer and '"action"' in answer:
                        logger.warning("Step %d: Answer contains JSON tool call pattern, attempting aggressive recovery.", step)
                        # Try extracting JSON even if it's embedded in text
                        recovered = _try_recover_tool_call(answer)
                        if recovered:
                            logger.info("Step %d: Aggressive recovery succeeded: %s", step, recovered.get("action"))
                            decision = recovered
                            action = decision["action"]
                            # Fall through to tool execution below
                        else:
                            logger.warning("Step %d: Model gave text response with JSON tool call that couldn't be parsed. Forcing retry.", step)
                            context_parts.append(_FORCE_TOOL_NUDGE)
                            continue
                    else:
                        logger.warning("Step %d: Model gave text response without tools. Forcing retry.", step)
                        context_parts.append(_FORCE_TOOL_NUDGE)
                        continue
                else:
                    logger.info("Agent finished at step %d with final answer (tools used: %s)", step, tools_called)
                    return answer if answer else "I completed the task. Let me know if you need anything else."

        # Handle "todo" action: agent submitted plan. Store and continue.
        if action == "todo":
            tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
            if isinstance(tool_input, dict):
                raw_steps = tool_input.get("steps") or tool_input.get("items") or []
                todo_steps = [str(s) for s in raw_steps] if isinstance(raw_steps, list) else []
            else:
                todo_steps = []
            context_parts.append(f"[Step {step}] Agent submitted todo list ({len(todo_steps)} steps). Now execute each step one by one. Do NOT give a final answer until ALL steps are completed.")
            continue

        # It's a tool call (either original or recovered)
        tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}

        # Check if write tool is being used in Chat mode
        if mode == "chat" and action in WRITE_TOOLS:
            logger.warning("Step %d: Attempted to use write tool '%s' in Chat mode. Blocked.", step, action)
            result = f"Error: Cannot use '{action}' in Chat mode. Chat mode is read-only. Switch to Agent mode to make changes."
            context_parts.append(f"[Step {step}] Tool: {action} BLOCKED (Chat mode is read-only)\nResult: {result}")
            continue

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

    logger.warning("Agent reached max steps (%d). Tools called: %s", MAX_STEPS, tools_called)
    return "Agent reached the maximum step limit. If the task is not fully complete, try breaking it into smaller requests or ask to continue."


def run_agent_stream(user_prompt, conversation_history=None, mode="agent"):
    """Generator version of run_agent that yields step events for SSE streaming.
    
    Args:
        user_prompt: The user's prompt/query
        conversation_history: Previous conversation messages for context
        mode: "agent" (can make changes) or "chat" (read-only, information only)
    """
    context_parts = []
    tools_called = []
    todo_steps = []  # List of task steps from agent
    todo_completed_indices = set()  # Indices the agent has marked done via completed_todo
    
    # Add mode context to system
    if mode == "chat":
        context_parts.append("[System] MODE: CHAT - You are in read-only mode. You can explore the codebase but CANNOT make changes. Use only read-only tools: read_file, codebase_search, grep_search, file_search, list_dir. DO NOT use edit_file, write_file, delete_file, or run_command.")
        yield {"type": "thinking", "text": "Chat mode: Exploring codebase (read-only)..."}
    else:
        context_parts.append(
            "[System] MODE: AGENT - You can make changes. Complete the FULL task before giving a final answer.\n"
            "Implement by creating and editing files (write_file, edit_file). Prefer write_file over run_command for creating apps/projects. "
            "Do NOT use npx create-react-app or npm install -g. Use run_command only for 'cd project && npm install' or 'npm start'. "
            "When you finish a todo step, include \"completed_todo\": <index> in your tool-call JSON.\n"
            "Use real-world conventions: match existing project structure, fix root causes not symptoms, verify after each change (e.g. read file back or run tests)."
        )
        yield {"type": "thinking", "text": "Agent mode: Creating plan and executing actions..."}

    step = 0
    while step < MAX_STEPS:
        step += 1
        context = "\n".join(context_parts) if context_parts else ""

        if step > 1:
            yield {"type": "thinking", "text": "Determining next action..."}

        try:
            decision = plan(user_prompt, context, conversation_history=conversation_history, mode=mode)
        except Exception as e:
            yield {"type": "error", "message": f"Planning failed: {e}"}
            yield {"type": "done", "answer": f"Agent error: {e}"}
            return

        decision = _ensure_decision(decision)
        action = decision.get("action", "")

        if action == "final":
            answer = decision.get("answer", "")

            # Check for special marker indicating conversational response was detected
            if answer == "[CONVERSATIONAL_RESPONSE_DETECTED]":
                logger.warning("Step %d: Conversational response detected by planner. Forcing retry.", step)
                context_parts.append(_FORCE_TOOL_NUDGE)
                yield {"type": "thinking", "text": "Switching to direct action..."}
                continue

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

        # Handle "todo" action: agent is submitting its plan. Store and continue.
        if action == "todo":
            tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
            if isinstance(tool_input, dict):
                raw_steps = tool_input.get("steps") or tool_input.get("items") or []
                if isinstance(raw_steps, list):
                    todo_steps = [str(s) for s in raw_steps if s]
                else:
                    todo_steps = []
            else:
                todo_steps = []
            context_parts.append(
                f"[Step {step}] Agent submitted todo list ({len(todo_steps)} steps). Execute each step. "
                "When you finish one step's work, include \"completed_todo\": <index> in your next tool-call JSON so the UI marks it done. "
                "Implement by creating/editing files (write_file, edit_file); avoid run_command for project creation. Do NOT give final until ALL steps are done."
            )
            yield {"type": "todo", "steps": todo_steps}
            continue

        # It's a tool call
        tool_input = decision.get("input") or decision.get("params") or decision.get("arguments") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}

        # Check if write tool is being used in Chat mode
        if mode == "chat" and action in WRITE_TOOLS:
            logger.warning("Step %d: Attempted to use write tool '%s' in Chat mode. Blocked.", step, action)
            yield {"type": "error", "message": f"Cannot use '{action}' in Chat mode. Chat mode is read-only. Switch to Agent mode to make changes."}
            result = f"Error: Cannot use '{action}' in Chat mode. Chat mode is read-only."
            context_parts.append(f"[Step {step}] Tool: {action} BLOCKED (Chat mode is read-only)\nResult: {result}")
            continue

        # Generate human-readable step description
        step_desc = _describe_tool_call(action, tool_input)
        yield {"type": "step", "message": step_desc, "tool": action}

        try:
            result = execute(action, tool_input)
        except Exception as e:
            result = f"Tool error: {e}"

        # Check if result is a confirmation request
        if isinstance(result, str):
            try:
                result_dict = json.loads(result)
                if isinstance(result_dict, dict) and result_dict.get("status") == "confirmation_required":
                    # Generate unique ID for this pending command
                    import uuid
                    command_id = str(uuid.uuid4())
                    
                    # Store pending command (will be retrieved by approval endpoint)
                    from .pending_commands import store_pending_command
                    store_pending_command(command_id, action, tool_input, result_dict.get("command", ""))
                    
                    # Yield confirmation request event
                    yield {
                        "type": "confirmation_required",
                        "command_id": command_id,
                        "tool": action,
                        "command": result_dict.get("command", ""),
                        "message": result_dict.get("message", ""),
                    }
                    # Don't add to context yet - wait for user approval
                    # The frontend will call the approval endpoint and we'll continue
                    continue
            except (json.JSONDecodeError, ValueError):
                pass  # Not JSON, continue normally
            except ImportError:
                # Fallback if pending_commands module not available
                pass

        tools_called.append(action)

        if isinstance(result, dict):
            result_str = json.dumps(result, default=str)
        else:
            result_str = str(result)

        # Show result (more detail for Cursor-style display)
        brief = result_str[:800] + "\n..." if len(result_str) > 800 else result_str
        yield {"type": "tool_result", "tool": action, "result": brief}

        # Mark todo step(s) completed only when the agent says so via completed_todo
        completed_todo = decision.get("completed_todo")
        if todo_steps and completed_todo is not None:
            indices_to_mark = []
            if isinstance(completed_todo, list):
                indices_to_mark = [int(i) for i in completed_todo if isinstance(i, (int, float))]
            elif isinstance(completed_todo, (int, float)):
                indices_to_mark = [int(completed_todo)]
            for idx in indices_to_mark:
                if 0 <= idx < len(todo_steps) and idx not in todo_completed_indices:
                    todo_completed_indices.add(idx)
                    yield {"type": "todo_step_completed", "index": idx, "step": todo_steps[idx]}

        max_result_len = 6000
        if len(result_str) > max_result_len:
            result_str = result_str[:max_result_len] + "\n... (truncated)"

        context_parts.append(f"[Step {step}] Tool: {action}\nInput: {json.dumps(tool_input, default=str)}\nResult:\n{result_str}")

    # Only reached if we hit MAX_STEPS
    yield {"type": "done", "answer": "Agent reached the maximum step limit. If the task is not fully complete, try breaking it into smaller requests or ask to continue."}


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
