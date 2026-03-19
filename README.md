# Clawdia 4.0

**AI desktop workspace — browser, code, and task automation.**

Clawdia is an Electron desktop agent that gives Claude direct access to your filesystem, terminal, and a real browser. Ask it to code, research, manage files, browse the web, or control desktop applications — and watch it work in real-time.

## Features

- **Full system access** — Execute shell commands, read/write files, control native applications
- **Live browser** — Built-in Chromium browser panel where you watch Clawdia browse, search, click, and extract data
- **Persistent memory** — SQLite-backed conversations and user memory with full-text search (FTS5)
- **Prompt caching** — 3-breakpoint Anthropic prompt caching for 80-90% cache hit rates
- **Smart model routing** — Classifier auto-selects Haiku for greetings, Sonnet for tasks, Opus for deep analysis
- **Streaming responses** — Real-time markdown rendering with GFM tables, code blocks, and enterprise-grade styling

## Prerequisites

- **Node.js** 20+ (check with `node -v`)
- **Anthropic API key** — Get one at [console.anthropic.com](https://console.anthropic.com)
- **Linux, macOS, or Windows** with build tools for native modules

### Platform-specific build tools

**Ubuntu/Debian:**
```bash
sudo apt install build-essential python3
```

**macOS:**
```bash
xcode-select --install
```

**Windows:**
```bash
npm install -g windows-build-tools
```

## Quick Start

```bash
# Clone
git clone https://github.com/chillysbabybackribs/clawdia4.0.git
cd clawdia4.0

# Install dependencies (also rebuilds native modules for Electron)
npm install

# Build TypeScript
npm run build:main

# Run in development mode
npm run dev
```

On first launch, go to **Settings** (gear icon in sidebar) and paste your Anthropic API key. Select your preferred model (Sonnet 4.6 recommended).

## GPU Issues

If you experience crashes or rendering glitches (common on Linux with hybrid NVIDIA/Intel GPUs), use the GPU-disabled mode:

```bash
# Development
npm run dev:nogpu

# Production
npm run start:nogpu
```

This adds Chromium flags that disable hardware acceleration and use software rendering.

## Architecture

```
src/
├── main/                   # Electron main process
│   ├── main.ts             # Window creation, IPC handlers
│   ├── store.ts            # Settings persistence (electron-store)
│   ├── agent/              # AI agent core
│   │   ├── classifier.ts   # Zero-cost regex router → tool group + model
│   │   ├── client.ts       # Anthropic SDK with streaming + 3-breakpoint caching
│   │   ├── loop.ts         # Agentic loop: classify → prompt → LLM → tools → loop
│   │   ├── prompt-builder.ts   # Reads .md files, assembles system prompt
│   │   ├── tool-builder.ts     # Tool schemas + dispatch map
│   │   ├── executors/          # Tool implementations
│   │   └── prompt/             # CORE.md, modules/, INJECTIONS.md
│   ├── browser/            # BrowserView manager (navigation, extraction, interaction)
│   └── db/                 # SQLite persistence (conversations, messages, memory)
├── renderer/               # React + Tailwind UI
│   ├── App.tsx             # Layout: sidebar + chat + browser panels
│   └── components/         # ChatPanel, BrowserPanel, Settings, etc.
└── shared/                 # IPC channels, types
```

### How the agent loop works

1. **Classify** — Pure regex matches the user's message to a tool group (core/browser/full) and prompt modules
2. **Build prompt** — Assembles static system prompt from .md files (cached) + dynamic context (date, memory, model)
3. **Call LLM** — Anthropic API with streaming, 3 cache breakpoints, model-aware max_tokens
4. **Dispatch tools** — If the LLM returns tool_use blocks, execute them and loop back to step 3
5. **Respond** — Final text streams to the UI with markdown rendering

### Tool groups

| Group | Tools | Used when |
|-------|-------|-----------|
| Core | shell_exec, file_read, file_write, file_edit, directory_tree | Filesystem/code tasks |
| Browser | browser_search, browser_navigate, browser_click, browser_type, browser_extract, browser_read_page, browser_screenshot | Web browsing/research |
| Full | All of the above + create_document, memory_search, memory_store | Complex or ambiguous tasks |

## Configuration

Settings are stored locally at `~/.config/clawdia/` (Linux/macOS) or `%APPDATA%/clawdia/` (Windows):

- **API key** — Encrypted with a machine-specific key via electron-store
- **Model selection** — Persists across restarts
- **Database** — SQLite at `data.sqlite` in the same directory

## Development

```bash
# Watch mode (auto-reloads on changes)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

The `dev` script runs three processes concurrently:
1. TypeScript watch compiler for main process
2. Vite dev server for renderer (hot reload)
3. Electron with nodemon (restarts on main process changes)

## Security Notes

Clawdia has **full system access** by design — that's its core capability. It can:
- Execute arbitrary shell commands
- Read and write any file your user account can access
- Browse the web and interact with pages
- Control desktop applications

**Do not run Clawdia on machines with sensitive data you don't want an LLM to access.** The API key is stored locally with machine-specific encryption and never leaves your machine.

## License

MIT — see [LICENSE](LICENSE) for details.
