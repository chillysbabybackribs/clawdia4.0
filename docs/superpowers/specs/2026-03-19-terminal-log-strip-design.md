# Terminal Log Strip Design

**Date:** 2026-03-19
**Status:** Approved

---

## Overview

A fixed-height terminal log strip docked at the bottom of the chat message area (above the input bar). Shows live shell output during agent execution. Collapses to a single toggle row when the agent finishes. Monochrome only — no green or coloured text.

---

## Behaviour

### During streaming

- Strip is visible, fixed height ~72px (4 lines at 10.5px / line-height 1.55 ≈ 16.3px per line + 8px padding), scrollable
- New output lines append and the strip auto-scrolls to bottom
- Text is monochrome: commands in `rgba(255,255,255,0.38)`, output in `rgba(255,255,255,0.72)`, dim lines in `rgba(255,255,255,0.25)` (see Line Classification below)
- Strip renders below the message scroll area, above the input bar
- The existing `StatusLine` (shimmer dot + "Running shell_exec…") stays — it sits inside the message scroll area; the terminal strip is separate and below it

### After streaming ends

- Strip collapses to a single row: `[terminal icon] terminal log  ⌄`
- Row height ~28px, same dark background as the live strip
- Clicking the row toggles expand/collapse — chevron rotates 180° when open
- Expanded state: up to ~120px max-height, scrollable, same scrollbar style
- The strip only renders for the **most recently completed message**. Historical messages do not show the strip (terminal lines are not persisted into the `Message` object — this is acceptable for v1).

### Scrollbar (scoped to terminal strip only)

Scoped via `.terminal-log-strip` class selector in `index.css`:
```css
.terminal-log-strip ::-webkit-scrollbar { width: 3px; }
.terminal-log-strip ::-webkit-scrollbar-track { background: transparent; }
.terminal-log-strip ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
.terminal-log-strip ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
```
Does not affect the global chat scrollbar (which remains at 6px).

### Line Classification

Applied in order — first match wins:

1. **Dim** — line matches `/^\[(?:LLM|stderr|Harness|Router|Agent|Install|Setup|Recall|Playbook)\]/i` → `rgba(255,255,255,0.25)`
2. **Command** — line starts with `$` or `>` → `rgba(255,255,255,0.38)`
3. **Output** (default) → `rgba(255,255,255,0.72)`

---

## Data Flow

No backend changes. The strip consumes `streamMap` already maintained in `ChatPanel`.

```
loop.ts → onToolStream IPC → ChatPanel.streamMap[payload.toolId] = [...lines]
```

`streamMap` is keyed by `payload.toolId` (the raw IPC tool ID string from `onToolStream`). This is **not** the same as the synthetic `id` on `ToolCall` objects (which use `tool-${Date.now()}-${random}`). The terminal strip uses `streamMap` directly — it does not join against `toolCallsRef`. `terminalLines` is derived by flattening `Object.values(streamMap)` in insertion order.

`streamMap` is reset to `{}` on each new user send (`handleSend`). Therefore:
- During streaming: `terminalLines` accumulates all tool output for the current message
- After streaming ends: the strip shows the accumulated lines until the user sends a new message, at which point `streamMap` is cleared and the strip disappears for the now-historical message

This is intentional v1 behaviour — no per-message persistence of terminal lines.

---

## Components

### New: `TerminalLogStrip`

**File:** `src/renderer/components/TerminalLogStrip.tsx`

```typescript
interface TerminalLogStripProps {
  lines: string[];        // flattened tool stream lines for current message
  isStreaming: boolean;   // true = live strip; false = collapsed toggle
}
```

Behaviour:
- `isStreaming=true`: render live strip (72px, auto-scroll, no toggle)
- `isStreaming=false` and `lines.length > 0`: render collapsed toggle row (with expand/collapse)
- `isStreaming=false` and `lines.length === 0`: render nothing
- Internal `useState<boolean>` for open/closed on the collapsed toggle
- Root element has className `terminal-log-strip` (for scoped scrollbar CSS)
- Line classification: regex check first (dim), then `$`/`>` prefix (command), else output

### Modified: `ChatPanel`

Two changes:

1. **Derive `terminalLines`** from `streamMap`:
```tsx
const terminalLines = Object.values(streamMap).flat();
```
This is computed inline from existing state — no new `useState` needed.

2. **Render `TerminalLogStrip`** between the scroll area and `InputBar`:
```tsx
{(isStreaming || terminalLines.length > 0) && (
  <TerminalLogStrip lines={terminalLines} isStreaming={isStreaming} />
)}
```

### Modified: `index.css`

Add scoped scrollbar rules for `.terminal-log-strip` (see Scrollbar section above).

---

## Visual Spec

### Live strip (~72px, 4 lines visible)
```
┌─────────────────────────────────────────┐  border-top: 1px solid rgba(255,255,255,0.07)
│ $ kdenlive --help                        │  cmd: rgba(255,255,255,0.38)
│ Usage: kdenlive [options] [files]        │  output: rgba(255,255,255,0.72)
│ [Harness] shell_exec: Directories…      │  dim: rgba(255,255,255,0.25)
│ $ pip install -e . 2>&1                 │  auto-scrolls to bottom
└─────────────────────────────────────────┘
  bg: #080a0f | font: JetBrains Mono/Fira Code/monospace, 10.5px, lh 1.55
  padding: 5px 14px | scrollbar: 3px scoped
```

### Collapsed toggle row
```
┌─────────────────────────────────────────┐
│ ⌨ terminal log                      ⌄  │  click → expand
└─────────────────────────────────────────┘
  height: ~28px | bg: #080a0f | border-top: 1px solid rgba(255,255,255,0.07)
  label: 10.5px monospace, rgba(255,255,255,0.32) | cursor: pointer
  chevron: rgba(255,255,255,0.25), rotates 180° when open
```

### Expanded (after clicking toggle)
```
┌─────────────────────────────────────────┐
│ ⌨ terminal log                      ⌃  │  click → collapse
├─────────────────────────────────────────┤  border-top: 1px solid rgba(255,255,255,0.04)
│ $ kdenlive --help                        │
│ Usage: kdenlive [options] [files]        │
│ $ pip install -e .                       │
│ Successfully installed …                 │
└─────────────────────────────────────────┘
  max-height: 120px | scrollable | same scrollbar style
```

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/renderer/components/TerminalLogStrip.tsx` | **New** — live + collapsed strip component |
| `src/renderer/components/ChatPanel.tsx` | Derive `terminalLines`, render `TerminalLogStrip` |
| `src/renderer/index.css` | Add `.terminal-log-strip` scoped scrollbar rules |

---

## Success Criteria

- Terminal output appears in the strip during harness generation (live tool stream lines)
- Strip is ~72px tall, auto-scrolls, scrollbar is 3px wide and monochrome
- After agent finishes: strip collapses to "terminal log ⌄" row
- Clicking the row expands/collapses the full log; chevron rotates
- No green or coloured text anywhere in the strip
- Existing `StatusLine` and message bubble behaviour unchanged
- Scoped scrollbar does not affect the global 6px chat scrollbar
