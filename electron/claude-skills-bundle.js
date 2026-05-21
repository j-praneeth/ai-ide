'use strict';

/**
 * Bundles skills, commands, agents, and rules from the
 * awesome-claude-code-toolkit and installs them into ~/.claude/
 * so they are available to every Claude CLI session spawned by Nebula IDE.
 *
 * Installed layout:
 *   ~/.claude/commands/nebula/*.md  — slash commands (/nebula/commit, etc.)
 *   ~/.claude/agents/nebula/*.md   — sub-agent profiles
 *   ~/.claude/nebula-rules.md      — appended to global CLAUDE.md context
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Bundled Content ────────────────────────────────────────────────────────

const COMMANDS = {
  'git/commit.md': `# Generate Conventional Commit Message

Analyze staged changes and generate a conventional commit message.

## Steps
1. Run \`git diff --staged\` to inspect all staged changes
2. Identify the primary change type:
   - **feat**: new feature for the user
   - **fix**: bug fix for the user
   - **refactor**: code change that neither fixes a bug nor adds a feature
   - **docs**: documentation only changes
   - **test**: adding or updating tests
   - **chore**: maintenance (deps, config, tooling)
   - **perf**: performance improvement
   - **style**: formatting, missing semicolons (no logic change)
3. Determine scope from the primary file path or module
4. Write a concise subject line (≤72 chars, imperative mood, lowercase, no period)
5. Add a body if the "why" is non-obvious

## Format
\`\`\`
type(scope): subject

Body explaining WHY if needed (not what, the diff shows that).

BREAKING CHANGE: description (only if applicable)
\`\`\`

## Rules
- Never include generated files or lock files in the summary
- Focus on user-visible impact, not internal mechanics
- Keep the first line under 72 characters
`,

  'git/pr-review.md': `# Pull Request Review

Perform a thorough, systematic code review of the current PR.

## Process
1. \`gh pr view\` — understand context, title, description, linked issues
2. \`gh pr diff\` — read every changed line
3. \`gh pr checks\` — check CI status

## Review Dimensions
Evaluate each dimension and flag issues by severity:

- **CRITICAL** 🔴 — must fix before merge (security holes, data loss, broken logic)
- **WARNING** 🟡 — should fix (performance, error handling gaps, missing tests)
- **SUGGESTION** 🔵 — nice to have (style, naming, minor improvements)

### Dimensions
1. **Correctness** — logic matches intent, edge cases handled
2. **Security** — no injections, no secrets exposed, proper auth checks
3. **Performance** — no N+1 queries, efficient algorithms, no blocking calls
4. **Testing** — critical paths tested, mocks appropriate, coverage adequate
5. **Error Handling** — failures caught, user-facing messages appropriate
6. **Design** — single responsibility, minimal coupling, consistent patterns
7. **Naming & Readability** — self-documenting, no magic numbers
8. **Project Conventions** — matches existing code style and patterns

## Output Format
\`\`\`markdown
## PR Review: <title>

### Summary
<1-2 sentences on overall quality>

### Critical Issues
- [ ] file:line — description

### Warnings
- [ ] file:line — description

### Suggestions
- file:line — description

### Verdict
APPROVE / REQUEST_CHANGES / COMMENT
\`\`\`

Limit output to the 15 most impactful findings.
`,

  'git/changelog.md': `# Generate Changelog

Generate a changelog from git history since the last tag.

## Steps
1. Find the latest tag: \`git describe --tags --abbrev=0\`
2. List commits since that tag: \`git log <tag>..HEAD --oneline --no-merges\`
3. Parse each commit for type and scope (conventional commits format)
4. Categorize into sections:
   - **Features** (feat)
   - **Bug Fixes** (fix)
   - **Performance** (perf)
   - **Refactoring** (refactor)
   - **Documentation** (docs)
   - **Tests** (test)
   - **Chores** (chore, build, ci)
5. Determine version bump: breaking change → major, feat → minor, fix/others → patch

## Output Format (Keep a Changelog)
\`\`\`markdown
## [X.Y.Z] - YYYY-MM-DD

### Features
- Description (#PR or commit hash)

### Bug Fixes
- Description (#PR or commit hash)
\`\`\`
`,

  'git/pr-create.md': `# Create Pull Request

Create a well-structured pull request for the current branch.

## Steps
1. \`git log main..HEAD --oneline\` — review all commits in this branch
2. \`git diff main...HEAD\` — inspect all changes
3. Identify: what changed, why it changed, how it was tested
4. Write PR title: ≤70 chars, imperative mood (e.g., "Add user authentication flow")
5. Write PR body using the template below
6. \`gh pr create\`

## PR Body Template
\`\`\`markdown
## Summary
- <bullet: what and why>
- <bullet: key design decision if non-obvious>

## Changes
- **area**: description of change

## Test Plan
- [ ] Unit tests pass
- [ ] Manual test: <specific scenario>
- [ ] Edge case: <specific scenario>

## Related
Closes #<issue>
\`\`\`
`,

  'workflow/tdd.md': `# Test-Driven Development

Write failing tests first, then make them pass.

## Red-Green-Refactor Cycle
1. **Red** — write the smallest test that fails for the feature you want
2. **Green** — write the minimal code to make the test pass (no over-engineering)
3. **Refactor** — clean up while keeping tests green

## Test Pyramid
- **Unit (70%)**: pure functions, business logic, fast, no I/O
- **Integration (20%)**: service interactions, database, APIs
- **E2E (10%)**: critical user flows only

## What to Test
- Public interfaces, not implementation details
- Behaviour, not code structure
- Edge cases: empty input, boundary values, error paths

## Naming Convention
\`\`\`
should_<expected_behaviour>_when_<condition>
\`\`\`

## Coverage Targets
- Line coverage: ≥ 80%
- Branch coverage: ≥ 75%
- Never skip tests to meet deadlines — add a \`skip\` comment explaining why
`,

  'workflow/security-review.md': `# Security Review

Audit the current changeset or codebase for security issues.

## Checklist

### Input Validation
- [ ] All user inputs validated with schema (Zod/Pydantic/Joi)
- [ ] File paths validated against traversal (no \`..\` segments)
- [ ] Query parameters sanitised before DB use

### Authentication & Authorization
- [ ] Every protected route checks authentication
- [ ] Every protected route checks authorization (RBAC)
- [ ] Tokens are short-lived (access ≤15min, refresh ≤30 days)
- [ ] Passwords hashed with bcrypt (cost≥12) or argon2

### Data Handling
- [ ] No secrets or PII in logs
- [ ] No secrets in source code (use env vars / secrets manager)
- [ ] Parameterized queries everywhere (no string concatenation)
- [ ] Sensitive fields excluded from API responses

### HTTP Security
- [ ] CSP header configured
- [ ] HSTS enabled for production
- [ ] Cookies: HttpOnly + Secure + SameSite=Strict
- [ ] CORS restricted to known origins

### Dependencies
- [ ] \`npm audit\` / \`pip-audit\` clean
- [ ] No packages with known critical CVEs
- [ ] License compatibility verified

## Report Format
List each finding as: **[SEVERITY]** file:line — description — recommended fix
`,

  'workflow/api-design.md': `# API Design Review & Implementation

Design or review an API following REST best practices.

## Resource Naming
- Plural nouns: \`/users\`, \`/orders\`, \`/products\`
- Nest at most one level: \`/users/{id}/orders\` ✓
- Avoid verbs in paths — use HTTP methods instead

## HTTP Methods
| Method | Usage | Success Code |
|--------|-------|-------------|
| GET    | Retrieve | 200 |
| POST   | Create | 201 + Location header |
| PUT    | Replace | 200 |
| PATCH  | Partial update | 200 |
| DELETE | Remove | 204 |

## Response Envelope
\`\`\`json
{
  "data": { ... },
  "meta": { "total": 100, "page": 1 },
  "error": null
}
\`\`\`

## Versioning
- URL path versioning for public APIs: \`/v1/\`
- Version in header for internal APIs

## Pagination
- Cursor-based for large / real-time datasets
- Offset for admin/simple lists
- Always include \`next\` cursor or \`hasMore\` flag

## Error Responses
\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "fields": { "email": "Invalid format" }
  }
}
\`\`\`

## Rate Limiting
- Return \`429\` with \`Retry-After\` header
- Include \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\` headers
`,
};

const AGENTS = {
  'nebula/backend-developer.md': `---
name: backend-developer
description: Senior Node.js backend developer. Use for API design, service architecture, database schemas, and backend bug fixes.
---

You are a senior backend engineer specialising in Node.js (Fastify preferred, Express acceptable). You prioritise correctness, observability, and maintainable service architecture.

## Principles
- Validate all inputs at the boundary with Zod schemas
- Use \`AppError\` base class to separate operational errors from programmer errors
- Return structured errors with a machine-readable \`code\` field
- Log with structured JSON (timestamp, level, requestId, traceId)
- Every external call has a timeout; every retry uses exponential backoff

## Database
- Use Prisma or Drizzle ORM with explicit repository patterns
- Always use parameterised queries — never interpolate user input
- Add indexes on columns used in WHERE, JOIN, and ORDER BY clauses
- Connection pool baseline: (2 × CPU cores) + disk spindle count

## Performance
- HTTP keep-alive enabled
- Stream large payloads — never buffer entire response bodies
- Cache expensive reads in Redis with a defined TTL and invalidation strategy
- Detect and eliminate N+1 query patterns before shipping

## Before Completing
- Run test suite
- TypeScript compilation passes (\`tsc --noEmit\`)
- Linting clean
- Server starts without errors
`,

  'nebula/frontend-architect.md': `---
name: frontend-architect
description: Senior React/Next.js frontend architect. Use for component design, state management, performance optimisation, and accessibility.
---

You are a senior frontend architect specialising in React 18+ and Next.js 14+. You default to Server Components and reach for \`'use client'\` only when genuinely necessary.

## Stack
- Next.js 14+ App Router, React 18+ Server Components
- Tailwind CSS for styling
- TanStack Query (React Query) for server state
- Zustand for client-only global state
- React Hook Form + Zod for forms

## Component Rules
- Max component size: 150 lines; split if larger
- Hierarchy: page → layout → feature → UI primitive
- No \`useEffect\` for initial data — fetch in Server Components
- Memoize sparingly; profile before adding \`useMemo\`/\`useCallback\`

## Performance Targets (Core Web Vitals)
- LCP < 2.5s, FID < 100ms, CLS < 0.1
- Lazy-load routes and heavy components
- Images via \`next/image\` with explicit \`width\`/\`height\`
- Bundle chunks ≤ 200 KB gzipped

## Accessibility
- Semantic HTML first
- ARIA labels only when semantic HTML is insufficient
- Keyboard navigation tested
- Colour contrast ≥ 4.5:1 (WCAG AA)

## Before Completing
- TypeScript compilation passes
- Lighthouse score ≥ 90 on mobile
- Keyboard navigation works end-to-end
- Responsive at 320px and 1440px
`,

  'nebula/fullstack-engineer.md': `---
name: fullstack-engineer
description: Full-stack engineer (React + Node.js). Use for end-to-end feature implementation spanning frontend and backend.
---

You are a full-stack engineer proficient in React 18+ / Next.js 14+ on the frontend and Node.js (Express / Fastify / Next.js API routes) on the backend.

## Methodology
1. Understand requirements and acceptance criteria
2. Design the data model and API contract first
3. Build backend (schema validation → service → route)
4. Build frontend (types → state → UI → connect to API)
5. Wire up with React Query / TanStack Query for server state

## Stack
- Frontend: React 18+, Next.js 14+, TypeScript, Tailwind, TanStack Query
- Backend: Node.js, Zod input validation, Prisma/Drizzle ORM
- Auth: JWT (15min access + 30day refresh) or NextAuth.js
- Cache: Redis
- DB: PostgreSQL

## Quality Gates
- Handle loading / error / empty / success states in every async UI
- All API inputs validated with Zod on the server
- Database migrations are reversible
- Auth flows tested: login, logout, expired token, forbidden resource
`,

  'nebula/security-engineer.md': `---
name: security-engineer
description: Application security specialist. Use for security reviews, threat modelling, auth implementation, and fixing vulnerabilities.
---

You are an application security engineer. You think like an attacker but build like a defender.

## Threat Modelling Approach
1. Identify assets (data, functionality, credentials)
2. Identify trust boundaries
3. Enumerate threats per boundary (STRIDE: Spoofing, Tampering, Repudiation, Info Disclosure, DoS, Elevation)
4. Propose mitigations ordered by risk × effort

## Must-Have Controls
- Input validation with schema libraries (Zod, Pydantic, Joi) at every boundary
- Parameterised queries — zero tolerance for string interpolation in SQL
- Secrets in env vars or a secrets manager; never in source code
- Passwords: bcrypt (cost ≥ 12) or argon2id
- Tokens: short-lived JWTs (≤ 15min access), rotate refresh tokens on use
- HTTP headers: CSP, HSTS, X-Content-Type-Options, X-Frame-Options
- Cookies: HttpOnly + Secure + SameSite=Strict
- Rate limiting on auth endpoints (fail2ban equivalent)

## Dependency Management
- Run \`npm audit\` / \`pip-audit\` in CI; fail on critical severity
- Critical CVEs: fix within 24h
- High CVEs: fix within 7 days

## Reporting Format
For each finding: **[CRITICAL|HIGH|MEDIUM|LOW]** location — description — CVSS-like impact — remediation
`,

  'nebula/devops-engineer.md': `---
name: devops-engineer
description: DevOps / platform engineer. Use for CI/CD pipelines, Docker, Kubernetes, infrastructure automation, and incident response.
---

You are a senior DevOps / platform engineer. You optimise for reliability, reproducibility, and fast feedback loops.

## CI/CD Principles
- Every PR runs: lint → type-check → unit tests → integration tests → build
- Fail fast: put the cheapest checks first
- Cache aggressively: dependencies, build artifacts, Docker layers
- Never commit secrets; use GitHub Actions secrets or Vault

## Docker
- Multi-stage builds to minimise final image size
- Run as non-root user
- Pin base image to a specific digest, not \`latest\`
- \`.dockerignore\` excludes \`node_modules\`, \`.git\`, test files
- Health check in every Dockerfile

## Kubernetes
- Requests and limits set on every container
- Liveness + readiness probes on every deployment
- HPA at 70% CPU / 80% memory
- PodDisruptionBudget for critical services
- Never store secrets in ConfigMaps — use Kubernetes Secrets or external-secrets-operator

## Observability Stack
- Metrics: Prometheus + Grafana (RED: Rate, Errors, Duration)
- Logs: structured JSON → Loki or ELK
- Traces: OpenTelemetry → Jaeger or Tempo
- Alert on P95/P99 latency, not averages

## Incident Response
1. Mitigate first (rollback, feature flag off, scale up)
2. Communicate status to stakeholders
3. Collect evidence (logs, metrics, traces) before cleanup
4. Root cause analysis within 48h
5. Blameless post-mortem with action items
`,
};

const GLOBAL_RULES = `
# Nebula IDE — Global Development Rules

These rules apply to all code written in this project.

## Code Quality
- Fix root causes; avoid broad rewrites
- Functions: max 40 lines, max 3 parameters (use options object for more)
- Files: max 300 lines; one exported concept per file
- No magic numbers — extract named constants
- Boolean variable prefixes: \`is\`, \`has\`, \`can\`, \`should\`

## Security (Non-Negotiable)
- No secrets or API keys in source code — use environment variables
- Parameterized queries only — zero SQL string interpolation
- Validate all user inputs at the boundary (Zod / Pydantic / Joi)
- Passwords: bcrypt cost ≥ 12 or argon2
- JWT access tokens ≤ 15min; rotate refresh tokens on use

## Testing
- Minimum 80% line coverage, 75% branch coverage
- Test behaviour, not implementation details
- One assertion per logical behaviour
- Mirror source directory structure in tests
- No \`skip\`/\`todo\` tests in main branch without a comment explaining why

## Git Workflow
- Conventional commits: \`type(scope): subject\` — imperative, lowercase, ≤72 chars
- Feature branches: \`feature/\`, \`fix/\`, \`refactor/\`, \`docs/\` prefixes
- PRs: one logical change, diff ≤ 400 lines
- Never force push to main or shared branches

## API Design
- Plural resource nouns: \`/users\`, \`/orders\`
- Nest resources at most one level deep
- Response envelope: \`{ data, meta, error }\`
- URL path versioning for public APIs: \`/v1/\`
- Return \`429\` with \`Retry-After\` header for rate limits

## Performance
- Profile before optimising — establish budgets first
- Lazy-load routes and heavy components
- Cursor-based pagination for large / real-time datasets
- Indexes on WHERE, JOIN, ORDER BY columns
- Avoid N+1 queries — use eager loading or DataLoaders
`;

// ─── Skills Installation ─────────────────────────────────────────────────────

/**
 * Resolve the directory containing the bundled .claude/skills/ folders.
 * - Packaged app  → resources/claude-skills/  (extraResources target)
 * - Dev / source  → <project-root>/.claude/skills/
 */
function _getSkillsSourceDir() {
  // In a packaged Electron app process.resourcesPath points to the resources/
  // directory next to the asar. The extraResources rule copies .claude/skills/
  // there as 'claude-skills/'.
  const packed = path.join(process.resourcesPath || '', 'claude-skills');
  if (fs.existsSync(packed)) return packed;
  // Dev: __dirname is electron/, one level up is the project root.
  return path.join(__dirname, '..', '.claude', 'skills');
}

/** Recursively copy src dir into dest, returning counts. */
function _copyDirSync(src, dest, force) {
  fs.mkdirSync(dest, { recursive: true });
  let installed = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = _copyDirSync(srcPath, destPath, force);
      installed += sub.installed;
      skipped += sub.skipped;
    } else {
      if (!force && fs.existsSync(destPath)) { skipped++; continue; }
      fs.copyFileSync(srcPath, destPath);
      installed++;
    }
  }
  return { installed, skipped };
}

/**
 * Copy all skill folders from the app bundle into ~/.claude/skills/ so they
 * are available globally in every Claude Code project on this machine.
 */
async function installNebulaSkills({ force, log }) {
  const srcDir = _getSkillsSourceDir();
  if (!fs.existsSync(srcDir)) {
    log(`[claude-skills] Skills source not found at: ${srcDir} — skipping`);
    return { installed: 0, skipped: 0 };
  }

  const destSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  fs.mkdirSync(destSkillsDir, { recursive: true });

  let installed = 0;
  let skipped = 0;

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const counts = _copyDirSync(
      path.join(srcDir, entry.name),
      path.join(destSkillsDir, entry.name),
      force,
    );
    installed += counts.installed;
    skipped += counts.skipped;
  }

  log(`[claude-skills] Skills: installed ${installed} files, ${skipped} already up-to-date`);
  return { installed, skipped };
}

// ─── Installation Logic ──────────────────────────────────────────────────────

const NEBULA_MARKER = '<!-- nebula-toolkit-installed -->';

/**
 * Install bundled skills into ~/.claude/
 * Safe to call multiple times — uses a marker to skip already-installed files.
 */
async function installClaudeSkills(opts = {}) {
  const { force = false, log = console.log } = opts;
  const homeDir = os.homedir();
  const claudeDir = path.join(homeDir, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  const agentsDir = path.join(claudeDir, 'agents');

  try {
    // Ensure directories exist
    fs.mkdirSync(path.join(commandsDir, 'git'), { recursive: true });
    fs.mkdirSync(path.join(commandsDir, 'workflow'), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, 'nebula'), { recursive: true });

    let installed = 0;
    let skipped = 0;

    // Install commands
    for (const [relPath, content] of Object.entries(COMMANDS)) {
      const dest = path.join(commandsDir, relPath);
      if (!force && fs.existsSync(dest)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf-8');
      installed++;
    }

    // Install agents
    for (const [relPath, content] of Object.entries(AGENTS)) {
      const dest = path.join(agentsDir, relPath.replace('nebula/', ''));
      if (!force && fs.existsSync(dest)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf-8');
      installed++;
    }

    // Append global rules to ~/.claude/CLAUDE.md (once, marked)
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    let claudeMdContent = '';
    try {
      if (fs.existsSync(claudeMdPath)) {
        claudeMdContent = fs.readFileSync(claudeMdPath, 'utf-8');
      }
    } catch (_) {}

    if (force || !claudeMdContent.includes(NEBULA_MARKER)) {
      // Remove old nebula section if force-reinstalling
      if (force && claudeMdContent.includes(NEBULA_MARKER)) {
        const markerIdx = claudeMdContent.indexOf(NEBULA_MARKER);
        claudeMdContent = claudeMdContent.slice(0, markerIdx).trimEnd();
      }
      const newContent = (claudeMdContent ? claudeMdContent + '\n\n' : '') +
        NEBULA_MARKER + '\n' + GLOBAL_RULES;
      fs.writeFileSync(claudeMdPath, newContent, 'utf-8');
      installed++;
    } else {
      skipped++;
    }

    // Install bundled skills into ~/.claude/skills/
    const skillsCounts = await installNebulaSkills({ force, log });
    installed += skillsCounts.installed;
    skipped += skillsCounts.skipped;

    log(`[claude-skills] Installed ${installed} skill files (${skipped} already up-to-date)`);
    return { ok: true, installed, skipped };
  } catch (e) {
    log(`[claude-skills] Installation failed: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

/**
 * Check whether the skills have already been installed in this session.
 * Uses a lightweight marker-file check to avoid repeated disk writes on startup.
 */
function areSkillsInstalled() {
  try {
    const markerPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    if (!fs.existsSync(markerPath)) return false;
    const content = fs.readFileSync(markerPath, 'utf-8');
    return content.includes(NEBULA_MARKER);
  } catch (_) {
    return false;
  }
}

module.exports = { installClaudeSkills, areSkillsInstalled };
