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

---

## Skill: Test-Driven Development
- id: tdd.mastery
- applies: auto
- keywords: test, tdd, unit test, jest, pytest, vitest, spec, coverage, failing test
- description: Red-Green-Refactor cycle with test pyramid guidance.

TDD CYCLE:
1. **Red** — write the smallest failing test for the behaviour you want
2. **Green** — write only enough code to make it pass
3. **Refactor** — clean up while keeping all tests green

TEST PYRAMID (target ratios):
- Unit 70%: pure functions, business logic, no I/O, fast
- Integration 20%: service interactions, real DB/HTTP calls
- E2E 10%: critical user flows only

NAMING: `should_<expected_behaviour>_when_<condition>`

COVERAGE TARGETS: line ≥ 80%, branch ≥ 75%

ANTI-PATTERNS to avoid:
- Testing implementation details (mock only at system boundaries)
- Shared mutable state between tests
- `skip`/`todo` tests in main without a comment explaining why

---

## Skill: API Design
- id: api.design
- applies: auto
- keywords: api, rest, endpoint, route, http, openapi, swagger, graphql, pagination, versioning
- description: RESTful API design best practices.

RESOURCE NAMING:
- Plural nouns: `/users`, `/orders`, `/products`
- Nest at most one level: `/users/{id}/orders` ✓; `/users/{id}/orders/{id}/items` ✗
- No verbs in paths — use HTTP methods

HTTP METHOD → STATUS CODE:
- GET → 200 | POST (create) → 201 + Location | PUT/PATCH → 200 | DELETE → 204

RESPONSE ENVELOPE: `{ "data": ..., "meta": ..., "error": null }`

ERRORS: `{ "error": { "code": "MACHINE_READABLE", "message": "Human text", "fields": {...} } }`

PAGINATION: cursor-based preferred for real-time/large datasets; include `nextCursor`/`hasMore`

VERSIONING: URL path for public APIs (`/v1/`), header for internal APIs

RATE LIMITING: return 429 with `Retry-After` and `X-RateLimit-*` headers

---

## Skill: Security Hardening
- id: sec.hardening
- applies: auto
- keywords: security, vulnerability, injection, xss, csrf, sql injection, authentication, jwt, oauth, bcrypt, argon2, csp, hsts, cors
- description: Application security controls and anti-patterns.

NON-NEGOTIABLE CONTROLS:
- Validate ALL inputs at boundaries with Zod / Pydantic / Joi — no exceptions
- Parameterized queries ONLY — zero string interpolation in SQL
- Secrets in env vars or secrets manager — never in source code or logs
- Passwords: bcrypt (cost ≥ 12) or argon2id
- JWTs: access ≤ 15min; rotate refresh tokens on use; invalidate on logout
- HTTP headers: CSP, HSTS, X-Content-Type-Options, X-Frame-Options
- Cookies: HttpOnly + Secure + SameSite=Strict
- CORS: explicit allowlist of known origins

DEPENDENCY AUDIT: run `npm audit` / `pip-audit` in CI; critical CVEs within 24h, high within 7d

PATH TRAVERSAL: validate all user-supplied paths; reject `..` segments

---

## Skill: TypeScript Advanced Patterns
- id: ts.advanced
- applies: auto
- keywords: typescript, generics, type, interface, discriminated union, mapped type, conditional type, type guard, zod, strict
- description: TypeScript type system patterns for safer, self-documenting code.

KEY PATTERNS:
- **Discriminated unions** for exhaustive state modelling: `type Result = { ok: true; data: T } | { ok: false; error: string }`
- **Type guards** to narrow types: `function isUser(x: unknown): x is User { return ... }`
- **Mapped types** for transformations: `type Partial<T> = { [K in keyof T]?: T[K] }`
- **Conditional types** for utility types: `type NonNullable<T> = T extends null | undefined ? never : T`
- **Template literal types** for string patterns: `` type EventName = `on${Capitalize<string>}` ``

STRICT MODE: always enable `strict: true` in tsconfig

RUNTIME VALIDATION: pair TypeScript types with Zod schemas for runtime boundary checks

AVOID: `any` (use `unknown` and narrow), `!` non-null assertions (guard instead), type casting without validation

---

## Skill: Python Best Practices
- id: py.best
- applies: auto
- keywords: python, fastapi, django, flask, pydantic, asyncio, pytest, ruff, mypy, type hint
- description: Modern Python (3.12+) patterns and tooling.

TYPE HINTS: use 3.12+ syntax — `list[str]` not `List[str]`, `str | None` not `Optional[str]`

ASYNC: `asyncio` + `httpx` for async HTTP; avoid mixing sync/async without `run_in_executor`

DATA CLASSES: prefer `@dataclass` for plain data, `pydantic.BaseModel` for validated/serialized data

VALIDATION: Pydantic v2 with `model_validator` for cross-field rules; never parse untrusted data manually

TESTING: pytest with fixtures; `pytest-asyncio` for async tests; `httpx.AsyncClient` for FastAPI testing

TOOLING: Ruff for lint + format (replaces black/flake8/isort); mypy or pyright for type checking

ANTI-PATTERNS:
- Mutable default arguments: `def f(x=[])` → use `x=None` and initialize inside
- Bare `except:` — always specify the exception type
- `os.system()` — use `subprocess.run()` with `check=True`

---

## Skill: React Patterns (Modern)
- id: react.modern
- applies: auto
- keywords: react, hooks, component, useeffect, usestate, usememo, usecallback, context, suspense, server component, nextjs
- description: React 18+ / Next.js 14+ patterns and performance guidelines.

SERVER COMPONENTS (Next.js 14+):
- Default to Server Components; add `'use client'` only when needed (interactivity, browser APIs, hooks)
- Fetch data in Server Components with `async/await` — no `useEffect` for initial data

HOOKS RULES:
- `useEffect` only for synchronizing with external systems (never for derived state — compute it)
- Stabilize callbacks with `useCallback` only when passed to memoized children or deps arrays
- `useMemo` only after profiling shows an actual bottleneck

STATE:
- Server state → TanStack Query; client global state → Zustand; form state → React Hook Form
- Keep state as local as possible; lift only when multiple components need it

COMPONENT DESIGN:
- Max 150 lines; split into smaller components if larger
- Composition over inheritance
- Error Boundaries around each major feature area

PERFORMANCE:
- Core Web Vitals targets: LCP < 2.5s, FID < 100ms, CLS < 0.1
- Lazy-load routes and heavy components with `React.lazy`
- Images via `next/image` with explicit dimensions

---

## Skill: Database Optimization
- id: db.optimize
- applies: auto
- keywords: database, sql, query, index, n+1, postgres, mysql, migration, orm, prisma, drizzle, slow query
- description: Database design and query optimization patterns.

QUERY OPTIMIZATION:
- Use `EXPLAIN ANALYZE` (Postgres) to inspect slow queries
- Select only needed columns — avoid `SELECT *`
- Prevent N+1: use eager loading (`.include()` in Prisma, `select_related()` in Django)
- Use DataLoaders for batching in GraphQL resolvers

INDEX STRATEGY:
- Index columns used in WHERE, JOIN, and ORDER BY
- Composite index column order: equality filters first, range filters last
- Index foreign keys (often missed)
- Partial indexes for filtered queries on large tables

SCHEMA:
- UUID v7 for sortable primary keys
- `created_at` / `updated_at` with automatic `NOW()` defaults
- Soft deletes via `deleted_at` (nullable timestamp) rather than hard deletes
- Always write reversible migrations (add `down()` method)

CONNECTION POOLING: baseline = (2 × CPU cores) + disk spindle count

---

## Skill: Git Advanced
- id: git.advanced
- applies: auto
- keywords: git, commit, rebase, merge, branch, worktree, bisect, reflog, cherry-pick, stash, conflict
- description: Advanced git operations and workflow patterns.

COMMIT MESSAGES (Conventional Commits):
- Format: `type(scope): subject` — imperative, lowercase, ≤72 chars, no period
- Types: feat, fix, refactor, docs, test, chore, perf, style, ci, build

BRANCH STRATEGY:
- `feature/`, `fix/`, `refactor/`, `docs/` prefixes
- Merge within 1-3 days; delete branches after merge
- One logical change per PR; diff ≤ 400 lines

RECOVERY:
- `git reflog` to find lost commits
- `git bisect` to find the commit that introduced a bug
- `git stash -u` to stash including untracked files

SAFE OPERATIONS:
- `git push --force-with-lease` (not `--force`) when rewriting history
- Never force push to main or shared branches
- `git revert` (not `git reset`) to undo published commits

---

## Skill: Performance Optimization
- id: perf.optimize
- applies: auto
- keywords: performance, slow, latency, bundle size, lighthouse, web vitals, cache, lazy load, paginate, profiling
- description: Frontend and backend performance patterns.

MEASURE FIRST:
- Establish performance budgets before optimising
- Profile with browser DevTools / `py-spy` / `clinic.js` before guessing
- Alert on P95/P99 latency, not averages

FRONTEND:
- Code-split at route boundaries (`React.lazy` + Suspense)
- Lazy-load images and off-screen components
- Tree-shake unused imports; audit bundle with `webpack-bundle-analyzer`
- Cache expensive computations; define explicit invalidation strategy
- Core Web Vitals targets: LCP < 2.5s, INP < 200ms, CLS < 0.1

BACKEND:
- Cache expensive DB reads in Redis with TTL + invalidation
- Stream large payloads — never buffer entire response body
- Cursor-based pagination for large tables
- Avoid N+1: use DataLoader / eager loading
- HTTP keep-alive; connection pooling; async I/O throughout

---

## Skill: CI/CD Pipelines
- id: cicd.pipelines
- applies: auto
- keywords: ci, cd, github actions, pipeline, workflow, docker, deploy, test, lint, build
- description: CI/CD pipeline design and GitHub Actions patterns.

PIPELINE ORDER (fail fast):
1. Lint + type-check (cheapest)
2. Unit tests
3. Integration tests
4. Build / Docker image
5. Deploy (staging → production)

CACHING: cache `node_modules`, pip wheels, Docker layers — key on lockfile hash

SECRETS: use GitHub Actions secrets or Vault — never hardcode in YAML

DOCKER IN CI:
- Multi-stage builds; pin base image to digest
- Layer order: OS → deps → source (deps cached across builds)
- Run as non-root; health check in every Dockerfile

QUALITY GATES per PR: lint ✓, types ✓, tests ✓, coverage ≥ target, no critical audit issues

DEPLOYMENT:
- Blue-green or canary for zero-downtime
- Automated rollback if health checks fail after deploy
- Never deploy on Fridays

---

## Skill: Algorithmic Art (p5.js)
- id: art.algorithmic
- applies: auto
- keywords: algorithmic art, generative art, p5.js, creative coding, procedural, particle, animation, canvas, visual, emergent
- description: Create algorithmic/generative art using p5.js with seeded randomness and interactive parameters.

PHILOSOPHY: Algorithmic expression, emergent behavior, and computational craftsmanship — not static images.

WORKFLOW:
1. Define a clear generative philosophy (what makes the system interesting?)
2. Implement in p5.js using `backend/skill_scripts/templates/viewer.html` as foundation
3. Add seeded randomness so outputs are reproducible
4. Expose tunable parameters — reflect what makes the system interesting, not predefined "pattern types"

TEMPLATE RULES:
- Preserve fixed elements: Anthropic branding, seed controls, action buttons
- Only replace: the algorithm, parameter definitions, and parameter UI controls

PARAMETERS: Use sliders/inputs for values that meaningfully change the aesthetic output. Label them intuitively.

SEEDED RANDOMNESS: Use a seed value so the same seed always produces the same output. Let the user change the seed to explore variation.

---

## Skill: Anthropic Brand Guidelines
- id: brand.anthropic
- applies: auto
- keywords: anthropic brand, brand colors, brand fonts, poppins, lora, anthropic style, brand guidelines
- description: Apply Anthropic's official color palette and typography.

COLOR PALETTE:
- Dark: #141413 | Light: #faf9f5 | Mid Gray: #b0aea5 | Light Gray: #e8e6dc
- Accent Orange: #d97757 | Accent Blue: #6a9bcc | Accent Green: #788c5d

TYPOGRAPHY:
- Headings: Poppins (fallback: Arial)
- Body: Lora (fallback: Georgia)

USAGE:
- Apply fonts based on content type; system applies automatic fallbacks if fonts unavailable
- Accent colors cycle: orange → blue → green
- Pre-installing Poppins and Lora from Google Fonts produces optimal results

---

## Skill: Canvas Design
- id: design.canvas
- applies: auto
- keywords: canvas design, visual artifact, design philosophy, poster, layout, visual output, pdf, png
- description: Create visual design artifacts (PDF, PNG, MD) with a design-philosophy-first approach.

PROCESS:
1. Establish a design philosophy before producing any visual output — what is the piece trying to communicate?
2. Choose a visual direction (minimalist, editorial, bold, structured, etc.)
3. Produce the artifact in the requested format: `.md`, `.pdf`, or `.png`

OUTPUT FORMATS:
- `.md` — structured content, suitable for further processing
- `.pdf` — print-ready, fixed layout
- `.png` — raster image, suitable for embedding

Always prioritize intentionality — every visual decision should serve the communication goal.

---

## Skill: Claude API / Anthropic SDK
- id: claude.api
- applies: auto
- keywords: claude api, anthropic sdk, anthropic api, claude model, tool use, streaming, thinking, batch, prompt caching, citations, managed agents
- description: Build, debug, and optimize Claude API / Anthropic SDK applications.

DEFAULTS:
- Model: `claude-opus-4-7` unless specified
- Thinking: `{type: "adaptive"}` for complex reasoning tasks
- Streaming: default for high-token requests
- Always use official SDKs (`anthropic` for Python, `@anthropic-ai/sdk` for JS) — no raw HTTP unless asked

CURRENT MODELS:
| Model | ID | Context | Input $/1M | Output $/1M |
|---|---|---|---|---|
| Opus 4.7 | `claude-opus-4-7` | 1M | $5 | $25 |
| Opus 4.6 | `claude-opus-4-6` | 1M | $5 | $25 |
| Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3 | $15 |
| Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 | $5 |

SURFACE SELECTION:
- Single API call (classification, extraction, Q&A) → Claude API
- Multi-step workflow → Claude API + tool use
- Agent with custom tools → Claude API + tool use
- Server-managed stateful agent → Managed Agents

SKIP THIS SKILL when: code uses `openai` or other provider SDK, provider-neutral code, or general programming/ML unrelated to Claude.

---

## Skill: Document Co-Authoring
- id: doc.coauthoring
- applies: auto
- keywords: document, write, draft, proposal, spec, decision doc, technical writing, coauthor, collaborative writing
- description: Three-stage collaborative workflow for creating high-quality documents.

STAGE 1 — CONTEXT GATHERING:
- Ask 5–10 clarifying meta-questions: document type, audience, desired impact, format, constraints
- Accept stream-of-consciousness input or linked sources
- Track unknowns — surface them explicitly

STAGE 2 — REFINEMENT & STRUCTURE:
- Work section by section: clarify → brainstorm (5–20 options) → user curates → gap-check → draft → iterate
- Use string replacement for surgical edits, not full rewrites
- Trigger quality check after 3 consecutive iterations without substantial changes
- Full document review near completion: flow, consistency, redundancy, filler

STAGE 3 — READER TESTING:
- Simulate a fresh reader (no conversation context) answering the document's predicted questions
- Success = reader consistently gets correct answers without ambiguity
- With sub-agents: invoke fresh instances; without: provide instructions for separate conversation testing

---

## Skill: Word Documents (DOCX)
- id: docs.docx
- applies: auto
- keywords: docx, word document, .docx, word file, microsoft word, document generation, document editing
- description: Read, create, and edit Word (.docx) files using pandoc and the docx npm package.

KEY TOOLS:
- `pandoc` — text extraction from .docx
- `docx` npm package — create/edit .docx programmatically
- Python scripts — validation and ZIP repacking

CRITICAL IMPLEMENTATION DETAILS:
- Always set page dimensions explicitly (A4 default, not US Letter)
- Use `WidthType.DXA` for table widths (ensures Google Docs compatibility)
- Never insert Unicode bullet characters manually — use numbering configuration instead
- .docx files are ZIP archives containing XML; can be unpacked, edited, and repacked

WORKFLOW FOR EDITING:
1. Unpack: `unzip doc.docx -d doc_unpacked/`
2. Edit the XML files in `word/`
3. Repack: `cd doc_unpacked && zip -r ../doc_edited.docx .`

---

## Skill: Frontend Design (Production-Grade)
- id: frontend.design
- applies: auto
- keywords: frontend design, ui design, visual design, landing page, dashboard, component design, css, tailwind, beautiful, modern ui
- description: Build production-grade frontend interfaces with distinctive, high-quality design — no generic "AI slop."

DESIGN THINKING:
1. Understand the purpose, audience, and technical constraints
2. Commit to a bold aesthetic direction: minimalism, maximalism, retro-futuristic, brutalist, etc.
3. Execute with intentionality — every decision serves the vision

FOCUS AREAS:
- **Typography**: Distinctive, characterful fonts — NOT Inter, Roboto, or Arial
- **Color**: Cohesive palette with a dominant color and sharp accents — NOT purple gradients
- **Motion**: CSS-only animations; high-impact on page load
- **Spatial Composition**: Unexpected layouts, asymmetry, overlap, generous whitespace
- **Visual Details**: Gradients, textures, patterns, custom effects

AVOID:
- Predictable, cookie-cutter layouts
- Default Tailwind blues and purples
- Uniform border-radius everywhere
- Centered everything

Match code complexity to the design vision — maximalist designs require elaborate implementations; minimalist designs demand precision and restraint.

---

## Skill: Internal Communications
- id: comms.internal
- applies: auto
- keywords: internal comms, company update, newsletter, 3p update, status report, incident report, leadership update, project update, faq
- description: Write internal company communications: 3P updates, newsletters, status reports, incident reports, and leadership updates.

SUPPORTED TYPES:
- **3P Updates** (Progress / Plans / Problems) — weekly/bi-weekly team status
- **Company Newsletters** — all-hands or department-level updates
- **FAQ Responses** — clear, structured Q&A format
- **Status Reports** — milestone-focused project summaries
- **Leadership Updates** — executive-audience summaries
- **Project Updates** — stakeholder-facing progress reports
- **Incident Reports** — post-mortem structure (what happened, impact, root cause, resolution, next steps)

WRITING PRINCIPLES:
- Lead with the most important information
- Use bullet points for scannability; prose for context
- Be specific: name owners, dates, and decisions
- Separate facts from plans from problems (3P structure)
- Match tone to audience: casual for peers, formal for leadership

If the communication type is unclear, ask about preferred format before drafting.

---

## Skill: MCP Server Builder
- id: mcp.builder
- applies: auto
- keywords: mcp, model context protocol, mcp server, mcp tool, mcp client, tool use, server, stdio, http, anthropic mcp
- description: Create high-quality MCP (Model Context Protocol) servers with well-designed tools.

RECOMMENDED STACK: TypeScript (streamable HTTP for remote, stdio for local)

FOUR-PHASE WORKFLOW:

PHASE 1 — RESEARCH & PLANNING:
- Study MCP spec: https://modelcontextprotocol.io/sitemap.xml
- Balance API endpoint coverage vs. workflow tools; prefer comprehensive coverage when uncertain
- Tool naming: consistent prefix + action (e.g., `github_create_issue`, `slack_send_message`)
- Study TypeScript SDK: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md

PHASE 2 — IMPLEMENTATION:
- Shared utilities: API client, error handling, response formatting, pagination support
- Per tool: input schema (Zod), output schema (`outputSchema`/`structuredContent`)
- Tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`

PHASE 3 — REVIEW & TEST:
- No duplicated code; consistent error handling; full type coverage
- TypeScript: `npm run build` then `npx @modelcontextprotocol/inspector`
- Python: `python -m py_compile` then MCP Inspector

PHASE 4 — EVALUATIONS:
- Write 10 evaluation Q&A pairs: independent, read-only, multi-tool, realistic, verifiable, stable
- Format: `<evaluation><qa_pair><question>...</question><answer>...</answer></qa_pair></evaluation>`

---

## Skill: PDF Processing
- id: docs.pdf
- applies: auto
- keywords: pdf, pdf processing, pdf extract, pdf create, pdf merge, pdf split, ocr, pdfplumber, pypdf, reportlab
- description: Read, create, edit, and extract data from PDF files using Python libraries.

TOOL SELECTION:
| Task | Best Tool |
|---|---|
| Merge / split PDFs | pypdf |
| Extract text with layout | pdfplumber |
| Extract tables | pdfplumber |
| Create PDFs programmatically | reportlab |
| Command-line merge/split | qpdf |
| OCR scanned PDFs | pytesseract + pdf2image |
| Fill PDF forms | pdf-lib (JS) or pypdf |

CRITICAL — REPORTLAB SUBSCRIPTS/SUPERSCRIPTS:
- NEVER use Unicode subscript/superscript characters (₀₁₂…, ⁰¹²…) — built-in fonts render them as solid black boxes
- Use `<sub>` and `<super>` XML tags inside `Paragraph` objects instead

COMMON PATTERNS:
```python
# Extract text
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = "\n".join(p.extract_text() for p in pdf.pages)

# Merge PDFs
from pypdf import PdfWriter
writer = PdfWriter()
for f in files:
    writer.append(f)
writer.write("merged.pdf")
```

---

## Skill: PowerPoint (PPTX)
- id: docs.pptx
- applies: auto
- keywords: pptx, powerpoint, presentation, slides, slide deck, .pptx, keynote
- description: Create and edit PowerPoint presentations with strong visual design.

CORE COMMANDS:
- Extract text: `python -m markitdown presentation.pptx`
- Visual analysis: `python backend/skill_scripts/thumbnail.py presentation.pptx`
- Edit: unpack → modify XML → repack

DESIGN PRINCIPLES:
- Select colors matching the specific topic — not default blue
- 60–70% one primary color with supporting accents
- "Sandwich" structure: dark backgrounds for opening and closing slides
- Repeat one distinctive visual motif consistently throughout
- Every slide needs a visual element — text-only slides are forgettable

TYPOGRAPHY:
- Body text: left-aligned, 14–16pt
- Titles: 36–44pt
- No centered paragraphs
- Maintain substantial size contrast between elements

QA PROCESS:
1. Treat the first render as potentially flawed
2. Visually inspect for: overlapping elements, text overflow, low contrast
3. Iterate until no new issues appear

DEPENDENCIES: markitdown, Pillow, pptxgenjs, LibreOffice, Poppler

---

## Skill: Skill Creator (Meta)
- id: meta.skill_creator
- applies: auto
- keywords: create skill, new skill, skill template, skill registry, skills.md, add skill, skill definition
- description: Create new Claude Code skills — structure, format, and content for well-formed SKILL.md files.

SKILL STRUCTURE:
```
.claude/skills/<skill-name>/
  SKILL.md          ← instructions and metadata
  reference/        ← reference docs, examples
  examples/         ← example inputs/outputs
  scripts/          ← helper scripts
  templates/        ← starter templates
```

SKILL.MD FORMAT:
```yaml
---
name: <slug>
description: <one-line summary of when to trigger>
---
<instructions for the agent>
```

GOOD SKILL DESIGN:
- Narrow trigger: describe exactly when the skill applies AND when to skip it
- Self-contained: include all the knowledge the agent needs inline
- Action-oriented: tell the agent what to DO, not just what to know
- Include gotchas: document the non-obvious failure modes

REGISTRY ENTRY (Skills.md format):
```
  ## Skill: <Title>
  - id: <category>.<name>
  - applies: auto
  - keywords: <comma-separated trigger words>
  - description: <one-line description>

  <skill content>
```

---

## Skill: Slack GIF Creator
- id: media.slack_gif
- applies: auto
- keywords: gif, animated gif, slack gif, slack emoji, animation, gif creator, emoji gif
- description: Create animated GIFs optimized for Slack — emoji size or message size.

SPECIFICATIONS:
- Emoji GIFs: 128×128px, 10–30 FPS, 48–128 colors, under 3 seconds loop
- Message GIFs: 480×480px, same FPS/color guidance

IMPLEMENTATION PATTERN:
```python
builder = GIFBuilder(width=128, height=128, fps=24)
# Generate frames using PIL Image primitives
for frame_idx in range(total_frames):
    img = Image.new("RGBA", (128, 128))
    draw = ImageDraw.Draw(img)
    # ... draw primitives ...
    builder.add_frame(img)
builder.save("output.gif", optimize=True)
```

ANIMATION TECHNIQUES:
- **Motion**: shake (oscillation), bounce (easing), slide (position interpolation)
- **Transformation**: pulse (sine waves), spin/rotate, zoom scaling
- **Appearance**: fade in/out (alpha), particle burst (radiate outward)

FILE SIZE OPTIMIZATION (if > 3 MB):
1. Lower FPS (24 → 15 → 10)
2. Reduce color palette to 48
3. Reduce dimensions
4. Enable duplicate frame removal
5. Activate emoji mode optimization

PHILOSOPHY: Use PIL `ImageDraw` primitives directly — flexibility over rigid templates.

---

## Skill: Theme Factory
- id: design.theme_factory
- applies: auto
- keywords: theme, styling, color theme, design theme, apply theme, slides theme, document theme, color scheme
- description: Apply one of 10 pre-set design themes (or generate a custom theme) to artifacts — slides, docs, reports, HTML pages.

WORKFLOW:
1. Present the 10 available themes to the user (listed below — no external file needed)
2. Ask which theme to apply
3. Wait for explicit confirmation
4. Read the corresponding file from `backend/skill_scripts/themes/` directory
5. Apply colors and fonts consistently throughout the entire artifact

10 AVAILABLE THEMES:
1. **Ocean Depths** — professional maritime (deep blues, teals)
2. **Sunset Boulevard** — warm vibrant sunset (oranges, corals, golds)
3. **Forest Canopy** — natural earth tones (greens, browns)
4. **Modern Minimalist** — clean grayscale
5. **Golden Hour** — rich autumnal palette (ambers, burnt oranges)
6. **Arctic Frost** — cool winter-inspired (icy blues, whites)
7. **Desert Rose** — soft dusty tones (mauve, sand, blush)
8. **Tech Innovation** — bold modern tech (electric blues, dark backgrounds)
9. **Botanical Garden** — fresh organic (leafy greens, botanical accents)
10. **Midnight Galaxy** — dramatic cosmic (deep purples, star-silver accents)

CUSTOM THEME: If no preset fits, generate a theme from the user's description, show for review, then apply.

---

## Skill: Web Artifacts Builder
- id: web.artifacts_builder
- applies: auto
- keywords: html artifact, react artifact, web artifact, claude artifact, complex artifact, multi-component, shadcn, tailwind artifact, react tailwind
- description: Build complex multi-component claude.ai HTML artifacts with React 18, Tailwind CSS, and shadcn/ui.

WHEN TO USE: Complex artifacts requiring state management, routing, or shadcn/ui components.
SKIP FOR: Simple single-file HTML/JSX artifacts — use a plain artifact instead.

STACK: React 18 + TypeScript + Vite + Parcel (bundling) + Tailwind CSS 3.4.1 + shadcn/ui (40+ components)

5-STEP WORKFLOW:
1. `bash backend/skill_scripts/init-artifact.sh <project-name>` — scaffold project with full config
2. Develop by editing generated source files
3. `bash backend/skill_scripts/bundle-artifact.sh` — produces single self-contained `bundle.html`
4. Share `bundle.html` in conversation as the artifact
5. (Optional) Test with Playwright or webapp-testing skill

DESIGN: Avoid "AI slop" —
- No excessive centered layouts
- No default purple gradients
- No uniform border-radius on everything
- No Inter font as the only choice

SHADCN/UI REFERENCE: https://ui.shadcn.com/docs/components

---

## Skill: Web App Testing (Playwright)
- id: testing.webapp
- applies: auto
- keywords: playwright, web testing, e2e test, browser automation, selenium, puppeteer, web app test, ui test, screenshot test
- description: Test local web applications using Playwright with the reconnaissance-then-action pattern.

CORE UTILITY: `backend/skill_scripts/with_server.py` — manages server lifecycle for single or multiple concurrent servers.

MULTI-SERVER LAUNCH:
```bash
python backend/skill_scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

RECOMMENDED PATTERN — RECONNAISSANCE THEN ACTION:
1. `await page.wait_for_load_state('networkidle')` before any inspection (ensures dynamic content loads)
2. Capture screenshot or inspect DOM to identify correct selectors
3. Perform actions only after confirming element locations

KEY PRACTICES:
- Use `sync_playwright()` for synchronous scripts
- Always close browsers when finished (use `with` context manager)
- Prefer descriptive selectors: text content, ARIA role, CSS class, ID — in that order
- Never inspect DOM before network requests complete on dynamic apps

SELECTOR PRIORITY: `text=...` > `role=...` > `css=...` > `id=...` > `xpath=...`

---

## Skill: Spreadsheets (XLSX / CSV)
- id: docs.xlsx
- applies: auto
- keywords: xlsx, excel, spreadsheet, csv, tsv, xlsm, openpyxl, pandas, workbook, formula, financial model
- description: Open, read, edit, create, and fix spreadsheet files (.xlsx, .xlsm, .csv, .tsv).

SKIP FOR: Word docs, HTML reports, standalone scripts, database pipelines, Google Sheets API integrations.

OUTPUT REQUIREMENTS (all Excel files):
- Professional font (Arial or Times New Roman) unless instructed otherwise
- Zero formula errors: #REF!, #DIV/0!, #VALUE!, #N/A, #NAME? are mandatory failures
- When updating templates: exactly match existing format/style/conventions

FINANCIAL MODEL COLOR CODING:
- Blue text `(0,0,255)` — hardcoded inputs users change for scenarios
- Black text `(0,0,0)` — ALL formulas and calculated values
- Green text `(0,128,0)` — links from other worksheets in the same workbook
- Red text `(255,0,0)` — external links to other files
- Yellow background `(255,255,0)` — key assumptions needing attention

NUMBER FORMATTING:
- Years: text strings ("2024" not "2,024")
- Currency: `$#,##0` — always specify units in headers ("Revenue ($mm)")
- Zeros: `$#,##0;($#,##0);-` renders as "-"
- Percentages: `0.0%` | Multiples: `0.0x` | Negatives: parentheses `(123)` not `-123`

FORMULA RULES:
- ALWAYS use Excel formulas — never hardcode calculated values in Python
- Place ALL assumptions in separate cells; reference them — no magic numbers in formulas
- Document hardcodes: "Source: [System], [Date], [Reference], [URL]"

TOOLS:
- `pandas` — data analysis, bulk operations, simple CSV/XLSX export
- `openpyxl` — complex formatting, formulas, Excel-specific features (1-based cell indices)
- `data_only=True` reads calculated values but destroys formulas on save — use carefully

MANDATORY AFTER ANY FORMULA WRITING:
```bash
python backend/skill_scripts/recalc.py output.xlsx
```
Returns: `{ "status": "success"|"errors_found", "total_errors": N, "error_summary": { "#REF!": {...} } }`

