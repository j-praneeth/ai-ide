---
name: theme-factory
description: Apply a design theme (colors + fonts) to any artifact — slides, docs, HTML pages, reports. Use when asked to style, theme, or apply a color scheme to an artifact.
---

Apply consistent themes to artifacts. Theme files are in `backend/skill_scripts/themes/`.

WORKFLOW:
1. Show the user the 10 available themes (list below)
2. Ask which theme to apply (or offer to generate a custom one)
3. Wait for explicit confirmation
4. Read `backend/skill_scripts/themes/<theme-slug>.json`
5. Apply colors and fonts consistently throughout the entire artifact

10 AVAILABLE THEMES:
1. **ocean-depths** — deep blues and teals, professional maritime
2. **sunset-boulevard** — oranges, corals, golds; warm and vibrant
3. **forest-canopy** — greens and browns, natural earth tones
4. **modern-minimalist** — clean grayscale, stark and precise
5. **golden-hour** — ambers and burnt oranges, rich autumnal
6. **arctic-frost** — icy blues and whites, cool winter palette
7. **desert-rose** — mauve, sand, blush; soft and dusty
8. **tech-innovation** — electric blues on dark backgrounds, bold modern
9. **botanical-garden** — leafy greens with botanical accents, fresh organic
10. **midnight-galaxy** — deep purples and star-silver, dramatic cosmic

THEME JSON SCHEMA:
```json
{
  "name": "...", "primary": "#hex", "secondary": "#hex",
  "accent": "#hex", "background": "#hex", "surface": "#hex",
  "text": "#hex", "text_muted": "#hex",
  "heading_font": "...", "body_font": "...", "description": "..."
}
```

CUSTOM THEME: If no preset fits, generate one from the user's description, show for approval, then apply.

APPLICATION RULES:
- Apply ALL fields consistently — don't mix themes
- Heading font for titles/headers; body font for paragraphs
- Use `surface` for cards/panels, `background` for page background
- `text_muted` for captions, labels, secondary information
