# Clawdia 4.0 — Repository Summary

> **Last updated:** 2026-03-21  
> **Version:** 4.0.0  
> **Author:** Daniel Parker  
> **License:** MIT

---

## What Is Clawdia?

Clawdia is an **AI-powered desktop workspace** built on Electron + React. It gives the user a single pane of glass that combines a live browser panel (sharing real session cookies), a chat interface backed by a multi-provider LLM loop, a filesystem agent, a calendar, a process monitor, and a "swarm" of autonomous sub-agents — all running locally on the user's machine.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Shell / Runtime | Electron 39, Node ≥ 20 |
| UI | React 19, Vite 6, Tailwind CSS 3 |
| Language | TypeScript 5.5 |
| Database | SQLite via `better-sqlite3` |
| LLM Providers | Anthropic Claude, OpenAI, Google Gemini |
| Testing | Vitest 4 |
| Packaging | `electron-builder` |

---

## Repository Layout

```
clawdia4.0/
├── src/
│   ├── main/               # Electron main process (Node/TypeScript)
│   │   ├── agent/          # Core agentic engine
│   │   │   ├── loop.ts                     # Master orchestration loop
│   │   │   ├── loop-dispatch.ts            # Tool-call dispatch logic
│   │   │   ├── loop-setup.ts               # Pre-LLM parallel setup phase
│   │   │   ├── loop-recovery.ts            # Error recovery & retry
│   │   │   ├── loop-cancel.ts              # Graceful cancellation
│   │   │   ├── loop-harness.ts             # Harness replay path
│   │   │   ├── loop-ytdlp.ts               # yt-dlp specialised loop
│   │   │   ├── loop-app-install.ts         # App-install flow
│   │   │   ├── graph-executor.ts           # Parallel task graph execution
│   │   │   ├── task-compiler.ts            # Task → ExecutionGraph scaffolding
│   │   │   ├── execution-graph.ts          # ExecutionGraph types & helpers
│   │   │   ├── node-contracts.ts           # Per-node output contract definitions
│   │   │   ├── workflow.ts                 # High-level workflow orchestration
│   │   │   ├── classifier.ts               # Task classification & tool-group routing
│   │   │   ├── prompt-builder.ts           # Static + dynamic prompt assembly
│   │   │   ├── tool-builder.ts             # Tool manifest construction
│   │   │   ├── verification.ts             # Post-run artifact verification
│   │   │   ├── policy-engine.ts            # Safety & approval policy enforcement
│   │   │   ├── approval-manager.ts         # Human approval request manager
│   │   │   ├── human-intervention-manager.ts
│   │   │   ├── process-manager.ts          # Running-agent process tracker
│   │   │   ├── executor-registry.ts        # Executor registration & lookup
│   │   │   ├── agent-spawn-executor.ts     # Swarm sub-agent spawning
│   │   │   ├── agent-profile-override.ts   # Profile override logic
│   │   │   ├── capability-snapshot.ts      # Agent capability introspection
│   │   │   ├── memory-extractor.ts         # Cross-session memory extraction
│   │   │   ├── file-lock-manager.ts        # Filesystem lock coordination
│   │   │   ├── filesystem-agent-routing.ts # Filesystem task routing rules
│   │   │   ├── client.ts                   # LLM client facade
│   │   │   ├── provider/                   # Multi-provider LLM adapters
│   │   │   │   ├── anthropic-adapter.ts
│   │   │   │   ├── openai-adapter.ts
│   │   │   │   └── gemini-adapter.ts
│   │   │   ├── executors/                  # Specialised executor workers
│   │   │   │   ├── core-executors.ts
│   │   │   │   ├── browser-executors.ts
│   │   │   │   ├── desktop-executors.ts
│   │   │   │   └── extra-executors.ts
│   │   │   ├── tools/groups/               # Per-profile tool group definitions
│   │   │   ├── gui/                        # Accessibility bridge & screenshot analysis
│   │   │   └── prompt/                     # CORE.md, DYNAMIC.md, INJECTIONS.md
│   │   ├── browser/        # Electron browser panel control
│   │   │   ├── manager.ts              # Chrome DevTools Protocol orchestration
│   │   │   ├── site-harness.ts         # Site-specific form harnesses
│   │   │   ├── dom-snapshot.ts         # DOM extraction helpers
│   │   │   └── native-input.ts         # Native input event injection
│   │   ├── db/             # SQLite persistence layer
│   │   │   ├── database.ts             # Schema, migrations
│   │   │   ├── conversations.ts / runs.ts / run-events.ts
│   │   │   ├── browser-playbooks.ts    # Recorded site playbooks
│   │   │   ├── memory.ts               # Cross-session user memory
│   │   │   └── calendar.ts             # Calendar CRUD
│   │   ├── main.ts         # Electron entry point & IPC handlers
│   │   ├── preload.ts      # Context bridge
│   │   ├── store.ts        # Electron-store settings
│   │   └── calendar-watcher.ts
│   ├── renderer/           # React renderer process
│   │   ├── App.tsx
│   │   └── components/
│   │       ├── ChatPanel.tsx           # Main chat + feed UI
│   │       ├── BrowserPanel.tsx        # Embedded browser view
│   │       ├── ProcessesPanel.tsx      # Live agent process monitor
│   │       ├── SwarmPanel.tsx          # Multi-agent swarm dashboard
│   │       ├── Sidebar.tsx / Rail.tsx  # Navigation rail & drawers
│   │       └── Calendar.tsx / SettingsView.tsx / …
│   └── shared/
│       ├── types.ts                    # Cross-process type definitions
│       ├── model-registry.ts           # Available models per provider
│       └── ipc-channels.ts             # Typed IPC channel constants
├── tests/                  # Vitest test suites
│   ├── agent/              # graph-executor, task-compiler, node-contracts, loop, classifier
│   ├── browser/            # manager, dom-snapshot, harness, session, commerce tests
│   └── db/                 # run-artifacts, playbooks, conversation-recall
├── docs/
│   ├── superpowers/plans/  # Design & architecture decision docs
│   └── *.md                # Audit docs, integration summaries
├── cli/                    # CLI entry point & Electron shim
│   └── clawdia-cli.ts
└── scripts/
    ├── clawdia-cal         # CLI calendar management tool
    └── bloodhound-tools/   # Research/scraping utilities
```

---

## Core Architecture

### 1. Agent Loop (`src/main/agent/loop.ts`)
The central orchestrator. Phases:
1. **Classify** — determine task profile and applicable tool groups
2. **Setup** — parallel pre-LLM setup: memory recall, desktop routing, calendar injection
3. **Prompt** — assemble static system prompt + dynamic context
4. **LLM call** — stream tokens from the selected provider
5. **Dispatch** — execute tool calls in parallel batches
6. **Verify** — post-run file verification and optional recovery iteration
7. **Respond** — surface final answer to the renderer

The loop supports up to **50 iterations**, a **10-minute wall-clock limit**, and graceful mid-run cancellation/pausing.

### 2. Task Compiler & Graph Executor
`task-compiler.ts` decomposes multi-step user requests into an **ExecutionGraph** — a DAG of typed worker nodes defined in `execution-graph.ts` and `node-contracts.ts`. `graph-executor.ts` runs these nodes in parallel using specialised executor workers, collecting structured output payloads that satisfy per-node **output contracts** before merging into a final response.

### 3. Multi-Provider LLM Adapters
All three providers (Anthropic, OpenAI, Gemini) implement a common `ProviderClient` interface and emit a normalised `LLMResponse`. The factory in `provider/factory.ts` selects the adapter at runtime based on user settings. The model registry (`shared/model-registry.ts`) lists available models per provider.

### 4. Browser Control (`src/main/browser/manager.ts`)
Drives an embedded Chromium window via the Chrome DevTools Protocol — navigating, reading DOM snapshots, injecting native input events, and executing site harnesses. The browser shares the user's real session cookies, so all authenticated sites work transparently.

### 5. Playbook & Harness System
Successful multi-step browser workflows are recorded as **playbooks** in SQLite. On subsequent identical tasks the harness executor replays them in 2–5 seconds with zero LLM cost. Auto-graduation logic promotes confident LLM executor steps to harness steps over time.

### 6. Policy Engine & Approval Manager
`policy-engine.ts` enforces safety and rate-limit rules. `approval-manager.ts` and `human-intervention-manager.ts` surface approval requests to the UI and block execution until the user responds, enabling human-in-the-loop control for high-risk actions.

### 7. Persistence (SQLite)
All runs, events, tool calls, artifacts, file locks, approvals, human interventions, memories, calendar entries, site profiles, and playbooks are stored in a local SQLite database managed by `better-sqlite3`.

### 8. Swarm / Agent Spawning
`agent-spawn-executor.ts` and the `SwarmPanel` UI allow the coordinator to spawn typed sub-agent workers (scout, builder, analyst, writer, reviewer, etc.) for parallel task decomposition. `process-manager.ts` tracks all running agents across the swarm.

---

## Agent Profiles

| Profile | Purpose |
|---|---|
| `general` | Default conversational + action mode |
| `filesystem` | File/repo reading, writing, reorganisation |
| `bloodhound` | Deep research and site scraping |
| `ytdlp` | Media download pipeline |
| `coordinator` | Swarm task decomposition |
| `builder` | Code writing and project modification |
| `analyst` | Data analysis and reporting |
| `scout` | Initial reconnaissance |
| `writer` | Long-form content generation |
| `reviewer` | Code/content review |
| `data` | Data extraction and transformation |
| `devops` | Shell, infra, deployment tasks |
| `security` | Security audit tasks |
| `synthesizer` | Cross-agent result merging |

---

## Key Scripts

```bash
npm run dev          # Start in development mode (TypeScript watch + Vite + Electron)
npm run build        # Compile main process (tsc) + renderer (vite build)
npm run start        # Launch production build
npm run test         # Run Vitest suite
npm run package      # Build + package with electron-builder
```

---

## Recent Activity (as of 2026-03-21)

- **Graph executor & task compiler** — active development; `graph-executor.test.ts` and `task-compiler.test.ts` added/updated today
- **Node contracts** — `node-contracts.ts` and `node-contracts.test.ts` added with typed output contract definitions for each worker role
- **Run artifacts DB** — schema and query improvements in `tests/db/run-artifacts.test.ts`
- **Sidebar redesign phase 1** — in-progress (`docs/superpowers/plans/2026-03-21-sidebar-redesign-phase1.md`)
- **Executor refactor** — completed (`docs/superpowers/plans/2026-03-20-executor-refactor.md`)
- **Multi-provider hardening** — completed (`docs/superpowers/plans/2026-03-20-multi-provider-hardening.md`)
- **AI calendar integration** — completed (`docs/superpowers/plans/2026-03-20-ai-calendar-integration.md`)
- **Async runs** — completed (`docs/superpowers/plans/2026-03-19-async-runs.md`)

---

## File Count Snapshot

| Category | Count |
|---|---|
| TypeScript source files (`.ts`) | 55 |
| React components (`.tsx`) | 2 |
| Markdown docs (`.md`) | 11 |
| Shell scripts (`.sh`) | 8 |
| JSON configs | 6 |
| **Total tracked files** | **~98** |
