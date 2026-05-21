---
name: algorithmic-art
description: Create algorithmic/generative art using p5.js with seeded randomness and interactive parameters. Use when asked to make generative art, creative coding sketches, or p5.js visualizations.
---

Build algorithmic art using p5.js. The viewer template lives at `backend/skill_scripts/templates/viewer.html` — copy it as your starting point.

PHILOSOPHY: Algorithmic expression and emergent behavior, not static images.

WORKFLOW:
1. Copy `backend/skill_scripts/templates/viewer.html` into the target directory
2. Replace ONLY the algorithm, parameters, and parameter UI — preserve branding, seed controls, download button
3. Add seeded randomness: `randomSeed(seed)` in `setup()`
4. Expose tunable `PARAMS` (at least 3) — name them for what they control aesthetically

PARAMETERS: Use sliders generated dynamically from the PARAMS object. Name them intuitively (not "param1").

SEEDED RANDOMNESS: Same seed → same output always. Let the user change seed to explore variation.

WHAT TO REPLACE in the template:
- The sketch algorithm in `draw()`
- The `PARAMS` object and its UI controls

WHAT TO PRESERVE:
- Anthropic/Nebula branding in the header
- Seed input + Randomize button
- Download PNG button
- Overall page structure and CSS
