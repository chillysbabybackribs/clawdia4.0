# Clawdia 4.0 — Repository Summary

> **AI desktop workspace — browser, code, and task automation.**
> Author: Daniel Parker | License: MIT | Version: 4.0.0

---

## Overview

Clawdia is an Electron-based desktop AI operator that bundles a persistent bash shell, a live browser panel (sharing the user's real session cookies), full filesystem access, and a multi-agent swarm engine — all unified in a single desktop application. The agent can read/write files, execute shell commands, browse authenticated sites, control GUI apps, manage a calendar, and spawn parallel worker agents to tackle complex tasks.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Shell / Runtime | Node.js ≥ 20, Electron 39 |
| UI Framework | React 19, TypeScript, Vite, Tailwind CSS |
| AI Providers | Anthropic (Claude), OpenAI (GPT), Google Gemini |
| Database | SQLite via `better-sqlite3` |
| Testing | Vitest |
| Build | `tsc` + Vite; `electron-builder` for packaging |

---

## Directory Structure

```
clawdia4.0/
├── src/
│   ├── main/             # Electron main process
│   │   ├── agent/        # Core agentic engine
│   │   ├── browser/      # Browser panel management
│   │   ├── db/           # SQLite data layer
│   │   ├── main.ts       # Electron entry point
│   │   ├── preload.ts    # IPC bridge
│   │   └── store.ts      # Persistent settings
│   ├── renderer/         # React UI (chat, browser panel, sidebar)
│   └── shared/           # Types, model registry, IPC channels
├── tests/                # Vitest test suites
├── docs/                 # Design docs, audit notes, superpowers plans
└── scripts/              # clawdia-cal and other CLI utilities
```

---

## Core Subsystems

### 1. Agent Loop (`src/main/agent/loop.ts` — ~1270 lines)

The orchestrator for every user request. Phases:

1. **Classify** (`classifier.ts`) — Pure regex dispatch, zero LLM cost. Routes to one of three tool groups (`core`, `browser`, `full`) and a model tier (`haiku`, `sonnet`, `opus`).
2. **Pre-LLM setup** (`loop-setup.ts`) — Parallel: load memory, recall past conversations, compute desktop routing.
3. **Prompt build** (`prompt-builder.ts`) — Assembles static system prompt + dynamic context module (calendar, authenticated sites, playbooks).
4. **LLM call** — Streaming via provider adapter.
5. **Tool dispatch** (`loop-dispatch.ts`) — Parallel tool execution with batching and escalation.
6. **Recovery** (`loop-recovery.ts`) — Post-loop file verification; triggers a recovery iteration if written files are missing or malformed.
7. **Repeat** up to 50 iterations / 10 minutes wall-clock.

### 2. Graph Executor (`src/main/agent/graph-executor.ts` — ~896 lines)

Handles multi-agent/parallel task execution via an `ExecutionGraph`. A coordinator decomposes a task into `GraphNode` worker runs, validates output contracts, and synthesizes results. Supports agent profiles: `coordinator`, `scout`, `builder`, `analyst`, `writer`, `reviewer`, `data`, `devops`, `security`, `synthesizer`.

### 3. Browser Engine (`src/main/browser/manager.ts` — ~1720 lines)

- Manages a persistent Electron `BrowserView` using Chrome DevTools Protocol.
- Capabilities: navigation, DOM snapshots, native input injection, form detection/fill, page extraction, screenshot analysis.
- **Playbook system** (`db/browser-playbooks.ts` — ~1400 lines): Records successful form-fill sequences as replayable harnesses ("Bloodhound" mode). Auto-graduates validated playbooks for zero-cost replay.

### 4. Classifier (`src/main/agent/classifier.ts`)

Maps every incoming message to a `TaskProfile` using pure regex — no LLM round-trip. Key signal categories:

| Signal | Regex name | Routes to |
|---|---|---|
| File ops, code | `CODING_RE` | core tools |
| URLs, search, GitHub | `BROWSER_RE` | browser tools |
| Organize/scan/rename files | `FILESYSTEM_AGENT_RE` | filesystem agent |
| Swarm / parallel workers | `COORDINATION_RE` | graph executor |
| Desktop GUI control | `DESKTOP_APP_RE` | desktop executor |
| Bloodhound / automate site | `BLOODHOUND_RE` | browser + playbook |

### 5. Tool Groups

Three bundled tool groups exposed to the LLM:

- **core** — shell exec, file read/write/edit, directory tree, folder summary, reorg plan, duplicate scan, apply plan, quote lookup, calendar tools.
- **browser** — navigate, read page, extract, fill form, click, screenshot, scroll, harness playback.
- **full** — core + browser combined.

### 6. Desktop Executor (`src/main/agent/executors/desktop/`)

GUI automation via accessibility tree (`a11y.ts` + `a11y-bridge.py`), DBus, `xdotool`, screenshot analysis, and smart focus. Supports launching apps, clicking UI elements, typing, taking screenshots, and reading window state.

### 7. Data Layer (`src/main/db/`)

SQLite tables managed via `better-sqlite3`:

| Module | Purpose |
|---|---|
| `conversations.ts` | Chat history |
| `memory.ts` | Long-term memory extraction |
| `runs.ts` | Run records (status, provider, timing) |
| `run-events.ts` | Append-only event log per run |
| `run-artifacts.ts` | Files/outputs produced per run |
| `run-changes.ts` | File change tracking |
| `run-approvals.ts` | Approval gate records |
| `run-human-interventions.ts` | Human-in-the-loop requests |
| `browser-playbooks.ts` | Saved form automation harnesses |
| `site-profiles.ts` | Auth state per domain |
| `calendar.ts` | Local calendar events |
| `policies.ts` | Policy rules for tool gating |
| `app-registry.ts` | Execution plan registry |
| `coordinate-cache.ts` | Cached UI element coordinates |

### 8. Renderer (`src/renderer/`)

React 19 SPA with Tailwind. Key panels:

- **ChatPanel** — streaming message feed with tool activity indicators.
- **BrowserPanel** — live embedded browser view.
- **Sidebar** — navigation rail + drawers (conversations, runs, swarm, settings).
- **SwarmPanel** — visualizes parallel agent workers.
- **ProcessesPanel** — active/recent agent runs.
- **SettingsView** — provider API keys, model selection, performance stance, policy rules.

---

## Agent Profiles

| Profile | Purpose |
|---|---|
| `general` | Default single-agent |
| `filesystem` | File/folder operations specialist |
| `bloodhound` | Browser automation / playbook recording |
| `ytdlp` | Video download pipeline |
| `coordinator` | Swarm orchestrator |
| `scout` | Research / information gathering |
| `builder` | Code and system construction |
| `analyst` | Data analysis |
| `writer` | Document and content creation |
| `reviewer` | Code/output review |
| `data` | Data processing |
| `devops` | Infrastructure and shell ops |
| `security` | Security auditing |
| `synthesizer` | Result aggregation |

---

## AI Model Support

Providers: **Anthropic**, **OpenAI**, **Google Gemini**

Model tiers:
- **fast** — Claude Haiku, GPT-4o-mini, Gemini Flash
- **balanced** — Claude Sonnet (default), GPT-4o, Gemini Pro
- **deep** — Claude Opus, GPT-5.4, Gemini Ultra

---

## Build & Dev Commands

```bash
npm run setup        # First-time setup
npm run dev          # Dev mode (tsc watch + vite + electron)
npm run dev:nogpu    # Dev mode without GPU acceleration
npm run build        # Compile main + renderer
npm run start        # Run production build
npm run start:nogpu  # Production without GPU
npm run package      # Build + electron-builder (distributable)
npm test             # Vitest (all suites)
npm run test:watch   # Vitest watch mode
```

---

## File Counts by Type

| Type | Count |
|---|---|
| `.ts` | 121 |
| `.md` | 35 |
| `.tsx` | 18 |
| `.sh` | 8 |
| `.json` | 6 |
| `.cjs` | 5 |
| `.html` | 3 |

**Total source:** ~233 files, ~2.5 MB

---

## Notable Design Patterns

- **Zero-cost classification**: regex-only routing means no LLM round-trip before the first real tool call.
- **Parallel tool dispatch**: independent tool calls in the same LLM response are batched and executed concurrently.
- **Playbook auto-graduation**: successful browser form interactions are candidates for promotion to replayable zero-cost harnesses.
- **File verification loop**: after any run that writes files, the agent verifies expected outputs exist and re-iterates if they don't.
- **Policy engine**: configurable rules gate which tools can run automatically vs. require approval.
- **Performance stance**: `conservative` / `standard` / `aggressive` stances adjust tool permissions and model selection at runtime.
