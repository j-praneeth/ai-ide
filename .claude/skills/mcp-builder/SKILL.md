---
name: mcp-builder
description: Create high-quality MCP (Model Context Protocol) servers. Use when asked to build an MCP server, MCP tools, or integrate a service via MCP.
---

Build MCP servers that enable LLMs to interact with external services.

RECOMMENDED STACK: TypeScript with streamable HTTP transport (remote) or stdio (local).

FOUR-PHASE WORKFLOW:

**Phase 1 — Research & Planning:**
- Study MCP spec: https://modelcontextprotocol.io/sitemap.xml
- TypeScript SDK: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md
- Python SDK: https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/main/README.md
- Tool naming: `service_action` pattern (e.g., `github_create_issue`, `slack_post_message`)
- Balance comprehensive API coverage vs. high-level workflow tools

**Phase 2 — Implementation:**
- Shared utilities: API client, error handling, response formatting, pagination
- Per tool: Zod input schema, `outputSchema`/`structuredContent`, annotations
- Annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`

**Phase 3 — Review & Test:**
- TypeScript: `npm run build` → `npx @modelcontextprotocol/inspector`
- Python: `python -m py_compile` → MCP Inspector
- Check: no duplicated code, consistent error handling, full type coverage

**Phase 4 — Evaluations (10 Q&A pairs):**
- Independent, read-only, multi-tool, realistic, verifiable, stable
- Format: `<evaluation><qa_pair><question>...</question><answer>...</answer></qa_pair></evaluation>`

TOOL DESIGN RULES:
- One tool per atomic action
- Return structured data, not formatted strings
- Include `_meta` in responses for pagination cursors
- Fail loudly with descriptive errors
