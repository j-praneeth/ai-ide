import requests
import json
import re
import logging
from .indexer import search_codebase

logger = logging.getLogger(__name__)

OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
_DEFAULT_MODEL = "qwen2.5-coder:7b"
_current_model = _DEFAULT_MODEL


def get_model():
    """Return the current model name used by the planner."""
    return _current_model


def set_model(name):
    """Set the model name used by the planner at runtime."""
    global _current_model
    if name and isinstance(name, str) and name.strip():
        _current_model = name.strip()
    else:
        _current_model = _DEFAULT_MODEL

SYSTEM_PROMPT = """You are an autonomous AI coding agent inside Nebula IDE. You have tools to read, search, edit, and create files.

RESPONSE FORMAT: You MUST respond with EXACTLY ONE JSON object. No other text. No markdown. No explanations outside JSON.

## ABSOLUTE RULES - VIOLATION IS FORBIDDEN

1. NEVER describe what you plan to do. NEVER say "I will..." or "Let me..." or "Here are the steps...". Just DO IT by calling a tool.
2. NEVER ask for permission or confirmation. Just act.
3. NEVER output bash/shell commands as text. Use the run_command tool instead.
4. NEVER give a final answer without first using tools to explore the codebase.
5. ALWAYS respond with a JSON tool call on your FIRST response. NEVER start with a final answer.
6. For ANY task: first grep_search or file_search to find relevant files, then read_file, then edit_file or write_file.

## HOW TO RESPOND

EVERY response must be ONE of these JSON objects:

Call a tool:
{"action": "TOOL_NAME", "input": {"param": "value"}}

Give final answer (ONLY after you have used tools):
{"action": "final", "answer": "detailed markdown answer here"}

## TOOLS

{"action": "read_file", "input": {"path": "relative/path.py"}}
{"action": "write_file", "input": {"path": "new_file.py", "content": "file content"}}
{"action": "edit_file", "input": {"path": "file.py", "old_content": "exact old text", "new_content": "new text"}}
{"action": "edit_file", "input": {"path": "file.py", "new_content": "text to add", "position": "beginning"}}
{"action": "file_search", "input": {"query": "filename"}}
{"action": "list_dir", "input": {"path": "."}}
{"action": "grep_search", "input": {"query": "search text", "include_pattern": "*.py"}}
{"action": "codebase_search", "input": {"query": "what to find"}}
{"action": "run_command", "input": {"command": "shell command"}}
{"action": "delete_file", "input": {"path": "file.py"}}

## WORKFLOW FOR CHANGES

1. grep_search or file_search to find the file
2. read_file to see current content
3. edit_file with exact old_content and new_content (old_content MUST match exactly)
4. {"action": "final", "answer": "description of what was changed"}

## WORKFLOW FOR QUESTIONS

1. list_dir, grep_search, read_file to explore the codebase
2. {"action": "final", "answer": "## Detailed Answer\\n\\nComprehensive markdown response with headings, code blocks, bullet points..."}

## EDIT RULES

- old_content must be EXACT text from the file (copy it precisely after reading)
- Use \\n for newlines in JSON strings
- Read the file FIRST before editing

## FINAL ANSWER RULES

- For questions: answer must be detailed (multiple paragraphs, markdown formatted)
- For actions: briefly describe what was changed
- NEVER give an empty answer or just "Done"
"""


def _fix_json_newlines(text):
    """Fix literal newlines inside JSON string values that LLMs often produce."""
    result = []
    in_string = False
    prev_escape = False
    for ch in text:
        if prev_escape:
            result.append(ch)
            prev_escape = False
            continue
        if ch == '\\' and in_string:
            result.append(ch)
            prev_escape = True
            continue
        if ch == '"':
            in_string = not in_string
            result.append(ch)
            continue
        if in_string:
            if ch == '\n':
                result.append('\\n')
                continue
            if ch == '\r':
                continue
            if ch == '\t':
                result.append('\\t')
                continue
        result.append(ch)
    return ''.join(result)


def extract_json(text):
    """Extract the first JSON object from text, handling various LLM output quirks."""
    text = text.strip()

    # Remove markdown code fences if present
    if text.startswith("```"):
        parts = text.split("```")
        for part in parts[1:]:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("{"):
                text = part
                break

    # Try to find the first { ... } in the text
    start = text.find("{")
    if start >= 0:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    return text[start:i+1]
        # No matching brace — return from start
        return text[start:]

    return text


def _parse_json_robust(raw_text):
    """Try multiple strategies to parse JSON from LLM output."""
    cleaned = extract_json(raw_text)

    # Strategy 1: Direct parse
    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # Strategy 2: Fix literal newlines in string values
    try:
        fixed = _fix_json_newlines(cleaned)
        return json.loads(fixed)
    except Exception:
        pass

    # Strategy 3: Try to extract action and key fields with regex
    try:
        action_match = re.search(r'"action"\s*:\s*"([^"]+)"', cleaned)
        if action_match:
            action = action_match.group(1)
            if action == "final":
                answer_match = re.search(r'"answer"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned, re.DOTALL)
                return {"action": "final", "answer": answer_match.group(1) if answer_match else "Done."}
            else:
                # Try to extract input fields
                path_match = re.search(r'"path"\s*:\s*"([^"]+)"', cleaned)
                input_data = {}
                if path_match:
                    input_data["path"] = path_match.group(1)

                instructions_match = re.search(r'"instructions"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned)
                if instructions_match:
                    input_data["instructions"] = instructions_match.group(1)

                query_match = re.search(r'"query"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned)
                if query_match:
                    input_data["query"] = query_match.group(1)

                command_match = re.search(r'"command"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned)
                if command_match:
                    input_data["command"] = command_match.group(1)

                content_match = re.search(r'"content"\s*:\s*"((?:[^"\\]|\\.)*)"', cleaned, re.DOTALL)
                if content_match:
                    input_data["content"] = content_match.group(1).replace('\\n', '\n').replace('\\t', '\t')

                # For code_edit, try to extract everything between the key and the closing
                code_edit_match = re.search(r'"code_edit"\s*:\s*"(.*?)(?:"\s*[,}])', cleaned, re.DOTALL)
                if code_edit_match:
                    input_data["code_edit"] = code_edit_match.group(1).replace('\\n', '\n').replace('\\t', '\t')

                return {"action": action, "input": input_data}
    except Exception:
        pass

    return None


def plan(user_prompt, context="", conversation_history=None):
    # Import project root and file tree dynamically
    try:
        from .tools import get_project_root, get_project_file_tree
        root = str(get_project_root())
        file_tree = get_project_file_tree()
    except Exception:
        root = None
        file_tree = "(unavailable)"

    # Do semantic search for non-action queries AND informational queries
    semantic_context = ""
    lower_prompt = user_prompt.lower()
    is_pure_action = any(kw in lower_prompt for kw in [
        "create", "add", "write", "edit", "modify", "change", "remove",
        "delete", "fix", "rename", "insert", "append", "replace", "update",
    ])
    is_info = any(kw in lower_prompt for kw in [
        "explain", "how does", "what is", "describe", "show me", "architecture",
        "diagram", "overview", "summarize", "analyze", "compare", "why does",
        "how to", "tell me", "list the", "what happens", "walk me through",
        "high level", "documentation",
    ])
    if not is_pure_action or is_info:
        try:
            semantic_results = search_codebase(user_prompt, root=root)
            # Provide more context for info queries
            max_results = 5 if is_info else 3
            semantic_context = "\n\n".join([f"{path}:\n{chunk}" for path, chunk in semantic_results[:max_results]])
        except Exception:
            pass

    # Build project context section
    project_section = f"""
---
Project root: {root or '(no project open)'}
File tree:
{file_tree}
---
"""
    if semantic_context:
        project_section += f"\nRelevant code:\n{semantic_context}\n---\n"

    # Build messages for Ollama Chat API
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT + project_section},
    ]

    # Add conversation history for context
    if conversation_history and len(conversation_history) > 0:
        recent = conversation_history[-16:]  # Last 16 messages
        max_content_len = 800 if is_info else 400
        for msg in recent:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if len(content) > max_content_len:
                content = content[:max_content_len] + "..."
            messages.append({"role": role, "content": content})

    # Build the current user message
    user_content = user_prompt
    if context:
        user_content += "\n\n---\nPrevious steps in this task:\n" + context
    messages.append({"role": "user", "content": user_content})

    model = get_model()
    logger.info("Planner sending %d messages (%d chars) to %s via chat API",
                len(messages), sum(len(m["content"]) for m in messages), model)

    try:
        response = requests.post(
            OLLAMA_CHAT_URL,
            json={
                "model": model,
                "messages": messages,
                "stream": False,
            },
            timeout=90,
        )
        response.raise_for_status()
    except requests.RequestException as e:
        logger.error("Ollama request failed: %s", e)
        return {"action": "final", "answer": f"Failed to connect to the AI model. Make sure Ollama is running. Error: {e}"}

    raw_text = response.json().get("message", {}).get("content", "")
    logger.info("Planner raw response: %s", raw_text[:500])

    # Try robust JSON parsing
    result = _parse_json_robust(raw_text)
    if result and isinstance(result, dict):
        logger.info("Planner parsed action: %s", result.get("action"))
        return result

    logger.warning("All JSON parsing strategies failed for: %s", raw_text[:300])
    return {
        "action": "final",
        "answer": raw_text or "I couldn't process that request. Please try again.",
    }
