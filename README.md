# Clawdia 4.0

**AI desktop agent that controls your entire machine — any app, any window, any interface.**

Clawdia is an Electron desktop agent that gives Claude direct access to your filesystem, terminal, browser, and — uniquely — every desktop application running on your system. Ask it to edit an image in GIMP, pause Spotify, click a button in LibreOffice, or take a screenshot of any window. It figures out the best way to do it.

## What makes Clawdia different: 3-tier desktop application control

Most AI desktop agents can run shell commands and browse the web. Clawdia goes further with a three-tier fallback system for controlling any desktop application:

### Tier 1 — CLI-Anything harnesses (`app_control`)
For supported open-source apps (GIMP, Blender, Inkscape, LibreOffice, OBS, Audacity, Kdenlive), Clawdia uses structured CLI harnesses that return JSON. Deterministic, reliable, no guessing.

### Tier 2 — GUI automation (`gui_interact`)
For any app with a visible window — open-source or proprietary — Clawdia uses `xdotool`, `wmctrl`, and `scrot` to click, type, send keystrokes, focus windows, and take screenshots. Works on literally anything running on X11. Multi-step GUI sequences are batched into a single tool call to minimize round-trips.

### Tier 3 — DBus / programmatic control (`dbus_control`)
For apps that expose DBus interfaces (Spotify, media players, GNOME apps, Electron apps), Clawdia discovers available services and methods at runtime and calls them directly. No window needed.

The agent tries these in order, falling back automatically based on what's installed and what's running.

## Features

- **3-tier desktop control** — Control any app: CLI harness → GUI automation → DBus, tried in order
- **Full system access** — Execute shell commands, read/write files, control native applications
- **Live browser** — Built-in Chromium browser panel where you watch Clawdia browse, search, click, and extract data
- **Persistent memory** — SQLite-backed conversations and user memory with full-text search (FTS5)
- **Prompt caching** — 3-breakpoint Anthropic prompt caching for 80-90% cache hit rates
- **Smart model routing** — Classifier auto-selects Haiku for greetings, Sonnet for tasks, Opus for deep analysis
- **Streaming responses** — Real-time markdown rendering with GFM tables, code blocks, and enterprise-grade styling

## Quick Start

```bash
git clone https://github.com/chillysbabybackribs/clawdia4.0.git
cd clawdia4.0
./setup.sh
npm run dev
```

That's it. The setup script checks prerequisites, installs dependencies (including `xdotool`, `wmctrl`, `scrot` for desktop control), builds TypeScript, and detects GPU issues. On first launch, a welcome screen walks you through adding your Anthropic API key.

### Manual setup (if you prefer)

```bash
npm install          # Install deps + rebuild native modules
npm run dev          # Builds TypeScript automatically, then starts
```

### Windows

```bash
npm install
npm run dev
```

The setup script is bash-only. On Windows, `npm install` and `npm run dev` are all you need — the `predev` hook auto-builds TypeScript. Note: GUI automation (Tier 2) requires X11 and is Linux-only.

## GPU Issues

If you experience crashes or rendering glitches (common on Linux with hybrid NVIDIA/Intel GPUs):

```bash
npm run dev:nogpu
```

This disables hardware acceleration and uses software rendering via SwiftShader.

## Sandbox Note

All scripts include `--no-sandbox` because Clawdia has full system access by design (shell commands, file I/O, app control). Chromium sandboxing provides no meaningful security for an app that intentionally runs arbitrary commands.

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
│   │   │   ├── core-executors.ts      # shell_exec, file_read/write/edit, directory_tree
│   │   │   ├── browser-executors.ts   # browser_search, navigate, click, type, extract
│   │   │   ├── extra-executors.ts     # create_document, memory_search/store
│   │   │   └── desktop-executors.ts   # app_control, gui_interact, dbus_control
│   │   └── prompt/             # CORE.md, modules/, INJECTIONS.md
│   ├── browser/            # BrowserView manager
│   └── db/                 # SQLite persistence
├── renderer/               # React + Tailwind UI
│   ├── App.tsx             # Layout + first-run detection
│   └── components/         # ChatPanel, BrowserPanel, WelcomeScreen, Settings
└── shared/                 # IPC channels, types
```

### How the agent loop works

1. **Classify** — Regex matches user message → tool group + prompt modules (zero LLM cost)
2. **Build prompt** — Static .md files (cached) + dynamic context (date, OS, memory, desktop capabilities)
3. **Call LLM** — Streaming with 3 cache breakpoints, model-aware max_tokens
4. **Dispatch tools** — Execute tool calls, loop back to step 3
5. **Respond** — Final text streams with live markdown rendering

### Tool groups

| Group | Tools | Used when |
|-------|-------|-----------|
| Core | shell_exec, file_read, file_write, file_edit, directory_tree | Filesystem/code tasks |
| Browser | browser_search, browser_navigate, browser_click, browser_type, browser_extract, browser_read_page, browser_screenshot | Web research |
| Full | All above + create_document, memory_search, memory_store, **app_control, gui_interact, dbus_control** | Complex tasks, desktop control |

### Desktop control decision tree

```
User asks to interact with a desktop app
  └─ Try app_control (CLI-Anything harness installed?)
       ├─ Yes → structured JSON, done
       └─ No → Try dbus_control (does app expose DBus?)
                 ├─ Yes → call methods directly, done
                 └─ No → gui_interact (any visible window)
                           ├─ screenshot_and_focus to orient
                           └─ batch_actions to execute steps
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New chat |
| `Ctrl+L` | Clear / new chat |
| `Ctrl+B` | Toggle browser panel |
| `Ctrl+H` | Conversation history |
| `Ctrl+,` | Settings |
| `Escape` | Back to chat |

## Configuration

Data is stored locally per-user at the OS-standard config path:

| OS | Path |
|----|------|
| Linux | `~/.config/clawdia/` |
| macOS | `~/Library/Application Support/clawdia/` |
| Windows | `%APPDATA%/clawdia/` |

Contents: `data.sqlite` (conversations, messages, memory) + `clawdia-settings.json` (API key, model).

## Development

```bash
npm run dev          # Watch mode with hot reload
npm run build        # Production build (main + renderer)
npm start            # Run production build
```

## Security

Clawdia has **full system access by design**. It can execute shell commands, read/write any file, browse the web, and control desktop applications. Your API key is encrypted locally and only sent to the Anthropic API.

## License

MIT
