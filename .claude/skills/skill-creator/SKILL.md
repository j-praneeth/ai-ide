---
name: skill-creator
description: Create new Claude Code skills with proper structure, SKILL.md format, and supporting files. Use when asked to create a new skill, add a skill, or package reusable instructions as a skill.
---

Create well-formed Claude Code skills.

SKILL DIRECTORY STRUCTURE:
```
.claude/skills/<skill-name>/
  SKILL.md          ← frontmatter + instructions (required)
  reference/        ← reference docs the skill cites
  examples/         ← example inputs/outputs
  scripts/          ← helper scripts
  templates/        ← starter templates
```

SKILL.MD FORMAT:
```
---
name: <slug>          (kebab-case, matches directory name)
description: <one-line — used to decide when to trigger>
---

<instructions for the agent>
```

GOOD SKILL DESIGN:
- **Narrow trigger**: say exactly WHEN the skill applies AND when to skip it
- **Self-contained**: all needed knowledge inline — no "see the docs"
- **Action-oriented**: tell the agent what to DO, not just what to know
- **Include gotchas**: non-obvious failure modes that cost time

DESCRIPTION FIELD (most important):
- Written as a trigger condition: "Use when asked to..."
- Include negative cases: "Do NOT trigger for..."
- One sentence max — this is what determines auto-selection

AFTER CREATING THE SKILL:
1. Test it by invoking `/skills` to confirm it appears
2. Verify the description triggers correctly on relevant prompts
3. Add to the project's Skills.md if it should also inject into the Nebula IDE AI agent
