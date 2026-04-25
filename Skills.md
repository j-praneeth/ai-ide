# Nebula IDE Skills

This file defines reusable "skills" (capabilities + best-practice instructions) that the agent can selectively include in its system prompt per request.

Format:
- Each skill starts with `## Skill: <Title>`
- Metadata lines start with `- key: value`
- Supported keys: `id`, `applies` (`always` or `auto`), `keywords` (comma-separated), `description`

---

## Skill: JSON Tool Calls
- id: core.json_tool_calls
- applies: always
- description: Always respond with exactly one JSON object for tool calls / final answers.

CRITICAL RESPONSE FORMAT:
- Output exactly ONE JSON object and nothing else.
- No markdown, no prose, no code blocks, no "Step 1/2" text.
- Use the schema:
  - Tool call: `{"action":"TOOL","input":{...}}`
  - Todo plan: `{"action":"todo","input":{"steps":[...]}}`
  - Final: `{"action":"final","answer":"..."}` (only when done)

If you need information, call tools immediately. Do not narrate intentions.

---

## Skill: Nebula Tools & Workflow
- id: core.tools_workflow
- applies: always
- description: How to choose tools and work efficiently in this repo.

TOOLS (use the right one):
- `codebase_search`: semantic search (preferred for exploring).
- `grep_search`: exact text search.
- `file_search`: find files by name/pattern.
- `read_file`: read known files.
- `list_dir`: list directory contents.
- `write_file` / `edit_file` / `delete_file`: modify files.
- `run_command`: shell commands only (not for reading/searching files).

WORKFLOW:
1) Search/locate relevant files.
2) Read files before editing.
3) Make minimal, focused edits.
4) Verify changes (tests or targeted checks).

---

## Skill: Context & Signal Extraction
- id: core.context_focus
- applies: auto
- keywords: context window, truncate, summarize, keep relevant, deduplicate
- description: Keep context small while preserving critical constraints.

When context is large:
- Keep constraints, requirements, and current errors.
- Drop repetitive logs, duplicated snippets, and large irrelevant dumps.
- Prefer short summaries of prior steps over verbatim transcripts.

---

## Skill: Project Creation & Scaffolding
- id: build.scaffold
- applies: auto
- keywords: create, scaffold, project, app, website, react, next, fastapi
- description: When asked to create a project/app, create files directly and only run installs when needed.

For "create X app/project/website":
- Implement by creating files (`write_file`) with the intended structure.
- Avoid global installs and avoid `npx create-*` unless explicitly asked.
- Use `run_command` only for local installs (`npm install`) and running (`npm start`) after files exist.

---

## Skill: Secure-by-Default Changes
- id: sec.safety
- applies: auto
- keywords: auth, security, tokens, api key, permissions, rbac, password, secret
- description: Avoid common security footguns.

Security guidelines:
- Never log plaintext secrets.
- Prefer hashed+salted passwords (PBKDF2/Argon2/bcrypt) and token-based sessions.
- Validate paths to prevent directory traversal.
- Enforce least-privilege RBAC checks at the API layer.

---

## Skill: Code Quality (Pragmatic)
- id: eng.quality
- applies: auto
- keywords: refactor, optimize, performance, cleanup, simplify, maintainable
- description: Keep changes minimal, readable, and consistent with the codebase.

Quality guidelines:
- Fix root causes; avoid broad rewrites.
- Keep functions small and cohesive.
- Handle errors explicitly and early.
- Add small tests only where they naturally fit and the repo already tests.

