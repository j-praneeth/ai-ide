#!/usr/bin/env bash
# init-artifact.sh — scaffold a React + TypeScript + Vite + Tailwind CSS 3.4.1 + shadcn/ui project
# Usage: bash init-artifact.sh <project-name>
#
# What this script does:
#   1. Creates the project directory with Vite + React + TypeScript template
#   2. Installs Tailwind CSS 3.4.1, PostCSS, Autoprefixer
#   3. Installs shadcn/ui primitives and Radix UI components
#   4. Installs Parcel for single-file artifact bundling
#   5. Writes tailwind.config.js, src/index.css, and parcel.config.json
#   6. Prints next-step instructions

set -euo pipefail

# ── Argument validation ──────────────────────────────────────────────────────
if [[ -z "${1:-}" ]]; then
  echo "Error: project name is required." >&2
  echo "Usage: bash init-artifact.sh <project-name>" >&2
  exit 1
fi

PROJECT_NAME="$1"

if [[ -d "$PROJECT_NAME" ]]; then
  echo "Error: directory '$PROJECT_NAME' already exists." >&2
  exit 1
fi

echo "→ Scaffolding '$PROJECT_NAME' ..."

# ── Step 1: Vite scaffold ────────────────────────────────────────────────────
npm create vite@latest "$PROJECT_NAME" -- --template react-ts

cd "$PROJECT_NAME"

# ── Step 2: Tailwind CSS 3.4.1 + PostCSS + Autoprefixer ─────────────────────
echo "→ Installing Tailwind CSS 3.4.1 ..."
npm install -D tailwindcss@3.4.1 postcss autoprefixer

# ── Step 3: shadcn/ui runtime dependencies ───────────────────────────────────
echo "→ Installing shadcn/ui dependencies ..."
npm install \
  @radix-ui/react-slot \
  class-variance-authority \
  clsx \
  tailwind-merge \
  lucide-react \
  @radix-ui/react-dialog \
  @radix-ui/react-dropdown-menu \
  @radix-ui/react-label \
  @radix-ui/react-select \
  @radix-ui/react-separator \
  @radix-ui/react-tabs \
  @radix-ui/react-toast

# ── Step 4: Parcel for single-file bundling ──────────────────────────────────
echo "→ Installing Parcel ..."
npm install -D parcel

# ── Step 5: Initialize Tailwind config ───────────────────────────────────────
echo "→ Initializing Tailwind ..."
npx tailwindcss init -p

# ── Step 6: Write tailwind.config.js ─────────────────────────────────────────
cat > tailwind.config.js << 'TAILWIND_EOF'
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border:      "hsl(var(--border))",
        input:       "hsl(var(--input))",
        ring:        "hsl(var(--ring))",
        background:  "hsl(var(--background))",
        foreground:  "hsl(var(--foreground))",
        primary: {
          DEFAULT:    "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT:    "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT:    "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT:    "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
TAILWIND_EOF

# ── Step 7: Write src/index.css with Tailwind directives ─────────────────────
cat > src/index.css << 'CSS_EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background:   0 0% 100%;
    --foreground:   222.2 84% 4.9%;
    --border:       214.3 31.8% 91.4%;
    --input:        214.3 31.8% 91.4%;
    --ring:         222.2 84% 4.9%;
    --primary:      222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary:    210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted:        210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent:       210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --radius:       0.5rem;
  }

  .dark {
    --background:   222.2 84% 4.9%;
    --foreground:   210 40% 98%;
    --border:       217.2 32.6% 17.5%;
    --input:        217.2 32.6% 17.5%;
    --ring:         212.7 26.8% 83.9%;
    --primary:      210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary:    217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted:        217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent:       217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
  }
}

@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground; }
}
CSS_EOF

# ── Step 8: Write parcel.config.json ─────────────────────────────────────────
cat > parcel.config.json << 'PARCEL_EOF'
{
  "extends": "@parcel/config-default",
  "bundler": "@parcel/bundler-default",
  "transformers": {
    "*.{js,jsx,ts,tsx}": ["@parcel/transformer-js"]
  },
  "packagers": {
    "*.html": "@parcel/packager-html",
    "*.{js,jsx}": "@parcel/packager-js",
    "*.css": "@parcel/packager-css"
  },
  "optimizers": {
    "*.{js,jsx}": ["@parcel/optimizer-swc"],
    "*.css":      ["@parcel/optimizer-css"]
  }
}
PARCEL_EOF

# ── Step 9: Create scripts directory and placeholder ─────────────────────────
mkdir -p scripts

echo "→ Done."
echo ""
echo "Project $PROJECT_NAME ready."
echo "Edit src/App.tsx then run: bash scripts/bundle-artifact.sh"
