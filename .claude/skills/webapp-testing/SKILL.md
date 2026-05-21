---
name: webapp-testing
description: Test local web applications using Playwright with the reconnaissance-then-action pattern. Use when asked to test a web app, automate browser interactions, take screenshots of a running app, or write E2E tests.
---

Test web apps using Playwright. Multi-server launcher is at `backend/skill_scripts/with_server.py`.

MULTI-SERVER LAUNCH:
```bash
python backend/skill_scripts/with_server.py \
  --server "cd backend && python server.py" --port 8000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_test.py
```

PLAYWRIGHT PATTERN — reconnaissance then action:
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto("http://localhost:5173")

    # 1. RECONNOITRE — wait for load, then inspect
    page.wait_for_load_state("networkidle")
    page.screenshot(path="01-loaded.png")

    # 2. ACT — use what you found
    page.click("text=Login")
    page.fill('[placeholder="Email"]', "test@example.com")
    page.screenshot(path="02-after-login.png")

    browser.close()
```

KEY PRACTICES:
- Always `wait_for_load_state("networkidle")` before inspecting dynamic apps
- Take a screenshot first — see what's actually rendered before clicking
- Selector priority: `text=` > `role=` > `css=` > `id=` > `xpath=`
- Always close the browser (`with` context manager handles this)

INSTALL: `pip install playwright && playwright install chromium`

COMMON SELECTORS:
- `page.click("text=Submit")` — by visible text
- `page.click('[role="button"][aria-label="Close"]')` — by ARIA
- `page.fill('input[name="email"]', value)` — form fields
- `page.locator(".my-class").first.click()` — CSS + index
