---
name: web-artifacts-builder
description: Build complex multi-component claude.ai HTML artifacts with React 18, TypeScript, Tailwind CSS 3.4.1, and shadcn/ui. Use for artifacts requiring state management, routing, or component libraries. Do NOT use for simple single-file HTML/JSX.
---

Build self-contained HTML artifacts with a full React stack.

STACK: React 18 + TypeScript + Vite + Parcel (bundling) + Tailwind CSS 3.4.1 + shadcn/ui

5-STEP WORKFLOW:
```bash
# 1. Scaffold the project
bash backend/skill_scripts/init-artifact.sh my-artifact

# 2. Develop — edit src/App.tsx and add components

# 3. Bundle into a single HTML file
cd my-artifact && bash ../backend/skill_scripts/bundle-artifact.sh

# 4. Share bundle.html as the artifact
# 5. (Optional) Test with webapp-testing skill
```

DESIGN RULES — avoid "AI slop":
- No excessive centered layouts
- No default purple/blue gradients
- No uniform `rounded-lg` on everything
- No Inter as the only font choice
- Pick a visual direction and commit to it

SHADCN/UI COMPONENTS available after init:
Dialog, DropdownMenu, Label, Select, Separator, Tabs, Toast, Button (via Slot)
Full reference: https://ui.shadcn.com/docs/components

TAILWIND CSS 3.4.1 — use JIT classes directly in JSX. Config is in `tailwind.config.js`.

TYPESCRIPT: All components should be typed. Use `interface` for props, `type` for unions.

BUNDLING: `bundle-artifact.sh` runs Vite build then inlines all JS/CSS into a single `bundle.html`. Share that file.
