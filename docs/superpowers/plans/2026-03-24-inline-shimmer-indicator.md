# Inline Shimmer Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all in-chat activity UI (tool cards, status bar) with a single inline shimmer text line that sits between the user message and the LLM response, universal across all task types, models, and providers.

**Architecture:** A new `shimmerText: string` state in `ChatPanel` replaces `statusText`. The `InlineShimmer` component renders inside `AssistantMessage` as `{message.isStreaming && shimmerText && !hasText && <InlineShimmer text={shimmerText} />}` — same DOM position every time, disappears the moment text arrives. All `ToolActivity` renders are removed (live feed path + historical fallback). `StatusLine` bar at line 1024 is deleted.

**Tech Stack:** React, TypeScript, Tailwind CSS, existing `@keyframes status-shimmer` animation in `src/renderer/index.css`

---

## Files

- **Modify:** `src/renderer/index.css` — add `.inline-shimmer` CSS class (reuses existing `status-shimmer` keyframe)
- **Modify:** `src/renderer/components/ChatPanel.tsx` — all changes described below

No new files needed. `ToolActivity.tsx` and `StatusLine.tsx` are **not deleted** — they just stop being rendered.

---

## Task 1: Add `.inline-shimmer` CSS class

**Files:**
- Modify: `src/renderer/index.css` (around line 153, after `.status-shimmer-text`)

- [ ] **Step 1: Open `src/renderer/index.css` and locate the shimmer section**

  Look for line ~143 where `.status-shimmer-text` is defined. The `@keyframes status-shimmer` keyframe that this class uses is defined just above it.

- [ ] **Step 2: Add the `.inline-shimmer` class immediately after `.status-shimmer-text`**

  Insert the following block after `.status-shimmer-text { ... }` ends (currently around line 153):

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

- [ ] **Step 3: Verify the file looks correct around that section**

  Run: `grep -n "inline-shimmer\|status-shimmer" src/renderer/index.css`

  Expected: see `status-shimmer` keyframe, `.status-shimmer-text`, and new `.inline-shimmer` class all listed.

- [ ] **Step 4: Commit**

  ```bash
  git add src/renderer/index.css
  git commit -m "feat: add .inline-shimmer CSS class reusing status-shimmer keyframe"
  ```

---

## Task 2: Add `shimmerText` state and helpers to `ChatPanel`

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx`

This task adds the new state, the two helper functions (`extractHostname`, `toolToShimmerLabel`), and the `InlineShimmer` component — all before any existing logic is changed.

- [ ] **Step 1: Add `shimmerText` state**

  At line 452, the state declarations begin. The current line 452 reads:
  ```typescript
  const [statusText, setStatusText] = useState('');
  ```

  Add a new line immediately after it:
  ```typescript
  const [shimmerText, setShimmerText] = useState<string>('');
  ```

  Do NOT remove `statusText` yet — it will be removed in Task 5 once all references are replaced.

- [ ] **Step 2: Add helper functions and `InlineShimmer` component**

  These must be defined **outside** the `ChatPanel` function (at module scope), placed just above the `ChatPanel` function definition (line 448). Insert the following block between the `UserMessage` component (which ends around line 446) and `export default function ChatPanel`:

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

  function InlineShimmer({ text }: { text: string }) {
    return <span className="inline-shimmer">{text}</span>;
  }
  ```

- [ ] **Step 3: Verify TypeScript compiles without errors**

  Run: `npx tsc --noEmit 2>&1 | head -30`

  Expected: No new errors (there may be pre-existing ones; count them before and confirm no increase).

- [ ] **Step 4: Commit**

  ```bash
  git add src/renderer/components/ChatPanel.tsx
  git commit -m "feat: add shimmerText state, toolToShimmerLabel helper, InlineShimmer component"
  ```

---

## Task 3: Update `AssistantMessage` to accept and render `shimmerText`

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx` — `AssistantMessage` component (lines 358–430)

- [ ] **Step 1: Update the `AssistantMessage` props interface**

  Line 358 currently reads:
  ```typescript
  const AssistantMessage = React.memo(function AssistantMessage({ message, streamMap }: { message: Message; streamMap?: ToolStreamMap }) {
  ```

  Change it to:
  ```typescript
  const AssistantMessage = React.memo(function AssistantMessage({ message, streamMap, shimmerText }: { message: Message; streamMap?: ToolStreamMap; shimmerText?: string }) {
  ```

- [ ] **Step 2: Update the live-feed render path (lines 384–402)**

  The current live-feed `return` block (inside the `if (message.feed && message.feed.length > 0)` branch) reads:

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

  Replace with:

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

- [ ] **Step 3: Update the historical fallback render path (lines 409–422)**

  The fallback `return` block currently reads:

  ```tsx
  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
        {hasTools && <div className={hasContent ? 'mb-3' : ''}><ToolActivity tools={message.toolCalls!} streamMap={{}} /></div>}
        {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
        {hasContent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[11px] text-text-secondary/70">{message.timestamp}</span>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    </div>
  );
  ```

  Replace with (remove the `hasTools &&` block entirely):

  ```tsx
  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
        {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
        {hasContent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[11px] text-text-secondary/70">{message.timestamp}</span>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    </div>
  );
  ```

  Note: Keep the `hasContent` guard in the early-return at line 408 — it correctly prevents rendering empty historical messages.

- [ ] **Step 4: Update the memo comparator (lines 423–430)**

  The current memo comparator reads:
  ```typescript
  }, (prev, next) => {
    // Skip re-render for finished messages — their data never changes
    if (!prev.message.isStreaming && !next.message.isStreaming) {
      return prev.message.id === next.message.id;
    }
    // Always re-render the actively streaming message
    return false;
  });
  ```

  Replace with:
  ```typescript
  }, (prev, next) => {
    // Skip re-render for finished messages — their data never changes
    if (!prev.message.isStreaming && !next.message.isStreaming) {
      return prev.message.id === next.message.id;
    }
    // Re-render when shimmerText changes (keeps shimmer in sync)
    if (prev.shimmerText !== next.shimmerText) return false;
    // Always re-render the actively streaming message
    return false;
  });
  ```

- [ ] **Step 5: Update the `AssistantMessage` call site (line 998)**

  Currently:
  ```tsx
  <AssistantMessage key={msg.id} message={msg} streamMap={msg.isStreaming ? streamMap : undefined} />
  ```

  Change to:
  ```tsx
  <AssistantMessage key={msg.id} message={msg} streamMap={msg.isStreaming ? streamMap : undefined} shimmerText={msg.isStreaming ? shimmerText : undefined} />
  ```

- [ ] **Step 6: Verify TypeScript compiles**

  Run: `npx tsc --noEmit 2>&1 | head -30`

  Expected: No new errors.

- [ ] **Step 7: Commit**

  ```bash
  git add src/renderer/components/ChatPanel.tsx
  git commit -m "feat: thread shimmerText prop through AssistantMessage, remove ToolActivity renders"
  ```

---

## Task 4: Update all event handlers to use `shimmerText`

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx` — handlers section (lines 508–933)

Work through each handler in order. Do all changes in one pass, then compile and commit.

- [ ] **Step 1: Update `ensureAssistantReplayMessage` — add initial shimmer**

  At the end of the new-message creation branch inside `ensureAssistantReplayMessage` (currently lines 508–521), before `return assistantId`, add:
  ```typescript
  setShimmerText('Thinking…');
  ```

  The function currently reads:
  ```typescript
  const ensureAssistantReplayMessage = useCallback(() => {
    if (assistantMsgIdRef.current) return assistantMsgIdRef.current;
    const assistantId = `assistant-replay-${Date.now()}`;
    assistantMsgIdRef.current = assistantId;
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      isStreaming: true,
    }]);
    setIsStreaming(true);
    return assistantId;
  }, []);
  ```

  Change to:
  ```typescript
  const ensureAssistantReplayMessage = useCallback(() => {
    if (assistantMsgIdRef.current) return assistantMsgIdRef.current;
    const assistantId = `assistant-replay-${Date.now()}`;
    assistantMsgIdRef.current = assistantId;
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      isStreaming: true,
    }]);
    setIsStreaming(true);
    setShimmerText('Thinking…');
    return assistantId;
  }, []);
  ```

- [ ] **Step 2: Update `handleStreamTextChunk` — clear shimmer on first text**

  Current handler (lines 523–543):
  ```typescript
  const handleStreamTextChunk = useCallback((chunk: string) => {
    ensureAssistantReplayMessage();
    if (chunk.includes('__RESET__')) {
      ...
    }
    ...
    setStatusText('');
    scheduleStreamUpdate();
  }, [ensureAssistantReplayMessage, scheduleStreamUpdate]);
  ```

  Two changes:
  1. Add `setShimmerText('');` as the **first line** after `ensureAssistantReplayMessage();`
  2. Change `setStatusText('');` (line 541) to `setShimmerText('');`

  Result:
  ```typescript
  const handleStreamTextChunk = useCallback((chunk: string) => {
    ensureAssistantReplayMessage();
    setShimmerText('');           // clear shimmer the moment text arrives
    if (chunk.includes('__RESET__')) {
      const lastIdx = feedRef.current.length - 1;
      if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
        feedRef.current[lastIdx] = { ...feedRef.current[lastIdx], isStreaming: false } as FeedItem;
      }
      scheduleStreamUpdate();
      return;
    }

    const lastIdx = feedRef.current.length - 1;
    if (lastIdx >= 0 && feedRef.current[lastIdx].kind === 'text') {
      const last = feedRef.current[lastIdx] as { kind: 'text'; text: string; isStreaming?: boolean };
      feedRef.current[lastIdx] = { kind: 'text', text: last.text + chunk, isStreaming: true };
    } else {
      feedRef.current.push({ kind: 'text', text: chunk, isStreaming: true });
    }
    scheduleStreamUpdate();
  }, [ensureAssistantReplayMessage, scheduleStreamUpdate]);
  ```

  Note: the `setShimmerText('')` on the `setStatusText('')` line effectively becomes redundant (already cleared at top), but removing it keeps the diff cleaner — just replace the `setStatusText('')` with `setShimmerText('')`.

- [ ] **Step 3: Update `handleThinkingEvent`**

  Current (lines 545–548):
  ```typescript
  const handleThinkingEvent = useCallback((thought: string) => {
    setStatusText(thought || '');
    if (thought) autoScroll();
  }, [autoScroll]);
  ```

  Replace with:
  ```typescript
  const handleThinkingEvent = useCallback((thought: string) => {
    setShimmerText(thought ? 'Thinking…' : '');
    if (thought) autoScroll();
  }, [autoScroll]);
  ```

- [ ] **Step 4: Update `handleWorkflowPlanTextEvent` — remove `setStatusText('')`**

  Current (lines 550–555):
  ```typescript
  const handleWorkflowPlanTextEvent = useCallback((chunk: string) => {
    setWorkflowPlanDraft(prev => prev + chunk);
    setIsWorkflowPlanStreaming(true);
    setStatusText('');
    requestAnimationFrame(() => autoScroll());
  }, [autoScroll]);
  ```

  Remove only the `setStatusText('');` line. No replacement — shimmer is not involved in workflow plan streaming.

  Result:
  ```typescript
  const handleWorkflowPlanTextEvent = useCallback((chunk: string) => {
    setWorkflowPlanDraft(prev => prev + chunk);
    setIsWorkflowPlanStreaming(true);
    requestAnimationFrame(() => autoScroll());
  }, [autoScroll]);
  ```

- [ ] **Step 5: Update `handleWorkflowPlanResetEvent` — remove `setStatusText('')`**

  Current (lines 557–561):
  ```typescript
  const handleWorkflowPlanResetEvent = useCallback(() => {
    setWorkflowPlanDraft('');
    setIsWorkflowPlanStreaming(true);
    setStatusText('');
  }, []);
  ```

  Remove only the `setStatusText('');` line. No replacement.

  Result:
  ```typescript
  const handleWorkflowPlanResetEvent = useCallback(() => {
    setWorkflowPlanDraft('');
    setIsWorkflowPlanStreaming(true);
  }, []);
  ```

- [ ] **Step 6: Replace `handleToolActivityEvent` entirely**

  The current handler (lines 567–610) pushes `{ kind: 'tool' }` items to `feedRef` and calls `setStatusText`. Replace it entirely with the new shimmer-only version:

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

  Note: `handleToolStreamEvent` (lines 612–620) is **not changed** — it feeds `streamMap` for `TerminalLogStrip`.

- [ ] **Step 7: Update `handleStreamEndEvent` — replace `setStatusText('')`**

  In `handleStreamEndEvent` (lines 622–644), find:
  ```typescript
  setStatusText('');
  ```
  (around line 642)

  Replace with:
  ```typescript
  setShimmerText('');
  ```

- [ ] **Step 8: Update `handleStop` — replace `setStatusText('')`**

  In `handleStop` (lines 877–882), find:
  ```typescript
  setStatusText('');
  ```

  Replace with:
  ```typescript
  setShimmerText('');
  ```

- [ ] **Step 9: Update `handlePause` — remove `setStatusText(...)`**

  Current (lines 884–888):
  ```typescript
  const handlePause = useCallback(() => {
    (window as any).clawdia?.chat.pause();
    setIsPaused(true);
    setStatusText('Paused — type to add context, or resume');
  }, []);
  ```

  Replace with (remove the `setStatusText` line entirely — no replacement):
  ```typescript
  const handlePause = useCallback(() => {
    (window as any).clawdia?.chat.pause();
    setIsPaused(true);
  }, []);
  ```

- [ ] **Step 10: Update `handleResume` — remove `setStatusText(...)`**

  Current (lines 890–894):
  ```typescript
  const handleResume = useCallback(() => {
    (window as any).clawdia?.chat.resume();
    setIsPaused(false);
    setStatusText('Resuming...');
  }, []);
  ```

  Replace with:
  ```typescript
  const handleResume = useCallback(() => {
    (window as any).clawdia?.chat.resume();
    setIsPaused(false);
  }, []);
  ```

- [ ] **Step 11: Update `handleAddContext` — remove `setStatusText(...)`**

  In `handleAddContext` (lines 921–933), find:
  ```typescript
  setStatusText('Context added — will be used in next iteration');
  ```

  Remove that line entirely. No replacement.

- [ ] **Step 12: Update `handleSend` — replace both `setStatusText('')` calls**

  In `handleSend` (lines 807–875), there are two `setStatusText('')` calls:
  - Success path (around line 859): replace with `setShimmerText('')`
  - Error path (around line 870): replace with `setShimmerText('')`

- [ ] **Step 13: Update the load `useEffect` blocks — replace all `setStatusText('')` calls**

  There are three `setStatusText('')` calls in useEffect blocks:
  1. Line ~663 (replay buffer branch inside `loadConversationId` effect): replace with `setShimmerText('')`
  2. Line ~677 (DB load branch inside same effect): replace with `setShimmerText('')`
  3. Line ~694 (replay buffer reconstruction effect): replace with `setShimmerText('')`

- [ ] **Step 14: Verify TypeScript compiles**

  Run: `npx tsc --noEmit 2>&1 | head -30`

  Expected: No new errors.

- [ ] **Step 15: Commit**

  ```bash
  git add src/renderer/components/ChatPanel.tsx
  git commit -m "feat: replace all statusText handler logic with shimmerText"
  ```

---

## Task 5: Remove `StatusLine` from render and delete `statusText` state

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx`

This is the cleanup task. Only run it after all previous tasks pass TypeScript compilation.

- [ ] **Step 1: Delete the `StatusLine` render at line 1024**

  Find the line:
  ```tsx
  {isStreaming && <StatusLine text={statusText} />}
  ```

  Delete it entirely.

- [ ] **Step 2: Remove the `statusText` state declaration**

  Find:
  ```typescript
  const [statusText, setStatusText] = useState('');
  ```

  Delete it entirely.

- [ ] **Step 3: Verify no remaining references to `statusText` or `setStatusText`**

  Run: `grep -n "statusText\|setStatusText" src/renderer/components/ChatPanel.tsx`

  Expected: No output. If any references remain, fix them before proceeding.

- [ ] **Step 4: TypeScript compile check**

  Run: `npx tsc --noEmit 2>&1 | head -30`

  Expected: No new errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/renderer/components/ChatPanel.tsx
  git commit -m "feat: remove StatusLine render and statusText state — replaced by shimmerText"
  ```

---

## Final Verification

- [ ] **Run TypeScript compile one final time**

  Run: `npx tsc --noEmit 2>&1 | head -30`

  Expected: No new errors introduced by this feature.

- [ ] **Grep for any stray `ToolActivity` renders in `ChatPanel.tsx`**

  Run: `grep -n "ToolActivity" src/renderer/components/ChatPanel.tsx`

  Expected: No output (the import at line 5 may remain — that's fine per spec, `ToolActivity.tsx` is kept but not rendered).

- [ ] **Grep confirms `StatusLine` is no longer rendered**

  Run: `grep -n "StatusLine" src/renderer/components/ChatPanel.tsx`

  Expected: Only the import line remains (line 4). If `<StatusLine` appears in JSX, that's a bug — fix it.

- [ ] **Grep confirms `shimmerText` is wired end-to-end**

  Run: `grep -n "shimmerText\|setShimmerText\|InlineShimmer\|inline-shimmer" src/renderer/components/ChatPanel.tsx`

  Expected: see state declaration, `setShimmerText` calls in all handlers, `shimmerText` prop passed to `AssistantMessage`, `InlineShimmer` definition and usage.

---

## Testing Checklist (manual, in the running app)

After building (`npm run dev` or `npm start`):

1. **LLM-only run (no tools):** Send a message. Shimmer shows "Thinking…" before any response text appears. Text replaces shimmer with no layout shift or flash.
2. **Single tool run:** Shimmer shows "Thinking…" → switches to tool label (e.g. "Running command…") → text replaces shimmer cleanly.
3. **Multi-tool run:** Each tool fires, shimmer text swaps instantly at the same position — never stacks, no growing block of activity cards.
4. **Long-running run:** Shimmer cycles through multiple tools. Chat does not jump or oscillate.
5. **Cancelled/stopped run:** Click Stop — shimmer clears immediately.
6. **Historical messages:** Load an old conversation. No shimmer, no tool cards — only message text renders.
7. **Swarm tasks:** `agent_spawn` tools show "Spawning agent…".
8. **Terminal log strip:** Shell output still appears below chat as before (unaffected).
9. **Approval/pause states:** `ApprovalBanner` and `InputBar` controls still work correctly; shimmer is blank during approval.
