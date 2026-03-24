# Inline Shimmer Indicator Design

**Date:** 2026-03-24
**Status:** Approved
**Scope:** `src/renderer/components/ChatPanel.tsx` only — no backend changes

---

## Goal

Replace all in-chat activity UI (tool cards, status bar, thinking dots) with a single inline shimmer text line that sits between the user message and the eventual LLM response. The indicator is universal — it fires for every task type, every model, every provider. When response text begins streaming, the shimmer disappears instantly and text takes its place.

---

## What Is Removed

| Element | Component | Action |
|---------|-----------|--------|
| Tool activity cards (dark bordered boxes) | `ToolActivity` | No longer rendered in `AssistantMessage` feed |
| StatusLine bar at bottom of chat | `StatusLine` | No longer rendered in `ChatPanel` |
| ThinkingIndicator (3 animated dots) | `ThinkingIndicator` | No longer rendered in `ChatPanel` |

The component files (`ToolActivity.tsx`, `StatusLine.tsx`, `ThinkingIndicator.tsx`) are **not deleted** — they are simply no longer rendered. Bloodhound and other internal systems still use the underlying data.

---

## What Is Added

### `InlineShimmer` component (defined inside `ChatPanel.tsx`)

A single `<span>` with a shimmer CSS animation. Props:

```typescript
interface InlineShimmerProps {
  text: string; // phase label — e.g. "Running command…"
}
```

Renders as:

```tsx
<span className="inline-shimmer">{text}</span>
```

CSS (added to global stylesheet or as a `<style>` in the component):

```css
.inline-shimmer {
  font-size: 13px;
  background: linear-gradient(90deg, #3a3a3a 25%, #787878 50%, #3a3a3a 75%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: shimmer-sweep 2s linear infinite;
  display: inline-block;
}

@keyframes shimmer-sweep {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

---

## State

One new state field added to `ChatPanel`:

```typescript
const [shimmerText, setShimmerText] = useState<string>('');
```

`shimmerText` is the current phase label. Empty string = shimmer hidden (removed from DOM entirely via conditional render, not just hidden with `display:none`).

---

## Shimmer Lifecycle

### While active (tool calls or LLM thinking)

- `shimmerText` is non-empty → `InlineShimmer` is rendered in the assistant message area
- Each new `CHAT_TOOL_ACTIVITY` event with `status: 'running'` → **immediately replaces** `shimmerText` (no transition, no fade — instant swap)
- Between tool calls (LLM iterating but no tool active): `shimmerText` = `"Thinking…"`

### When response text starts

- First `CHAT_STREAM_TEXT` chunk arrives → `setShimmerText('')` immediately
- Shimmer node is removed from DOM
- Text begins rendering in that same space
- No layout shift because the shimmer and the text render at the same vertical position

### When run ends

- `CHAT_STREAM_END` → `setShimmerText('')` (already empty in most cases)

---

## Phase Label Mapping

Derived from `activity.name` and `activity.detail` from `CHAT_TOOL_ACTIVITY` events:

```typescript
function toolToShimmerLabel(name: string, detail?: string): string {
  const host = detail ? extractHostname(detail) : null; // for browser_navigate

  const labels: Record<string, string> = {
    browser_navigate:  host ? `Navigating to ${host}…` : 'Navigating…',
    browser_click:     'Clicking…',
    browser_extract:   'Extracting page content…',
    browser_read:      'Reading page…',
    browser_type:      'Typing…',
    browser_batch:     'Running browser sequence…',
    browser_scroll:    'Scrolling…',
    shell_exec:        'Running command…',
    file_read:         'Reading file…',
    file_write:        'Writing file…',
    file_edit:         'Editing file…',
    directory_tree:    'Scanning directory…',
    fs_quote_lookup:   'Searching files…',
    fs_folder_summary: 'Summarising folder…',
    agent_spawn:       'Spawning agent…',
    memory_read:       'Recalling memory…',
    memory_write:      'Saving to memory…',
  };

  return labels[name] ?? `Working…`;
}

function extractHostname(detail: string): string | null {
  try {
    const match = detail.match(/https?:\/\/([^/\s]+)/);
    return match ? match[1].replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}
```

For `awaiting_approval` and `needs_human` statuses:

```typescript
if (activity.status === 'awaiting_approval') return 'Waiting for approval…';
if (activity.status === 'needs_human')       return 'Needs your input…';
```

---

## Rendering in `AssistantMessage`

The live feed path in `AssistantMessage` is simplified:

### Before (current)
```tsx
{groups.map((g, i) =>
  g.kind === 'tools' ? (
    <ToolActivity key={g.startIdx} tools={g.tools} streamMap={activeStreamMap} />
  ) : (
    <MarkdownRenderer key={g.idx} content={g.text} isStreaming={g.isStreaming === true} />
  )
)}
```

### After (new)
```tsx
{/* Only render text groups — tool groups are silently dropped */}
{groups
  .filter(g => g.kind === 'text')
  .map(g => (
    <MarkdownRenderer key={(g as any).idx} content={(g as any).text} isStreaming={(g as any).isStreaming === true} />
  ))
}

{/* Inline shimmer — only shown when streaming and no text yet */}
{message.isStreaming && shimmerText && groups.filter(g => g.kind === 'text').length === 0 && (
  <InlineShimmer text={shimmerText} />
)}
```

**Note:** The shimmer only shows when there is no text content yet. Once the first text chunk arrives, `shimmerText` is cleared and the shimmer node is gone.

---

## `handleToolActivityEvent` changes

The existing handler already sets `statusText` — replace all `setStatusText(...)` calls with `setShimmerText(...)`.

Remove: all `feedRef.current.push({ kind: 'tool', ... })` calls — tool items are no longer added to the feed. The feed becomes text-only.

Keep: the backwards scan and in-place status update logic can be removed entirely (no tool items in feed to update).

Simplified handler:

```typescript
const handleToolActivityEvent = useCallback((activity: { name: string; status: string; detail?: string }) => {
  ensureAssistantReplayMessage();

  if (activity.status === 'running' || activity.status === 'awaiting_approval' || activity.status === 'needs_human') {
    // Freeze any in-progress text item
    const lastIdx = feedRef.current.length - 1;
    if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
      feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
    }
    setShimmerText(toolToShimmerLabel(activity.name, activity.detail));
    autoScroll();
  }
  // success/error: no-op for UI (shimmer cleared by first text chunk or stream end)
}, [autoScroll, ensureAssistantReplayMessage]);
```

---

## `handleStreamTextChunk` changes

Add one line: clear shimmer when first text arrives.

```typescript
const handleStreamTextChunk = useCallback((chunk: string) => {
  ensureAssistantReplayMessage();
  setShimmerText('');           // ← clear shimmer immediately on first text
  // ... rest of existing logic unchanged
}, [...]);
```

---

## `handleStreamEndEvent` changes

Clear shimmer on run end:

```typescript
setShimmerText('');
```

---

## Initial shimmer on run start

When `CHAT_STREAM_TEXT` hasn't arrived yet but the run has started, the shimmer should show `"Thinking…"` immediately — before any tool fires.

This is triggered when `ensureAssistantReplayMessage()` creates a new assistant message and `isStreaming` is true but `shimmerText` is still empty. Set initial shimmer in `ensureAssistantReplayMessage`:

```typescript
setShimmerText('Thinking…');
```

---

## What stays the same

- `feedRef.current` still exists — it just stores text-only items now
- `CHAT_TOOL_STREAM` events are still received but ignored (no tool output rendered)
- `streamMap` state can be removed (no ToolActivity to pass it to)
- All IPC channels, process-manager, loop, Bloodhound recording — **untouched**
- Historical messages loaded from DB still render via the fallback path — ToolActivity in the fallback path is also removed (just `MarkdownRenderer` for content)

---

## Scrolling

`autoScroll()` is called whenever `shimmerText` changes, preserving the existing scroll-to-bottom behaviour during active runs.

---

## Testing

- Short run (single tool call): shimmer appears → text replaces it → no flash
- Multi-tool run: shimmer text swaps instantly between tool phases, never stacks
- LLM-only run (no tool calls): shimmer shows "Thinking…" → text replaces it
- Cancelled run: shimmer clears on `CHAT_STREAM_END`
- Historical messages: render cleanly with no shimmer, no tool cards
- Swarm / agent_spawn tasks: shimmer shows "Spawning agent…"

---

## Out of Scope

- Approval UI (`awaiting_approval`, `needs_human`) — separate feature, not addressed here
- Tool output visibility — removed in this change; a future "expandable detail" design is out of scope
- `ToolActivity.tsx`, `StatusLine.tsx`, `ThinkingIndicator.tsx` cleanup/deletion — deferred
