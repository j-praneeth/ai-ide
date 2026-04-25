import os
import requests
import json
import re
import logging
from .indexer import search_codebase
from .skills_registry import get_all_skills, select_skills, render_skills_prompt
from .token_optimizer import (
    build_token_report,
    compress_context_steps,
    compress_file_tree,
    get_planner_max_tokens,
    truncate_history_messages,
)

logger = logging.getLogger(__name__)

OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
KIMI_MODEL_ID = "moonshotai/kimi-k2.5"
_DEFAULT_MODEL = "qwen2.5-coder:7b"
_current_model = _DEFAULT_MODEL


def _is_kimi_model(model_name):
    """True if the selected model is Kimi (NVIDIA API)."""
    if not model_name:
        return False
    n = model_name.strip().lower()
    return n == KIMI_MODEL_ID or n.startswith("moonshotai/kimi") or n == "kimi-k2.5"


def _call_nvidia_chat(messages, model, timeout=180):
    """Call NVIDIA API for Kimi. Uses API key from Settings (Connect) or else NVIDIA_API_KEY from env."""
    from .api_keys import get_key
    api_key = get_key("kimi") or os.environ.get("NVIDIA_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "No API key for Kimi. In Settings, select Model providers → Kimi (K2.5), enter your NVIDIA API key, and click Connect. "
            "Or set NVIDIA_API_KEY in your server environment."
        )
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": get_planner_max_tokens(),
        "temperature": 0.2,
        "stream": False,
        "chat_template_kwargs": {"thinking": True},
    }
    resp = requests.post(NVIDIA_CHAT_URL, headers=headers, json=payload, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise ValueError("NVIDIA API returned no choices")
    msg = choices[0].get("message") or {}
    text = (msg.get("content") or "").strip()
    usage = data.get("usage") or {}
    return text, usage


def _is_openai_model(model_name):
    """True if the selected model is an OpenAI provider model (e.g. openai/gpt-4)."""
    if not model_name:
        return False
    return model_name.strip().lower().startswith("openai/")


def _is_ollama_model(model_name):
    """True if the model should be sent to local Ollama (no provider prefix or ollama/)."""
    if not model_name:
        return True
    n = model_name.strip().lower()
    if n.startswith("openai/") or n.startswith("anthropic/") or n.startswith("google/") or n.startswith("groq/") or n.startswith("together/"):
        return False
    if _is_kimi_model(model_name):
        return False
    return True


def _call_openai_chat(messages, model, timeout=180):
    """Call OpenAI API. Uses API key from Settings > Connect (stored in agent.api_keys)."""
    from .api_keys import get_key
    api_key = get_key("openai")
    if not api_key:
        raise RuntimeError("OpenAI API key is not set. In Settings, select Model providers, choose OpenAI, enter your API key, and click Connect.")
    model_id = model.split("/", 1)[-1] if "/" in model else model  # e.g. openai/gpt-4 -> gpt-4
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model_id,
        "messages": messages,
        "max_tokens": get_planner_max_tokens(),
        "temperature": 0.2,
    }
    resp = requests.post(OPENAI_CHAT_URL, headers=headers, json=payload, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise ValueError("OpenAI API returned no choices")
    msg = choices[0].get("message") or {}
    text = (msg.get("content") or "").strip()
    usage = data.get("usage") or {}
    return text, usage


# Timeout for external APIs (NVIDIA, OpenAI) - they can be slow; use longer than Ollama
SIMPLE_CHAT_EXTERNAL_TIMEOUT = 120

def simple_chat(user_message: str, timeout=30) -> str:
    """One-shot chat for greetings/small talk. Returns plain text (no agent/tools)."""
    model = get_model()
    messages = [
        {"role": "system", "content": "You are a friendly coding assistant in Nebula IDE. Reply in one short, friendly sentence. No code, no tools, no lists."},
        {"role": "user", "content": (user_message or "").strip() or "Hello"},
    ]
    try:
        if _is_kimi_model(model):
            text, _usage = _call_nvidia_chat(messages, model, timeout=SIMPLE_CHAT_EXTERNAL_TIMEOUT)
            return text
        if _is_openai_model(model):
            text, _usage = _call_openai_chat(messages, model, timeout=SIMPLE_CHAT_EXTERNAL_TIMEOUT)
            return text
        if _is_ollama_model(model):
            r = requests.post(
                OLLAMA_CHAT_URL,
                json={"model": model, "messages": messages, "stream": False},
                timeout=timeout,
            )
            r.raise_for_status()
            return (r.json().get("message", {}).get("content", "") or "").strip()
    except Exception as e:
        logger.exception("simple_chat failed: %s", e)
        raise
    return "Hello! How can I help you today?"


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

SYSTEM_PROMPT = """You are an AI coding assistant operating in Nebula IDE. You are pair programming with a USER to solve their coding task.

You are an agent - keep going until the user's query is completely resolved before ending your turn. Autonomously resolve the query to the best of your ability. Only terminate when you are sure the problem is solved.

CRITICAL: RESPONSE FORMAT - You MUST respond with EXACTLY ONE JSON object. No other text. No markdown. No code examples. No explanations. No "Step 1", "Step 2" lists. No "I will..." descriptions. ONLY JSON.

IF YOU OUTPUT ANYTHING OTHER THAN A JSON OBJECT, YOUR RESPONSE WILL BE REJECTED AND YOU WILL BE FORCED TO RETRY.

## ABSOLUTE RULES - VIOLATION IS FORBIDDEN

1. NEVER describe what you plan to do. NEVER say "I will..." or "Let me..." or "Here are the steps..." or "To fix this, I'll..." or "Let's start by...". Just DO IT by calling a tool immediately.
2. NEVER ask for permission or confirmation. Just act autonomously.
3. NEVER output bash/shell commands as text (like "```bash\nnpm install\n```"). Use the run_command tool instead.
4. NEVER give a final answer without first using tools to explore the codebase OR executing the requested action.
5. ALWAYS respond with a JSON tool call on your FIRST response. NEVER start with a final answer or explanation.
6. For ANY task: immediately call codebase_search or file_search to find relevant files, then read_file, then edit_file or write_file. Do NOT describe this process.
7. For "create" tasks (websites, apps, projects): IMMEDIATELY create files with write_file (package.json, src/App.js, etc.). Do NOT run create-react-app or npm install -g. Just DO IT with write_file.
8. THERE IS NO "create_file" TOOL. Use "write_file" to CREATE new files. write_file creates files if they don't exist.
9. For complex tasks: FIRST respond with {"action": "todo", "input": {"steps": ["...", "..."]}}. Then execute each step. When you have fully finished one todo step, include "completed_todo": <index> (0-based) in that same tool-call JSON so the UI marks it done. Only respond with "final" when ALL steps are completed.
10. IMPLEMENT BY FILES: For "create X app/website/project", create files with write_file (package.json, src/App.js, etc.). Do NOT use npx create-react-app or npm install -g. Use run_command only for "cd project && npm install" or "npm start".

## FORBIDDEN RESPONSES - THESE WILL BE REJECTED:

WRONG (describing instead of acting):
{"action": "final", "answer": "To fix the alignment issue, I will read the CSS file and then modify the alignment properties."}

WRONG (listing steps):
{"action": "final", "answer": "Here are the steps: 1. Read the CSS file 2. Edit the alignment"}

WRONG (showing code examples):
{"action": "final", "answer": "```swift\nTextField(...)\n```"}

WRONG (any markdown code blocks):
{"action": "final", "answer": "```css\n.input { ... }\n```"}

WRONG (conversational text):
{"action": "final", "answer": "Understood. I will follow your instructions and perform the requested actions step-by-step."}

WRONG (asking permission):
{"action": "final", "answer": "Should I read the CSS file first?"}

CORRECT (immediate tool call - NO TEXT, NO EXPLANATION):
{"action": "codebase_search", "input": {"query": "Enter Room Code input box alignment CSS"}}

## HOW TO RESPOND

EVERY response must be ONE of these JSON objects:

For COMPLEX or MULTI-STEP tasks: FIRST send a todo list, then execute each step. When you finish a step, add "completed_todo": 0 (or the index you just completed) to that response so the UI marks it done.
{"action": "todo", "input": {"steps": ["Step 1 description", "Step 2 description", ...]}}

Call a tool (optionally mark a todo step done when you have finished that step's work):
{"action": "TOOL_NAME", "input": {"param": "value"}, "completed_todo": 0}

Give final answer (ONLY after ALL work is complete and every todo step is done):
{"action": "final", "answer": "detailed markdown answer here"}

## TOOLS — When to use which (use the right tool for speed and accuracy)

- read_file: When you KNOW the file path and need its contents. Use for a specific file; do not use run_command (cat/head/tail) to read files.
- file_search: When you need to find files by NAME or pattern (e.g. "config.json", "*.test.js"). Fast file pattern matching.
- list_dir: When you need to LIST contents of a directory (like LS). Use for exploring a folder.
- grep_search: When you need to search TEXT/CONTENT inside files (exact strings, regex, symbols). Prefer over run_command grep.
- codebase_search: When you need SEMANTIC/meaning search (e.g. "where is auth handled"). Use for open-ended understanding; use grep_search for exact text.
- write_file: Create or overwrite a file. Use to CREATE new files (no separate create_file).
- edit_file: Change part of a file (old_content → new_content). Read the file first, then edit with exact old_content.
- delete_file: Delete a file or folder.
- run_command: For shell commands only (npm, git, cd, mkdir). Do NOT use run_command to read or search files — use read_file, grep_search, file_search instead.
- todo: For complex multi-step tasks; then execute each step with the tools above.

{"action": "read_file", "input": {"path": "relative/path.py"}}
{"action": "write_file", "input": {"path": "new_file.py", "content": "file content"}}  # Use write_file to CREATE new files (it creates if doesn't exist)
{"action": "edit_file", "input": {"path": "file.py", "old_content": "exact old text", "new_content": "new text"}}
{"action": "edit_file", "input": {"path": "file.py", "new_content": "text to add", "position": "beginning"}}
{"action": "file_search", "input": {"query": "filename"}}
{"action": "list_dir", "input": {"path": "."}}
{"action": "grep_search", "input": {"query": "search text", "include_pattern": "*.py"}}
{"action": "codebase_search", "input": {"query": "what to find"}}
{"action": "run_command", "input": {"command": "shell command"}}  # Use for npm, git, mkdir, etc. NOT for reading/searching files.
# IMPORTANT: When creating a project in a subdirectory, use 'cd' in commands:
# {"action": "run_command", "input": {"command": "cd my-project && npm init -y"}}
# Or chain commands: {"action": "run_command", "input": {"command": "cd my-project && npm install react"}}
{"action": "delete_file", "input": {"path": "file.py"}}

IMPORTANT: write_file CREATES files if they don't exist. There is NO separate "create_file" tool.

## CONTEXT UNDERSTANDING & EXPLORATION

Semantic search (codebase_search) is your MAIN exploration tool.

CRITICAL: Start with broad, high-level queries that capture overall intent (e.g. "authentication flow" or "error-handling policy"), not low-level terms.
Break multi-part questions into focused sub-queries (e.g. "How does authentication work?" or "Where is payment processed?").
MANDATORY: Run multiple codebase_search queries with different wording; first-pass results often miss key details.
Keep searching until you're CONFIDENT nothing important remains. If you've performed an edit that may partially fulfill the query but you're not confident, gather more information before ending your turn.
Bias towards not asking the user for help if you can find the answer yourself.

ALWAYS prefer codebase_search over grep_search for code exploration - it's faster and requires fewer tool calls.
Use grep_search only for exact strings, symbols, or specific patterns.

## PARALLEL TOOL EXECUTION

CRITICAL: For maximum efficiency, whenever you perform multiple operations, execute all relevant tools concurrently rather than sequentially.

When gathering information, plan your searches upfront and execute all tool calls together. These cases SHOULD use parallel calls:
- Searching for different patterns (imports, usage, definitions)
- Multiple grep searches with different regex patterns
- Reading multiple files or searching different directories
- Combining codebase_search with grep for comprehensive results
- Any information gathering where you know upfront what you're looking for

DEFAULT TO PARALLEL: Unless operations MUST be sequential (output of A required for input of B), always execute multiple tools simultaneously. Parallel execution is 3-5x faster.

## WORKFLOW FOR CHANGES

1. codebase_search or file_search to find the file (use parallel searches with different queries)
2. read_file to see current content (read all relevant files in parallel if multiple)
3. edit_file with exact old_content and new_content (old_content MUST match exactly - copy precisely after reading)
4. {"action": "final", "answer": "description of what was changed"}

## WORKFLOW FOR CREATING PROJECTS/APPS/WEBSITES

CRITICAL: When user asks to "create X website/app/project", IMPLEMENT BY CREATING FILES with write_file. Do NOT use npx create-react-app or npm install -g. Create the project structure and all source files directly.

1. IMMEDIATELY create files with write_file. Do NOT describe. Do NOT run create-react-app or global installs.
2. Create package.json, src/App.js (or App.jsx), src/index.js, public/index.html, and any other files the project needs using write_file.
3. Create files in parallel when possible (multiple write_file calls).
4. ONLY AFTER all files exist: use run_command for "cd project && npm install" (local install, no -g). Optionally "cd project && npm start" to run the app.
5. Do NOT use: npx create-react-app, npm install -g react-scripts, npm install -g create-react-app, or any global install for scaffolding.
6. Only give final answer when ALL files are created and the project is ready.

EXAMPLE - Creating React Learning Management System:
WRONG: {"action": "run_command", "input": {"command": "npx create-react-app lms-app"}}
WRONG: {"action": "run_command", "input": {"command": "npm install -g react-scripts"}}
CORRECT: {"action": "write_file", "input": {"path": "lms-app/package.json", "content": "{\"name\": \"lms-app\", ...}"}}
CORRECT: {"action": "write_file", "input": {"path": "lms-app/src/App.js", "content": "import React from 'react';\\n\\nfunction App() { ... }\\nexport default App;"}}
... create index.js, index.html, App.css, etc. with write_file ...
THEN: {"action": "run_command", "input": {"command": "cd lms-app && npm install"}}
FINALLY: {"action": "final", "answer": "Created React Learning Management System. Run: cd lms-app && npm start"}

CRITICAL: Prefer write_file over run_command for creating any file. Use run_command only for npm install (in project dir) or npm start.

REMEMBER: write_file CREATES files if they don't exist. There is NO "create_file" tool.

## WORKFLOW FOR QUESTIONS

1. codebase_search with multiple queries (parallel), list_dir, read_file to explore the codebase
2. {"action": "final", "answer": "## Detailed Answer\\n\\nComprehensive markdown response with headings, code blocks, bullet points..."}

## CODE QUALITY GUIDELINES

When writing code, optimize for clarity and readability. Write HIGH-VERBOSITY code.

Naming:
- Avoid short variable/symbol names. Never use 1-2 character names.
- Functions should be verbs/verb-phrases, variables should be nouns/noun-phrases.
- Use meaningful variable names: descriptive enough that comments are generally not needed.
- Prefer full words over abbreviations.
- Examples: genYmdStr → generateDateString, n → numSuccessfulRequests.

Control Flow:
- Use guard clauses/early returns.
- Handle error and edge cases first.
- Avoid unnecessary try/catch blocks. NEVER catch errors without meaningful handling.
- Avoid deep nesting beyond 2-3 levels.

Comments:
- Do not add comments for trivial or obvious code.
- Add comments for complex or hard-to-understand code; explain "why" not "how".
- Never use inline comments. Comment above code lines or use language-specific docstrings.
- Avoid TODO comments. Implement instead.

Formatting:
- Match existing code style and formatting.
- Prefer multi-line over one-liners/complex ternaries.
- Wrap long lines.
- Don't reformat unrelated code.

## REAL-WORLD KNOWLEDGE & REASONING

Use real-world conventions and best practices to work accurately and efficiently:

Frameworks & structure:
- React/Next: components in src/components, pages in src/pages or app/, use React hooks; JSX files .jsx/.tsx; index.js entry.
- Vue/Nuxt: components in components/, pages in pages/, Composition API or Options API; single-file .vue.
- Express/FastAPI/Flask: routes in routes/ or api/, app entry in app.js or main.py; middleware order matters.
- Django: apps in project/, settings.py, urls.py, views.py, models.py; migrations for DB changes.
- Angular: modules, components in src/app/, services, rxjs; .module.ts and .component.ts.
- Package managers: package.json (npm/yarn/pnpm), requirements.txt or pyproject.toml (Python), go.mod (Go), Cargo.toml (Rust).

Files & config:
- Environment: .env for secrets (never commit real keys); use process.env (Node) or os.environ (Python); .env.example as template.
- Config: config.js, settings.py, or framework-specific config; prefer env over hardcoded values.
- Import paths: use existing alias (e.g. @/ for src/); match project import style (relative vs absolute).

Debugging & errors:
- Read the exact error message and stack trace; the first line often points to the real cause.
- Common causes: typo in name/path, wrong type (string vs number), undefined/null access, async not awaited, wrong import path.
- Add logging or breakpoints at the failure point; verify assumptions (e.g. file exists, API returns expected shape).
- Fix the root cause, not only the symptom; avoid empty catch blocks or silencing errors.

APIs & data:
- REST: GET (read), POST (create), PUT/PATCH (update), DELETE; use correct method and status codes.
- JSON: validate keys and types; handle missing/optional fields; escape user input.
- Async: await promises; handle errors with try/catch or .catch(); avoid blocking the event loop.

Security & performance:
- Never put secrets in code or logs; use env vars and secure storage.
- Sanitize/validate user input; use parameterized queries for DB; avoid eval() and unsafe deserialization.
- Prefer specific selectors (e.g. data-testid) over fragile CSS for tests; avoid unnecessary re-renders.

When in doubt:
- Prefer the pattern already used in the codebase over introducing a new one.
- One logical change per step; verify after each edit (e.g. run tests, check file content).
- If a tool fails (e.g. edit_file "old_content not found"), re-read the file and use the exact current text.

## EDIT RULES

- old_content must be EXACT text from the file (copy it precisely after reading)
- Use \\n for newlines in JSON strings
- Read the file FIRST before editing
- If editing multiple files, read all files first, then make all edits

## FINAL ANSWER RULES

- For questions: answer must be detailed (multiple paragraphs, markdown formatted with headings, code blocks, bullet points)
- For actions: briefly describe what was changed
- NEVER give an empty answer or just "Done"
- Use markdown formatting: headings (##, ###), bullet points, code blocks, bold text
- When mentioning files/directories/functions, use backticks: `path/to/file.py`
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


# Skills-driven prompt used for actual planning calls (kept compact to reduce tokens).
BASE_SYSTEM_PROMPT = (
    "You are an AI coding assistant operating in Nebula IDE.\n"
    "You are an agent: keep going until the task is fully resolved.\n\n"
    "CRITICAL RESPONSE FORMAT:\n"
    "- Output exactly ONE JSON object and nothing else.\n"
    "- No markdown, no prose, no code blocks.\n"
    "- Tool call: {\"action\":\"TOOL\",\"input\":{...}}\n"
    "- Todo: {\"action\":\"todo\",\"input\":{\"steps\":[...]}}\n"
    "- Final: {\"action\":\"final\",\"answer\":\"...\"} (only when done)\n"
)


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
            if action == "todo":
                # Extract steps array for todo list
                input_data = {}
                steps_match = re.search(r'"steps"\s*:\s*\[(.*?)\]', cleaned, re.DOTALL)
                if steps_match:
                    steps_str = "[" + steps_match.group(1) + "]"
                    try:
                        steps = json.loads(steps_str)
                        if isinstance(steps, list):
                            input_data["steps"] = [str(s) for s in steps]
                    except Exception:
                        pass
                return {"action": "todo", "input": input_data}
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

                # Extract content - handle multiline content with escaped newlines
                # Try to find content between "content": " and the closing quote, handling escaped quotes
                content_match = re.search(r'"content"\s*:\s*"((?:[^"\\]|\\.|\\n)*)"', cleaned, re.DOTALL)
                if not content_match:
                    # Try alternative: content might extend to end of JSON object
                    content_match = re.search(r'"content"\s*:\s*"((?:[^"]|\\"|\\n)*?)"(?:\s*[,}])', cleaned, re.DOTALL)
                if content_match:
                    content = content_match.group(1)
                    # Unescape sequences
                    content = content.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\\/', '/')
                    input_data["content"] = content

                # For code_edit, try to extract everything between the key and the closing
                code_edit_match = re.search(r'"code_edit"\s*:\s*"(.*?)(?:"\s*[,}])', cleaned, re.DOTALL)
                if code_edit_match:
                    input_data["code_edit"] = code_edit_match.group(1).replace('\\n', '\n').replace('\\t', '\t')

                out = {"action": action, "input": input_data}
                completed_match = re.search(r'"completed_todo"\s*:\s*(\d+)', cleaned)
                if completed_match:
                    out["completed_todo"] = int(completed_match.group(1))
                return out
    except Exception:
        pass

    return None


def plan(user_prompt, context="", conversation_history=None, mode="agent"):
    # Import project root and file tree dynamically
    try:
        from .tools import get_project_root, get_project_file_tree
        root = str(get_project_root())
        # Avoid repeating a large file tree on every planner call (agent loops call plan many times).
        # Include a smaller tree only on the first step (when there is no tool context yet),
        # or when the user is asking architectural/overview questions.
        include_tree = not bool(context and str(context).strip())
        file_tree = get_project_file_tree(max_files=120) if include_tree else "(omitted)"
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
    # Semantic search can be expensive and token-heavy. Only do it on the first planner call for this prompt.
    if (not is_pure_action or is_info) and not (context and str(context).strip()):
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
{compress_file_tree(file_tree, max_lines=120)}
---
"""
    if semantic_context:
        project_section += f"\nRelevant code:\n{semantic_context}\n---\n"

    # Add mode-specific instructions
    mode_instructions = ""
    if mode == "chat":
        mode_instructions = (
            "\n\n## ⚠️ CHAT MODE - READ ONLY ⚠️\n"
            "You are in CHAT mode (read-only). Your role is to PROVIDE INFORMATION ONLY.\n"
            "ALLOWED tools (read-only): read_file, codebase_search, grep_search, file_search, list_dir\n"
            "FORBIDDEN tools (write operations): edit_file, write_file, delete_file, run_command\n"
            "If the user asks you to make changes, explain that they need to switch to Agent mode.\n"
            "Your responses should be informative and helpful, but you CANNOT modify files or run commands.\n"
        )
    else:
        mode_instructions = (
            "\n\n## 🔧 AGENT MODE - FULL ACCESS 🔧\n"
            "You are in AGENT mode. You can use ALL tools including edit_file, write_file, delete_file, run_command.\n"
            "Your goal is to EXECUTE ACTIONS and MAKE CHANGES to solve the user's task.\n"
            "When the user asks you to fix, edit, create, or modify something, DO IT by calling the appropriate tools.\n"
        )
    
    # Skills: select only what is relevant for this request to reduce repeated prompt tokens.
    selected_skills = select_skills(user_prompt, mode=mode)
    skills_prompt = render_skills_prompt(selected_skills)
    active_system_prompt = BASE_SYSTEM_PROMPT + ("\n\n" + skills_prompt if skills_prompt else "")

    all_skills_prompt = render_skills_prompt(get_all_skills())
    baseline_system_prompt = BASE_SYSTEM_PROMPT + ("\n\n" + all_skills_prompt if all_skills_prompt else "")

    # Baseline messages (pre-optimization) - used for token savings reporting.
    baseline_messages = [
        {"role": "system", "content": baseline_system_prompt + mode_instructions + project_section},
    ]

    # Optimize history + tool context before sending.
    optimized_history, history_meta = truncate_history_messages(
        conversation_history,
        max_messages=16,
        max_chars_user=800 if is_info else 500,
        max_chars_assistant=600 if is_info else 400,
    )

    optimized_context, context_meta = compress_context_steps(
        context or "",
        keep_last_steps=8,
        max_chars=12000,
    )

    messages = [
        {"role": "system", "content": active_system_prompt + mode_instructions + project_section},
        *optimized_history,
    ]

    # Build the current user message
    user_content = user_prompt
    if optimized_context:
        user_content += "\n\n---\nPrevious steps in this task:\n" + optimized_context
    messages.append({"role": "user", "content": user_content})

    model = get_model()
    logger.info("Planner sending %d messages (%d chars) to %s via chat API",
                len(messages), sum(len(m["content"]) for m in messages), model)

    _timeout = 180
    raw_text = ""
    provider_usage = None
    try:
        if _is_kimi_model(model):
            raw_text, provider_usage = _call_nvidia_chat(messages, model, timeout=_timeout)
        elif _is_openai_model(model):
            raw_text, provider_usage = _call_openai_chat(messages, model, timeout=_timeout)
        elif _is_ollama_model(model):
            response = requests.post(
                OLLAMA_CHAT_URL,
                json={
                    "model": model,
                    "messages": messages,
                    "stream": False,
                },
                timeout=_timeout,
            )
            response.raise_for_status()
            data = response.json()
            raw_text = data.get("message", {}).get("content", "")
            # Ollama returns eval counts (not always). Normalize to OpenAI-like keys when present.
            provider_usage = {
                "prompt_tokens": data.get("prompt_eval_count"),
                "completion_tokens": data.get("eval_count"),
                "total_tokens": (
                    (data.get("prompt_eval_count") or 0) + (data.get("eval_count") or 0)
                    if (data.get("prompt_eval_count") is not None or data.get("eval_count") is not None)
                    else None
                ),
            }
        else:
            return {"action": "final", "answer": f"Provider for model '{model}' is not yet supported for the agent. Use OpenAI (Settings > Connect), Kimi (NVIDIA_API_KEY), or a local Ollama model."}
    except requests.exceptions.Timeout as e:
        logger.error("Chat request timed out after %ss: %s", _timeout, e)
        return {"action": "final", "answer": "The AI model took too long to respond. Try again or use a different model."}
    except requests.RequestException as e:
        logger.error("Chat request failed: %s", e)
        err_msg = str(e)
        if _is_kimi_model(model):
            return {"action": "final", "answer": f"NVIDIA/Kimi API error. Ensure NVIDIA_API_KEY is set in the server environment. Error: {err_msg[:200]}"}
        if _is_openai_model(model):
            return {"action": "final", "answer": f"OpenAI API error. Check your API key in Settings and try again. Error: {err_msg[:200]}"}
        if "timed out" in err_msg.lower() or "timeout" in err_msg.lower():
            return {"action": "final", "answer": "The AI model timed out. Ensure Ollama is running and the model is loaded. Try again or use a smaller model."}
        return {"action": "final", "answer": f"Failed to connect to the AI model. Make sure Ollama is running. Error: {e}"}
    except (RuntimeError, ValueError) as e:
        logger.error("Kimi/NVIDIA/OpenAI error: %s", e)
        return {"action": "final", "answer": str(e)}
    logger.info("Planner raw response: %s", raw_text[:500])

    # CRITICAL: First check if raw_text contains a JSON tool call that should be executed
    # Sometimes the model outputs JSON as text instead of proper structure
    has_tool_call_json = False
    if raw_text and '{' in raw_text and '"action"' in raw_text:
        # Check if it's a tool call (not a final answer)
        tool_action_pattern = r'"action"\s*:\s*"(todo|write_file|edit_file|read_file|delete_file|run_command|codebase_search|file_search|grep_search|list_dir)"'
        if re.search(tool_action_pattern, raw_text) and not re.search(r'"action"\s*:\s*"final"', raw_text):
            has_tool_call_json = True
            # Try to extract and parse it immediately
            try:
                extracted = extract_json(raw_text)
                if extracted and extracted.strip().startswith('{'):
                    parsed = json.loads(extracted)
                    if isinstance(parsed, dict) and parsed.get("action") in ["todo", "write_file", "edit_file", "read_file", "delete_file", "run_command", "codebase_search", "file_search", "grep_search", "list_dir"]:
                        logger.info("Planner detected and extracted JSON tool call in raw response: %s", parsed.get("action"))
                        return parsed
            except Exception as e:
                logger.debug("Early JSON extraction failed, will try robust parsing: %s", e)
                # Will try robust parsing below

    # CRITICAL: Check if response is conversational (markdown code blocks, step-by-step, etc.)
    # This prevents the model from outputting descriptions instead of JSON tool calls
    # BUT: Don't mark as conversational if it contains a valid tool call JSON
    is_conversational = False
    if raw_text and not has_tool_call_json:
        # Check for markdown code blocks (```language)
        if re.search(r'```\s*\w+', raw_text):
            is_conversational = True
        # Check for step-by-step patterns
        elif re.search(r'(?i)(step\s+\d+|step\s+1|step\s+2|step\s+3|first|second|third|next|then|finally)', raw_text):
            is_conversational = True
        # Check for conversational openings
        elif re.search(r'(?i)^(understood|i will follow|i\'ll follow|let me|let\'s|to fix|based on|to address)', raw_text):
            is_conversational = True
        # Check for "I will" patterns anywhere in first 300 chars
        elif re.search(r'(?i)(i will|i\'ll|here are|here is|i plan to|i would|i can|we will|we\'ll)', raw_text[:300]):
            is_conversational = True
        # Check for numbered lists (1., 2., 3., etc.)
        elif re.search(r'(?i)^\s*\d+\.\s+[A-Z]', raw_text[:500]):
            is_conversational = True
        # Check for "Let's create" or "Let's start" patterns
        elif re.search(r'(?i)(let\'s create|let\'s start|let\'s make|let\'s build)', raw_text[:300]):
            is_conversational = True
        # Check if it starts with text that's not JSON (not starting with { or whitespace before {)
        elif not raw_text.strip().startswith('{') and '{' in raw_text:
            # If there's significant text before the first {, it's likely conversational
            first_brace = raw_text.find('{')
            if first_brace > 50:  # More than 50 chars before first brace
                is_conversational = True
    
    if is_conversational:
        logger.warning("Planner detected conversational response, forcing retry: %s", raw_text[:200])
        # Return a special marker that will trigger retry in orchestrator
        return {
            "action": "final",
            "answer": "[CONVERSATIONAL_RESPONSE_DETECTED]",
        }

    # Try robust JSON parsing
    result = _parse_json_robust(raw_text)
    if result and isinstance(result, dict):
        # Attach token optimization + usage metadata for UI and monitoring.
        try:
            token_report = build_token_report(
                messages_before=baseline_messages + (conversation_history or []) + [{"role": "user", "content": user_prompt}],
                messages_after=messages,
                context_meta=context_meta,
                history_meta=history_meta,
            )
            result["_meta"] = {
                "token_optimization": {
                    "estimated_input_tokens_before": token_report.estimated_input_tokens_before,
                    "estimated_input_tokens_after": token_report.estimated_input_tokens_after,
                    "estimated_tokens_saved": token_report.estimated_tokens_saved,
                    "context_summarized_steps": token_report.context_summarized_steps,
                    "history_trimmed_messages": token_report.history_trimmed_messages,
                    "history_truncated_messages": token_report.history_truncated_messages,
                },
                "skills": [s.id for s in (selected_skills or [])],
                "provider_usage": provider_usage,
                "model": model,
            }
        except Exception:
            pass
        logger.info("Planner parsed action: %s", result.get("action"))
        return result

    # CRITICAL: If JSON parsing failed but we see JSON tool call patterns, try harder
    # This handles cases where the model outputs JSON as text instead of proper structure
    if '{' in raw_text and '"action"' in raw_text:
        # Check if it looks like a tool call that wasn't parsed correctly
        tool_action_pattern = r'"action"\s*:\s*"(todo|write_file|edit_file|read_file|delete_file|run_command|codebase_search|file_search|grep_search|list_dir)"'
        if re.search(tool_action_pattern, raw_text):
            logger.warning("Planner found tool call JSON pattern but parsing failed. Attempting aggressive extraction.")
            # Try extracting JSON more aggressively
            try:
                # Find all JSON objects in the text
                json_start = raw_text.find('{')
                if json_start >= 0:
                    # Try to extract complete JSON object
                    depth = 0
                    json_end = json_start
                    for i in range(json_start, len(raw_text)):
                        if raw_text[i] == '{':
                            depth += 1
                        elif raw_text[i] == '}':
                            depth -= 1
                            if depth == 0:
                                json_end = i + 1
                                break
                    
                    if json_end > json_start:
                        json_str = raw_text[json_start:json_end]
                        valid_actions = ["todo", "write_file", "edit_file", "read_file", "delete_file", "run_command", "codebase_search", "file_search", "grep_search", "list_dir"]
                        try:
                            obj = json.loads(json_str)
                            if isinstance(obj, dict) and obj.get("action") in valid_actions:
                                logger.info("Planner aggressively extracted tool call: %s", obj.get("action"))
                                return obj
                        except Exception:
                            # Try with fixed newlines
                            try:
                                fixed = _fix_json_newlines(json_str)
                                obj = json.loads(fixed)
                                if isinstance(obj, dict) and obj.get("action") in valid_actions:
                                    logger.info("Planner aggressively extracted tool call (fixed): %s", obj.get("action"))
                                    return obj
                            except Exception:
                                pass
            except Exception as e:
                logger.debug("Aggressive JSON extraction failed: %s", e)

    logger.warning("All JSON parsing strategies failed for: %s", raw_text[:300])
    return {
        "action": "final",
        "answer": raw_text or "I couldn't process that request. Please try again.",
    }
