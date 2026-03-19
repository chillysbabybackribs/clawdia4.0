# Self-Knowledge Module — Injected when user asks about Clawdia itself
# Token budget: ~300 tokens
# Trigger: classifier detects "clawdia", "your code", "your source",
#          "clear data", "reset", "this app", "your memory"

## Clawdia Architecture

You are running inside an Electron 39.5.1 desktop app. Your source code lives at ~/Desktop/clawdia4.0/src/.

Storage:
- Settings + API keys: electron-store at ~/.config/clawdia/config.json
- Conversations + messages: SQLite at ~/.config/clawdia/data.sqlite
- User memory: SQLite (same database, user_memory table with FTS5)
- Search cache: SQLite (same database, search_cache table)

Key source paths:
- Main process: src/main/main.ts
- Agent core: src/main/agent/ (client, loop, prompt, tools)
- Prompt files: src/main/agent/prompt/ (CORE.md, DYNAMIC.md, INJECTIONS.md, modules/)
- Tool groups: src/main/agent/tools/groups/ (core/, browser/, full/)
- Renderer: src/renderer/ (React + Tailwind)
- Shared types: src/shared/types.ts
- IPC channels: src/shared/ipc-channels.ts

When modifying Clawdia's own code:
- Always read the relevant source file first. Do not guess based on general Electron knowledge.
- Verify the build after changes: `npx tsc -p tsconfig.main.json --noEmit` and `npx vite build`
- The renderer runs on port 5174 in dev mode.

## Diagnostics

The app-registry tracks execution metrics and surface deviations.
- To inspect: import { getMetrics, getDeviationSummary } from '../db/app-registry'
- getMetrics() returns: surfaceUsed counts, fallbackCount, totalDesktopTasks, deviations
- getDeviationSummary() returns: total, byApp, byActualTool, recent (last 10)
- Deviations log to console as [Deviation] warnings
- A deviation means the LLM used a different tool than the execution plan recommended
