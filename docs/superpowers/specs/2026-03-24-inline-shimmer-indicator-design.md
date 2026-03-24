# Inline Shimmer Indicator Design

**Date:** 2026-03-24
**Status:** Approved
**Scope:** `src/renderer/components/ChatPanel.tsx`, `src/renderer/index.css`

---

## Goal

Replace all in-chat activity UI (tool cards, status bar) with a single inline shimmer text line that sits between the user message and the eventual LLM response. The indicator is universal — it fires for every task type, every model, every provider. When response text begins streaming, the shimmer disappears instantly and text takes its place with no layout shift.

---

## What Is Removed

| Element | Location | Action |
|---------|----------|--------|
| Tool activity cards (dark bordered boxes) | `AssistantMessage` live-feed path, line 389 | Remove `ToolActivity` render — tool feed items silently dropped |
| Tool activity in historical fallback | `AssistantMessage` fallback path, line 412 | Remove `hasTools && <ToolActivity ...>` block |
| `StatusLine` bar at bottom of chat | `ChatPanel` render, line 1024 | Delete that JSX line entirely |

**Note:** `ThinkingIndicator.tsx` is not currently rendered in `ChatPanel` — no action needed. `ToolActivity.tsx`, `StatusLine.tsx` component files are **not deleted** — Bloodhound and other subsystems may reference them; they just stop being rendered.

---

## What Stays the Same

- `streamMap` state and `handleToolStreamEvent` — **kept untouched**. `TerminalLogStrip` (line 1031–1036) consumes `streamMap` to display shell output below the chat. This is independent of tool cards and must not be removed.
- `feedRef` — still exists, still stores `{ kind: 'text' }` items. Tool items are no longer pushed to it (see handler changes below).
- All IPC channels, process-manager, loop, Bloodhound recording — **no backend changes**.
- Historical messages loaded from DB render via the fallback path — after removing `ToolActivity`, only `MarkdownRenderer` renders content there.

---

## What Is Added

### CSS — add to `src/renderer/index.css`

Add alongside the existing `status-shimmer` / `status-shimmer-text` classes (around line 153). Reuses the same `status-shimmer` keyframe — no new animation needed:

```css
/* ── Inline shimmer indicator ── */
.inline-shimmer {
  font-size: 13px;
  background: linear-gradient(90deg,
    rgba(120, 120, 136, 0.5) 0%, rgba(120, 120, 136, 0.5) 35%,
    rgba(200, 200, 215, 0.9) 50%, rgba(120, 120, 136, 0.5) 65%,
    rgba(120, 120, 136, 0.5) 100%);
  background-size: 200% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: status-shimmer 2s linear infinite;
  display: inline-block;
}
```

### State — add to `ChatPanel`

```typescript
const [shimmerText, setShimmerText] = useState<string>('');
```

`shimmerText` is the current phase label. Empty string = shimmer not rendered (removed from DOM via conditional, not `display:none`).

### `InlineShimmer` component — define inside `ChatPanel.tsx`

```typescript
function InlineShimmer({ text }: { text: string }) {
  return <span className="inline-shimmer">{text}</span>;
}
```

### `toolToShimmerLabel` helper — define inside `ChatPanel.tsx`

```typescript
function extractHostname(detail: string): string | null {
  const match = detail?.match(/https?:\/\/([^/\s]+)/);
  return match ? match[1].replace(/^www\./, '') : null;
}

function toolToShimmerLabel(name: string, detail?: string): string {
  if (name === 'browser_navigate') {
    const host = extractHostname(detail ?? '');
    return host ? `Navigating to ${host}…` : 'Navigating…';
  }
  const labels: Record<string, string> = {
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
  return labels[name] ?? 'Working…';
}
```

---

## `AssistantMessage` changes

`shimmerText` is passed as a new prop so the component can render it. The memo comparator is updated to re-render when shimmerText changes.

### Updated props interface

```typescript
// Before:
const AssistantMessage = React.memo(function AssistantMessage({ message, streamMap }: { message: Message; streamMap?: ToolStreamMap }) {

// After:
const AssistantMessage = React.memo(function AssistantMessage({ message, streamMap, shimmerText }: { message: Message; streamMap?: ToolStreamMap; shimmerText?: string }) {
```

### Updated memo comparator

```typescript
// Before:
}, (prev, next) => {
  if (!prev.message.isStreaming && !next.message.isStreaming) {
    return prev.message.id === next.message.id;
  }
  return false;
});

// After:
}, (prev, next) => {
  if (!prev.message.isStreaming && !next.message.isStreaming) {
    return prev.message.id === next.message.id;
  }
  if (prev.shimmerText !== next.shimmerText) return false;
  return false;
});
```

### Updated live-feed render path (lines 384–403)

**Before:**
```tsx
return (
  <div className="flex justify-start animate-slide-up group">
    <div className="max-w-[92%] px-1 py-2 text-text-primary flex flex-col gap-3">
      {groups.map((g, i) =>
        g.kind === 'tools' ? (
          <ToolActivity key={g.startIdx} tools={g.tools} streamMap={activeStreamMap} />
        ) : (
          <MarkdownRenderer key={g.idx} content={g.text} isStreaming={g.isStreaming === true} />
        )
      )}
      {!message.isStreaming && message.content && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] text-text-secondary/70">{message.timestamp}</span>
          <CopyButton text={message.content} />
        </div>
      )}
    </div>
  </div>
);
```

**After:**
```tsx
const textGroups = groups.filter(g => g.kind === 'text') as Array<{ kind: 'text'; text: string; isStreaming?: boolean; idx: number }>;
const hasText = textGroups.length > 0;

return (
  <div className="flex justify-start animate-slide-up group">
    <div className="max-w-[92%] px-1 py-2 text-text-primary flex flex-col gap-3">
      {/* Shimmer — shown only while streaming and no text has arrived yet */}
      {message.isStreaming && shimmerText && !hasText && (
        <InlineShimmer text={shimmerText} />
      )}
      {textGroups.map(g => (
        <MarkdownRenderer key={g.idx} content={g.text} isStreaming={g.isStreaming === true} />
      ))}
      {!message.isStreaming && message.content && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] text-text-secondary/70">{message.timestamp}</span>
          <CopyButton text={message.content} />
        </div>
      )}
    </div>
  </div>
);
```

### Updated fallback path (lines 405–422)

**Before:**
```tsx
return (
  <div className="flex justify-start animate-slide-up group">
    <div className="max-w-[92%] px-1 py-2 text-text-primary">
      {hasTools && <div className={hasContent ? 'mb-3' : ''}><ToolActivity tools={message.toolCalls!} streamMap={{}} /></div>}
      {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
      ...
    </div>
  </div>
);
```

**After:**
```tsx
return (
  <div className="flex justify-start animate-slide-up group">
    <div className="max-w-[92%] px-1 py-2 text-text-primary">
      {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
      ...
    </div>
  </div>
);
```

Remove the `hasTools &&` block entirely. The `hasTools` variable and `hasContent` guard on the early return at line 408 remain — that guard still prevents rendering an empty historical message.

---

### `AssistantMessage` call site

Find the call site in `ChatPanel`'s render (approximately line 998). Add the `shimmerText` prop:

```tsx
// Before:
<AssistantMessage key={msg.id} message={msg} streamMap={streamMap} />

// After:
<AssistantMessage key={msg.id} message={msg} streamMap={streamMap} shimmerText={msg.isStreaming ? shimmerText : undefined} />
```

---

## Handler changes

### `handleToolActivityEvent` — replace entirely

**Before (lines 567–610):** pushes `{ kind: 'tool' }` to `feedRef`, updates tool status in-place, calls `setStatusText`.

**After:**
```typescript
const handleToolActivityEvent = useCallback((activity: { name: string; status: string; detail?: string }) => {
  ensureAssistantReplayMessage();

  if (activity.status === 'running') {
    // Freeze any in-progress text item so text + shimmer don't interleave
    const lastIdx = feedRef.current.length - 1;
    if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
      feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
    }
    setShimmerText(toolToShimmerLabel(activity.name, activity.detail));
    scheduleStreamUpdate();
    autoScroll();
  } else if (activity.status === 'awaiting_approval') {
    setShimmerText('Waiting for approval…');
    autoScroll();
  } else if (activity.status === 'needs_human') {
    setShimmerText('Needs your input…');
    autoScroll();
  }
  // success / error: no-op — shimmer will be cleared by first text chunk or stream end
}, [autoScroll, ensureAssistantReplayMessage, scheduleStreamUpdate]);
```

### `handleThinkingEvent` — update to use shimmerText

```typescript
// Before:
const handleThinkingEvent = useCallback((thought: string) => {
  setStatusText(thought || '');
  if (thought) autoScroll();
}, [autoScroll]);

// After:
const handleThinkingEvent = useCallback((thought: string) => {
  setShimmerText(thought ? 'Thinking…' : '');
  if (thought) autoScroll();
}, [autoScroll]);
```

### `handleStreamTextChunk` — clear shimmer on first text

Add `setShimmerText('')` as the first line of the handler body (after `ensureAssistantReplayMessage()`):

```typescript
const handleStreamTextChunk = useCallback((chunk: string) => {
  ensureAssistantReplayMessage();
  setShimmerText('');           // ← clear shimmer the moment text arrives
  // ... rest of existing logic unchanged
}, [...]);
```

### `handleWorkflowPlanTextEvent` and `handleWorkflowPlanResetEvent` — remove status clear

Both handlers call `setStatusText('')` as a side-clear (lines 553 and 560). Remove these lines — no replacement needed (workflow plan streaming has its own dedicated UI; shimmer is not involved):

```typescript
// handleWorkflowPlanTextEvent: remove the setStatusText('') line
// handleWorkflowPlanResetEvent: remove the setStatusText('') line
```

### `handleStop`, `handleSend` (success + error paths) — replace `setStatusText('')` with `setShimmerText('')`

All `setStatusText('')` calls in `handleStop` (line 881), `handleSend` success path (line 859), and `handleSend` error path (line 870) become `setShimmerText('')`.

### `handlePause` and `handleResume` — drop status text entirely

These currently set `statusText` to transient messages ("Paused…", "Resuming…"). These are not replaced with shimmer — they are simply removed. Pause/resume state is already visible via the `InputBar` buttons.

```typescript
// Before:
const handlePause = useCallback(() => {
  (window as any).clawdia?.chat.pause();
  setIsPaused(true);
  setStatusText('Paused — type to add context, or resume');
}, []);

const handleResume = useCallback(() => {
  (window as any).clawdia?.chat.resume();
  setIsPaused(false);
  setStatusText('Resuming...');
}, []);

// After:
const handlePause = useCallback(() => {
  (window as any).clawdia?.chat.pause();
  setIsPaused(true);
}, []);

const handleResume = useCallback(() => {
  (window as any).clawdia?.chat.resume();
  setIsPaused(false);
}, []);
```

### `handleAddContext` — drop status text

```typescript
// Before:
setStatusText('Context added — will be used in next iteration');

// After:
// (line removed — no replacement)
```

### Load effects — replace `setStatusText('')` with `setShimmerText('')`

All `setStatusText('')` calls in the conversation-load `useEffect` blocks (approximately lines 663, 677, 694) become `setShimmerText('')`.

---

## `ensureAssistantReplayMessage` — set initial shimmer

When this function creates a new assistant message (the run is just starting), set the shimmer to `"Thinking…"` as the initial state before any tool fires:

```typescript
// Add at the end of the new-message creation branch, before `return assistantId`:
setShimmerText('Thinking…');
```

---

## Remove `StatusLine` from `ChatPanel` render

Delete line 1024:
```tsx
{isStreaming && <StatusLine text={statusText} />}
```

---

## Remove `statusText` state

Once all `setStatusText` and `statusText` references are replaced, remove the state declaration:

```typescript
// Remove:
const [statusText, setStatusText] = useState<string>('');
```

Verify no remaining references to `statusText` exist before removing.

---

## Testing

- **Short run (single tool):** shimmer "Thinking…" → "Running command…" → text replaces shimmer → no flash, no layout shift
- **Multi-tool run:** shimmer text swaps instantly on each tool — never stacks, always same position
- **LLM-only run (no tool calls):** shimmer shows "Thinking…" → text replaces it
- **Cancelled/stopped run:** shimmer clears cleanly
- **Historical messages:** render with no shimmer, no tool cards, content only
- **Swarm tasks:** shimmer shows "Spawning agent…" during `agent_spawn`
- **Approval/pause states:** `ApprovalBanner` and `InputBar` state handle those UI cues; shimmer is blank
- **TerminalLogStrip:** shell output still appears below chat as before — unaffected

---

## Out of Scope

- Approval UI (`awaiting_approval`, `needs_human`) beyond the shimmer label — separate feature
- `ToolActivity.tsx`, `StatusLine.tsx` cleanup/deletion — deferred
- Tool output visibility after removal — a future expandable detail design is out of scope
