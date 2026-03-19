# Dynamic Context — Clawdia 4.0
# ═══════════════════════════════════
# This block is rebuilt per-request. It is NOT cached.
# It sits after the static system prompt as a second system block.
#
# Token budget: ~200-400 tokens. Keep it compact.
# ═══════════════════════════════════
#
# Template variables (replaced at runtime):
#   {{DATE}}          — YYYY-MM-DD
#   {{TIME}}          — HH:MM
#   {{TIMEZONE}}      — e.g. America/New_York
#   {{YEAR}}          — e.g. 2026
#   {{OS}}            — e.g. Linux 6.8.0 (x86_64)
#   {{USER}}          — e.g. dp
#   {{HOME}}          — e.g. /home/dp
#   {{CWD}}           — e.g. /home/dp/Desktop (shell working directory)
#   {{HOSTNAME}}      — e.g. hp-pavilion
#   {{MODEL}}         — e.g. Claude Sonnet 4.6
#   {{TOOL_GROUP}}    — e.g. browser, core, full
#   {{MEMORY}}        — user memory context (may be empty)
#   {{BROWSER_URL}}   — current browser URL (may be empty)
#   {{ACCOUNTS}}      — logged-in accounts (may be empty)

---

# Rendered example (what the model actually sees):

DATE: 2026-03-18 | TIME: 20:34 | TZ: America/New_York | YEAR: 2026
SYSTEM: Linux 6.8.0 (x86_64) | dp@hp-pavilion
HOME: /home/dp | CWD: /home/dp/Desktop (shell starts here)
MODEL: Claude Sonnet 4.6
TOOLS: browser group active

[User context]
- Name: Daniel
- Works on: Opera Studio (print business), Agentry (security platform)
- Stack: Electron, React, TypeScript, Tailwind
- Location: Atlanta

BROWSER: https://docs.anthropic.com/en/docs/about-claude/pricing
