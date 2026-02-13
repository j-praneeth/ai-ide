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

SYSTEM_PROMPT = """You are a powerful agentic AI coding assistant running inside Nebula IDE.
You help the user by DOING things — reading files, writing code, editing files, running commands.
You are NOT an advisor. You are an AGENT. You PERFORM actions.

IMPORTANT: You must respond ONLY with a single valid JSON object. No markdown, no code fences, no extra text.

## CORE BEHAVIOR

1. When the user asks you to create, edit, modify, add, remove, or change ANYTHING in a file, you MUST use tools to do it. NEVER tell the user to "do it manually".
2. If a file is EMPTY, use write_file. If a file has content, first read_file, then edit_file.
3. If a file does not exist, use write_file to create it.
4. NEVER respond with "final" if you haven't completed the task yet.
5. After completing an action, respond with "final" to confirm.

## WORKFLOW

Step 1: Find the file in the file tree below. Use file_search if needed.
Step 2: Read the file with read_file.
Step 3: Make the change with edit_file (using old_content/new_content) or write_file.
Step 4: Respond with "final".

## FILE PATH RULES

- Use EXACT relative paths from the file tree (e.g. "backend/main.py", NOT absolute paths).
- If user says "main.py", find it in the tree.

## JSON response format

Tool call: {"action": "TOOL_NAME", "input": { ... }}
Final answer: {"action": "final", "answer": "What you did"}

## Available tools

1. **read_file** — Read a file. ALWAYS do this before editing.
   {"action": "read_file", "input": {"path": "backend/main.py"}}

2. **write_file** — Create or overwrite a file. Use ONLY for NEW or EMPTY files.
   {"action": "write_file", "input": {"path": "new_file.py", "content": "print('hello')"}}

3. **edit_file** — Edit an existing file. This is SAFE — it only changes what you specify.
   
   THREE ways to use edit_file:
   
   A) FIND-AND-REPLACE (for removing or changing text):
      Provide "old_content" (exact text to find) and "new_content" (replacement).
      {"action": "edit_file", "input": {"path": "main.py", "old_content": "# old comment\\n", "new_content": ""}}
   
   B) INSERT NEW CONTENT (for adding text to beginning or end of file):
      Provide only "new_content" and optionally "position" ("beginning" or "end").
      {"action": "edit_file", "input": {"path": "main.py", "new_content": "# This is main.py\\n", "position": "beginning"}}
   
   C) ADD BEFORE/AFTER existing line (for inserting in the middle):
      Set old_content to the existing line, new_content to that line + new lines.
      {"action": "edit_file", "input": {"path": "main.py", "old_content": "from fastapi import FastAPI", "new_content": "import os\\nfrom fastapi import FastAPI"}}
   
   EXAMPLES:
   
   Remove a comment:
   {"action": "edit_file", "input": {"path": "main.py", "old_content": "# This is a comment\\n", "new_content": ""}}
   
   Add a comment to the top of a file:
   {"action": "edit_file", "input": {"path": "main.py", "new_content": "# This is main.py", "position": "beginning"}}
   
   Add a comment to the end of a file:
   {"action": "edit_file", "input": {"path": "main.py", "new_content": "# End of file", "position": "end"}}
   
   Change a value:
   {"action": "edit_file", "input": {"path": "main.py", "old_content": "app = FastAPI()", "new_content": "app = FastAPI(title=\\"My App\\")"}}
   
   IMPORTANT: For old_content, copy text EXACTLY as it appears in the file. Read the file first! Use \\n for newlines.

4. **file_search** — Find files by partial name.
   {"action": "file_search", "input": {"query": "main.py"}}

5. **list_dir** — List directory contents.
   {"action": "list_dir", "input": {"path": "."}}

6. **grep_search** — Search for text/patterns across files.
   {"action": "grep_search", "input": {"query": "def main", "include_pattern": "*.py"}}

7. **codebase_search** — Semantic search for code.
   {"action": "codebase_search", "input": {"query": "authentication logic"}}

8. **run_command** — Run a terminal command.
   {"action": "run_command", "input": {"command": "ls -la"}}

9. **delete_file** — Delete a file.
   {"action": "delete_file", "input": {"path": "old_file.py"}}

## CRITICAL RULES

- Output EXACTLY ONE JSON object. Nothing else.
- Do NOT wrap JSON in ``` or ```json.
- NEVER say "do it manually". YOU do it.
- For edit_file: ALWAYS use old_content + new_content. NEVER use code_edit with full file content.
- old_content must EXACTLY match text in the file. Read the file first!
- Use \\n for newlines inside JSON strings.
- If a tool fails, try a different approach.
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

    # Only do semantic search for non-action queries (saves time on edits)
    semantic_context = ""
    lower_prompt = user_prompt.lower()
    is_action = any(kw in lower_prompt for kw in [
        "create", "add", "write", "edit", "modify", "change", "remove",
        "delete", "fix", "rename", "insert", "append", "replace", "update",
    ])
    if not is_action:
        try:
            semantic_results = search_codebase(user_prompt, root=root)
            semantic_context = "\n\n".join([f"{path}:\n{chunk}" for path, chunk in semantic_results[:3]])
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
        for msg in recent:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if len(content) > 400:
                content = content[:400] + "..."
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
