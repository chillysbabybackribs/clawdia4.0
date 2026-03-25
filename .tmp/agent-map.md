# Agent Directory Map — Top 10 Files by Importance

Ranked by commit frequency (proxy for criticality) + structural role.
Generated: 2026-03-24

---

| # | File | Lines | Commits | Summary |
|---|------|-------|---------|---------|
| 1 | `loop.ts` | 1377 | 20 | **Central orchestrator** — drives the full classify → prompt → LLM → dispatch → recover cycle and ties together every loop sub-module. |
| 2 | `prompt-builder.ts` | 178 | 12 | Assembles the system prompt at runtime by loading and merging CORE.md, tool-group CONTEXT.md, and per-task prompt modules into a single cached string. |
| 3 | `tool-builder.ts` | 699 | 10 | Defines all Anthropic tool JSON schemas for every group (core / browser / full) and exposes `executeTool` / `filterTools` used by the dispatch layer. |
| 4 | `executors/browser-executors.ts` | 411 | 6 | Implements every browser tool (navigate, search, click, type, extract, screenshot, tabs, eval, harness) by delegating to the BrowserView manager. |
| 5 | `classifier.ts` | 143 | 8 | Zero-cost, zero-latency regex classifier that maps each user message to a `TaskProfile` (tool group, prompt modules, model tier) before any LLM call. |
| 6 | `loop-setup.ts` | 299 | 7 | Pre-LLM parallel setup phase — concurrently fetches memory context, conversation recall, site playbooks, desktop capabilities, and harness routing. |
| 7 | `loop-dispatch.ts` | 682 | 6 | Parallel tool dispatch engine — batches LLM tool-use blocks, enforces sequential ordering for GUI/shell tools, and handles mid-loop escalation and verification. |
| 8 | `loop-harness.ts` | 285 | 6 | Runs the nested CLI-Anything harness-generation pipeline (max 40 iterations, 12 min) that reverse-engineers app interfaces and writes reusable playbooks. |
| 9 | `executors/core-executors.ts` | 5 | 6 | Re-export barrel for all core executor sub-modules (`shell`, `file`, `calendar`, `fs-*`); acts as the single import point for the dispatch layer. |
| 10 | `executors/desktop-executors.ts` | 5 | 10 | Re-export barrel for the `./desktop/` sub-modules (GUI interaction, app control, D-Bus, a11y, screenshot analysis); mirrors the pattern of core-executors. |

---

### Notes
- Commit counts sourced from `git log --name-only` across the full repo history.
- `core-executors.ts` and `desktop-executors.ts` are thin barrels (5 lines each) but score high because changes in their sub-modules flow through them; importance reflects their structural centrality.
- Related high-value files not in the top 10: `provider/anthropic-adapter.ts` (LLM streaming), `loop-recovery.ts` (post-loop file verification), `policy-engine.ts` (spend/safety guards), `approval-manager.ts` (human-in-the-loop gating).
