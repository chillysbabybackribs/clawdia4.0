# Clawdia 4.0 — Repository Summary

## Overview
Clawdia is an AI-powered desktop workspace application (Electron + React/TypeScript) that gives a local AI agent full system access — browser automation, filesystem control, shell execution, and task orchestration — all running within the user's authenticated desktop environment.

## Architecture

### Main Process (`src/main/`)
The Node/Electron backend is organized into four major subsystems:

- **`agent/`** — Core agent loop and orchestration. `loop.ts` drives the iterative tool-dispatch cycle (up to 50 iterations), `loop-recovery.ts` handles post-run artifact verification, `task-compiler.ts` decomposes user tasks into structured execution graphs, and `executor-registry.ts` routes tasks to specialized executors (browser, filesystem, swarm workers, etc.). The `bloodhound/` subdir implements deep research; `executors/` holds specialized workers; `tools/` defines every tool available to the model.

- **`browser/`** — Headless Chromium session management via Electron's debugger API. Provides DOM snapshots, native input injection (`native-input.ts`), site-harness replay (`site-harness.ts`), and batched browser operations.

- **`db/`** — SQLite persistence layer covering conversations, run events, artifacts, memory, spending budgets, site profiles, playbooks, and audit telemetry.

- **`autonomy/`** — Background autonomy features: calendar-driven proactive detection, email monitoring, task scheduling, login interception, and session discovery.

### Renderer Process (`src/renderer/`)
A Vite/React frontend presenting a split-panel UI: chat panel, embedded browser panel, swarm panel (sub-agent visualization), sidebar with conversations/calendar/settings, and a terminal log strip for live tool activity.

### Shared (`src/shared/`)
Cross-process IPC channel definitions, model registry, and shared TypeScript types.

## Key Capabilities
1. **Agentic browser control** — navigates, fills forms, extracts content, and replays saved harnesses inside the user's live authenticated sessions.
2. **Filesystem & shell operator** — reads, writes, reorganizes files; runs shell commands; manages builds and processes.
3. **Multi-agent swarm** — spawns parallel sub-agent workers (filesystem, browser, research) coordinated by the graph executor.
4. **Memory & recall** — persists conversation context, site profiles, playbooks, and user preferences across sessions.
5. **Recovery loop** — after each run, verifies expected output artifacts exist and are well-formed; re-attempts if missing.
6. **Policy & spending controls** — enforces per-run approval gates, spending budgets, and a policy engine for sensitive actions.

## Tech Stack
- **Runtime:** Electron (Node ≥ 20), TypeScript, React 18, Vite
- **Storage:** SQLite via `better-sqlite3`
- **AI:** Anthropic Claude (configurable model), streamed via `@anthropic-ai/sdk`
- **Package:** `clawdia` v4.0.0, MIT license, authored by Daniel Parker
