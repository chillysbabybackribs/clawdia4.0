# Terminal Log Strip + Message Flow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the chat UI so LLM narration text is permanently preserved paired with its tool cards, remove the "Working..." indicator, and add a live terminal log strip below the message area.

**Architecture:** Replace the flat `streamBufferRef` + `toolCallsRef` refs in `ChatPanel` with an iteration model (`iterationsRef`, `currentTextRef`, `currentToolsRef`, `routeToSealedRef`) that pairs each LLM response's narration text with the tool calls that followed it. `AssistantMessage` is rewritten to render iterations in sequence. A new `TerminalLogStrip` component renders live shell output from `streamMap` below the scroll area.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Electron IPC (existing patterns)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add `MessageIteration` type; add `iterations?` to `Message` |
| `src/renderer/components/ChatPanel.tsx` | Modify | Replace streaming refs; rewrite event handlers; rewrite `AssistantMessage`; remove "Working..."; render `TerminalLogStrip` |
| `src/renderer/components/TerminalLogStrip.tsx` | **Create** | Live 72px strip + post-stream collapsed toggle |
| `src/renderer/index.css` | Modify | Add `.terminal-log-strip` scoped 3px scrollbar |

**Not changed:** `ToolActivity.tsx`, DB layer, `handleRateTool`, `StatusLine`.

---

## Task 1: Add `MessageIteration` type to `types.ts`

**Files:**
- Modify: `src/shared/types.ts`

This is the foundation — all other tasks depend on the type being in place.

- [ ] **Step 1: Read the current file**

Open `src/shared/types.ts`. Confirm current `Message` interface fields: `id`, `role`, `content`, `timestamp`, `toolCalls?`, `isStreaming?`.

- [ ] **Step 2: Add `MessageIteration` interface and update `Message`**

In `src/shared/types.ts`, add the new interface BEFORE the `Message` interface, and add `iterations?` to `Message`:

```typescript
export interface MessageIteration {
  text: string;          // LLM narration for this iteration (may be '')
  toolCalls: ToolCall[]; // tool calls dispatched after this text (may be [])
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  iterations?: MessageIteration[];   // renderer-only — NOT persisted to DB
  isStreaming?: boolean;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0
npx tsc --noEmit 2>&1 | head -30
```

Expected: zero errors (or only pre-existing errors unrelated to types.ts).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add MessageIteration type to Message for iteration-paired rendering"
```

---

## Task 2: Create `TerminalLogStrip` component

**Files:**
- Create: `src/renderer/components/TerminalLogStrip.tsx`

This component is self-contained and can be built and verified independently before wiring into ChatPanel.

- [ ] **Step 1: Create the file**

Create `src/renderer/components/TerminalLogStrip.tsx` with this exact content:

```tsx
import React, { useEffect, useRef, useState } from 'react';

interface TerminalLogStripProps {
  lines: string[];
  isStreaming: boolean;
}

const DIM_RE = /^\[(?:LLM|stderr|Harness|Router|Agent|Install|Setup|Recall|Playbook)\]/i;

function classifyLine(line: string): 'dim' | 'cmd' | 'out' {
  if (DIM_RE.test(line)) return 'dim';
  if (line.startsWith('$') || line.startsWith('>')) return 'cmd';
  return 'out';
}

const LINE_COLORS: Record<'dim' | 'cmd' | 'out', string> = {
  dim: 'rgba(255,255,255,0.25)',
  cmd: 'rgba(255,255,255,0.38)',
  out: 'rgba(255,255,255,0.72)',
};

export default function TerminalLogStrip({ lines, isStreaming }: TerminalLogStripProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new lines arrive during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, isStreaming]);

  // Reset collapsed state when a new stream starts
  useEffect(() => {
    if (isStreaming) setExpanded(false);
  }, [isStreaming]);

  if (!isStreaming && lines.length === 0) return null;

  if (isStreaming) {
    return (
      <div
        className="terminal-log-strip"
        style={{
          borderTop: '1px solid rgba(255,255,255,0.07)',
          background: '#080a0f',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
          fontSize: '10.5px',
          lineHeight: '1.55',
          padding: '5px 14px',
          height: '72px',
          overflowY: 'auto',
          flexShrink: 0,
        }}
        ref={scrollRef}
      >
        {lines.map((line, i) => {
          const kind = classifyLine(line);
          return (
            <div key={i} style={{ color: LINE_COLORS[kind] }}>{line}</div>
          );
        })}
      </div>
    );
  }

  // Post-stream: collapsed toggle
  return (
    <div
      className="terminal-log-strip"
      style={{
        borderTop: '1px solid rgba(255,255,255,0.07)',
        background: '#080a0f',
        flexShrink: 0,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(e => !e)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(v => !v); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 14px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: '10.5px',
          color: 'rgba(255,255,255,0.32)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          terminal log
        </span>
        <span style={{
          color: 'rgba(255,255,255,0.25)',
          fontSize: '12px',
          lineHeight: '1',
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}>
          &#8964;
        </span>
      </div>

      {expanded && (
        <div
          ref={scrollRef}
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: '10.5px',
            lineHeight: '1.55',
            padding: '0 14px 8px',
            borderTop: '1px solid rgba(255,255,255,0.04)',
            maxHeight: '120px',
            overflowY: 'auto',
          }}
        >
          {lines.map((line, i) => {
            const kind = classifyLine(line);
            // Slightly dimmer in collapsed-expanded view
            const color = kind === 'out' ? 'rgba(255,255,255,0.65)'
              : kind === 'cmd' ? 'rgba(255,255,255,0.30)'
              : 'rgba(255,255,255,0.20)';
            return (
              <div key={i} style={{ color }}>{line}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0
npx tsc --noEmit 2>&1 | head -30
```

Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/TerminalLogStrip.tsx
git commit -m "feat: add TerminalLogStrip component — live 72px strip + collapsed toggle"
```

---

## Task 3: Add scoped scrollbar CSS to `index.css`

**Files:**
- Modify: `src/renderer/index.css`

- [ ] **Step 1: Read the current scrollbar block**

Open `src/renderer/index.css`. Confirm the global scrollbar rules start around line 5:
```css
::-webkit-scrollbar { width: 6px; }
```

- [ ] **Step 2: Append scoped scrollbar rules**

Add these rules at the end of `src/renderer/index.css` (after all existing rules):

```css
/* ── Terminal log strip — scoped 3px scrollbar ── */
.terminal-log-strip ::-webkit-scrollbar { width: 3px; }
.terminal-log-strip ::-webkit-scrollbar-track { background: transparent; }
.terminal-log-strip ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
.terminal-log-strip ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.css
git commit -m "style: add scoped 3px scrollbar for terminal-log-strip"
```

---

## Task 4: Rewrite `ChatPanel` — iteration model + message flow fix

**Files:**
- Modify: `src/renderer/components/ChatPanel.tsx`

This is the main task. Make all changes to `ChatPanel.tsx` in one pass. Read the file first, then apply the changes below precisely.

**Background:** The current `ChatPanel` uses two flat refs:
- `streamBufferRef` — one text blob, wiped on `__RESET__`
- `toolCallsRef` — flat tool list

We replace these with four refs that pair text with tools per LLM iteration. We also rewrite `AssistantMessage` entirely and remove the "Working..." block.

- [ ] **Step 1: Read `ChatPanel.tsx`**

Open `src/renderer/components/ChatPanel.tsx`. Identify the exact current code for:
1. The ref declarations (lines 146-151 area)
2. `flushStreamUpdate` (lines 182-195)
3. `onStreamText` handler inside `useEffect` (lines 212-225)
4. `onToolActivity` handler (lines 231-261)
5. `handleSend` reset block (lines 299-304)
6. Stream-end block inside `handleSend` (lines 316-331)
7. `AssistantMessage` function (lines 75-125)
8. The `TerminalLogStrip` render location (between scroll div and `InputBar`, currently absent)

- [ ] **Step 2: Add `TerminalLogStrip` import**

At the top of the file, after the existing imports, add:

```tsx
import TerminalLogStrip from './TerminalLogStrip';
```

Also add `MessageIteration` to the types import:

```tsx
import type { Message, ToolCall, MessageIteration } from '../../shared/types';
```

- [ ] **Step 3: Replace the flat streaming refs**

Find and replace the ref declarations block. Current:
```tsx
const streamBufferRef = useRef('');       // latest text from the LLM (resets each iteration)
const toolCallsRef = useRef<ToolCall[]>([]);
const assistantMsgIdRef = useRef<string | null>(null);
const hasToolsRunningRef = useRef(false); // true when tools are executing
```

Replace with:
```tsx
interface LiveIteration {
  text: string;
  toolCalls: ToolCall[];
}
const iterationsRef = useRef<LiveIteration[]>([]);   // sealed iterations
const currentTextRef = useRef('');                    // text for current (unsealed) iteration
const currentToolsRef = useRef<ToolCall[]>([]);      // tools for current iteration
const routeToSealedRef = useRef(false);               // true = next tool(s) go into iterationsRef[last]
const assistantMsgIdRef = useRef<string | null>(null);
```

(Remove `hasToolsRunningRef` — it is no longer needed.)

- [ ] **Step 4: Rewrite `flushStreamUpdate`**

Find the current `flushStreamUpdate` function and replace it entirely:

```tsx
const flushStreamUpdate = useCallback(() => {
  if (!assistantMsgIdRef.current) return;
  const inFlight: LiveIteration = { text: currentTextRef.current, toolCalls: [...currentToolsRef.current] };
  const liveIterations: LiveIteration[] = [...iterationsRef.current];
  if (inFlight.text || inFlight.toolCalls.length > 0) {
    liveIterations.push(inFlight);
  }
  setMessages(prev => {
    const idx = prev.findIndex(m => m.id === assistantMsgIdRef.current);
    if (idx === -1) return prev;
    const updated = [...prev];
    updated[idx] = { ...updated[idx], iterations: liveIterations as MessageIteration[], isStreaming: true };
    return updated;
  });
  pendingUpdateRef.current = false;
  requestAnimationFrame(() => autoScroll());
}, [autoScroll]);
```

- [ ] **Step 5: Rewrite the `onStreamText` handler**

Find this block inside the `useEffect`:
```tsx
cleanups.push(api.chat.onStreamText((chunk: string) => {
  if (chunk.includes('__RESET__')) {
    streamBufferRef.current = '';
    hasToolsRunningRef.current = false;
    scheduleStreamUpdate();
    return;
  }
  streamBufferRef.current += chunk;
  setStatusText('');
  scheduleStreamUpdate();
}));
```

Replace with:
```tsx
cleanups.push(api.chat.onStreamText((chunk: string) => {
  if (chunk.includes('__RESET__')) {
    // Seal current text+tools as a completed iteration
    iterationsRef.current.push({ text: currentTextRef.current, toolCalls: [] });
    currentTextRef.current = '';
    currentToolsRef.current = [];
    routeToSealedRef.current = true; // next tool(s) belong to the just-sealed iteration
    scheduleStreamUpdate();
    return;
  }
  currentTextRef.current += chunk;
  setStatusText('');
  scheduleStreamUpdate();
}));
```

- [ ] **Step 6: Rewrite the `onToolActivity` handler**

Find the entire `onToolActivity` handler block (from `cleanups.push(api.chat.onToolActivity(` to its closing `}));`) and replace with:

```tsx
cleanups.push(api.chat.onToolActivity((activity: { name: string; status: string; detail?: string }) => {
  if (activity.status === 'running') {
    const newTool: ToolCall = {
      id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: activity.name,
      status: 'running',
      detail: activity.detail,
    };

    // If no iterations sealed yet, LLM emitted tools with zero text — create empty target
    if (iterationsRef.current.length === 0) {
      iterationsRef.current.push({ text: '', toolCalls: [] });
    }

    if (routeToSealedRef.current) {
      // Belongs to the just-sealed iteration (post-__RESET__)
      iterationsRef.current[iterationsRef.current.length - 1].toolCalls.push(newTool);
      routeToSealedRef.current = false; // cleared after first tool placed — rest go to current
    } else {
      currentToolsRef.current.push(newTool);
    }

    scheduleStreamUpdate();

    const detail = activity.detail ? ` — ${activity.detail.slice(0, 50)}` : '';
    setStatusText(`Running ${activity.name}${detail}`);
  } else {
    // Tool completed (success or error) — find and update by name match
    const updatedTool: ToolCall = {
      id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: activity.name,
      status: activity.status as ToolCall['status'],
      detail: activity.detail,
    };

    let found = false;
    for (let i = iterationsRef.current.length - 1; i >= 0; i--) {
      const iter = iterationsRef.current[i];
      const idx = iter.toolCalls.map((t, j) => ({ t, j })).reverse()
        .find(({ t }) => t.name === activity.name && t.status === 'running')?.j ?? -1;
      if (idx >= 0) {
        iter.toolCalls[idx] = updatedTool;
        found = true;
        break;
      }
    }
    if (!found) {
      const idx = currentToolsRef.current.map((t, j) => ({ t, j })).reverse()
        .find(({ t }) => t.name === activity.name && t.status === 'running')?.j ?? -1;
      if (idx >= 0) currentToolsRef.current[idx] = updatedTool;
    }

    scheduleStreamUpdate();

    if (activity.status === 'success') {
      setStatusText(`Completed ${activity.name}`);
    } else if (activity.status === 'error') {
      setStatusText(`Failed: ${activity.name}`);
    }
  }
  autoScroll();
}));
```

- [ ] **Step 7: Update `handleSend` reset block**

Find the reset block in `handleSend` (current):
```tsx
const assistantId = `assistant-${Date.now()}`;
assistantMsgIdRef.current = assistantId;
streamBufferRef.current = '';
toolCallsRef.current = [];
hasToolsRunningRef.current = false;
setStreamMap({});
```

Replace with:
```tsx
const assistantId = `assistant-${Date.now()}`;
assistantMsgIdRef.current = assistantId;
iterationsRef.current = [];
currentTextRef.current = '';
currentToolsRef.current = [];
routeToSealedRef.current = false;
setStreamMap({});
```

- [ ] **Step 8: Update stream-end finalization in `handleSend`**

Find the stream-end block inside the `try {}` in `handleSend` (current):
```tsx
const finalContent = result.response || streamBufferRef.current || '';
const finalTools = result.toolCalls?.map((tc: any, i: number) => ({
  ...tc, id: tc.id || `tc-${i}`
})) || [...toolCallsRef.current];

if (result.error) {
  setMessages(prev => prev.map(m =>
    m.id === assistantId ? { ...m, content: `⚠️ ${result.error}`, isStreaming: false, toolCalls: [] } : m
  ));
} else {
  setMessages(prev => prev.map(m =>
    m.id === assistantId ? { ...m, content: finalContent, toolCalls: finalTools, isStreaming: false } : m
  ));
}
```

Replace with:
```tsx
const allText = [...iterationsRef.current, { text: currentTextRef.current }]
  .map(it => it.text).filter(Boolean).join('\n\n');
const finalContent = result.response || allText || '';
const finalTools = iterationsRef.current.flatMap(it => it.toolCalls)
  .concat(currentToolsRef.current);
const finalInFlight = { text: currentTextRef.current, toolCalls: [...currentToolsRef.current] };
const finalIterations = [...iterationsRef.current];
if (finalInFlight.text || finalInFlight.toolCalls.length > 0) finalIterations.push(finalInFlight);

if (result.error) {
  setMessages(prev => prev.map(m =>
    m.id === assistantId ? { ...m, content: `⚠️ ${result.error}`, isStreaming: false, toolCalls: [], iterations: [] } : m
  ));
} else {
  setMessages(prev => prev.map(m =>
    m.id === assistantId
      ? { ...m, content: finalContent, toolCalls: finalTools, iterations: finalIterations as MessageIteration[], isStreaming: false }
      : m
  ));
}
```

- [ ] **Step 9: Rewrite `AssistantMessage`**

Find the entire `AssistantMessage` function (lines 75–125) and replace with:

```tsx
function AssistantMessage({ message, streamMap }: { message: Message; streamMap?: ToolStreamMap }) {
  const activeStreamMap = message.isStreaming ? (streamMap ?? {}) : {};

  if (message.iterations && message.iterations.length > 0) {
    const iters = message.iterations;
    return (
      <div className="flex justify-start animate-slide-up group">
        <div className="max-w-[92%] px-1 py-2 text-text-primary">
          {iters.map((iter, i) => {
            const isLastIter = i === iters.length - 1;
            const hasText = !!iter.text;
            const hasTools = iter.toolCalls.length > 0;
            if (!hasText && !hasTools) return null;
            return (
              <div key={i} className={!isLastIter ? 'mb-3' : ''}>
                {hasText && (
                  <div className={hasTools ? 'mb-2' : ''}>
                    <MarkdownRenderer
                      content={iter.text}
                      isStreaming={message.isStreaming === true && isLastIter && !hasTools}
                    />
                  </div>
                )}
                {hasTools && (
                  <ToolActivity tools={iter.toolCalls} streamMap={activeStreamMap} />
                )}
              </div>
            );
          })}
          {!message.isStreaming && message.content && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] text-text-secondary/70">{message.timestamp}</span>
              <CopyButton text={message.content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: DB-loaded historical messages (no iterations field)
  const hasContent = !!message.content?.trim();
  const hasTools = !!message.toolCalls?.length;
  if (!hasContent && !hasTools) return null;
  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
        {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
        {hasTools && <ToolActivity tools={message.toolCalls!} streamMap={{}} />}
        {hasContent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] text-text-secondary/70">{message.timestamp}</span>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Add `TerminalLogStrip` to the JSX**

Find the render return in `ChatPanel`. Locate this block:
```tsx
      </div>

      <InputBar
```

Between the closing `</div>` (scroll area) and `<InputBar`, add:

```tsx
      {(() => {
        const terminalLines = Object.values(streamMap).flat();
        return (isStreaming || terminalLines.length > 0) ? (
          <TerminalLogStrip lines={terminalLines} isStreaming={isStreaming} />
        ) : null;
      })()}
```

- [ ] **Step 11: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0
npx tsc --noEmit 2>&1 | head -40
```

Expected: zero new errors. If TypeScript complains about `LiveIteration` being used before defined (it's declared inside the component), move the `interface LiveIteration` declaration to the module level (above the `ChatPanel` function) — it's a type, not runtime code.

- [ ] **Step 12: Run the app and verify manually**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run dev
```

Send a message that triggers tool calls. Verify:
1. LLM narration text stays visible — it does NOT vanish when tools appear
2. Text renders above its associated tool cards (not above ALL cards)
3. "Working..." blue dot is gone
4. Terminal strip appears at bottom during streaming (~72px, monochrome)
5. After streaming ends, strip collapses to "terminal log ⌄" row
6. Click the row expands the log (up to 120px)
7. Historical messages still display correctly

- [ ] **Step 13: Commit**

```bash
git add src/renderer/components/ChatPanel.tsx
git commit -m "feat: iteration-paired message model — fix text disappearing, order, remove Working..."
```

---

## Success Criteria Checklist

After all tasks complete:

- [ ] LLM narration text persists when tool cards appear — no jarring disappearance
- [ ] Text → tool cards → text → tool cards renders in sequence (paired per iteration)
- [ ] "Working..." blue dot + text is gone
- [ ] `StatusLine` shimmer text is unchanged
- [ ] Terminal strip visible during streaming (72px, auto-scrolls, monochrome white/grey only)
- [ ] Strip collapses to "terminal log ⌄" row after streaming ends
- [ ] Click chevron expands log (max 120px, 3px dark scrollbar)
- [ ] No green text anywhere in the terminal strip
- [ ] Global scrollbar unchanged (still 6px) — only strip area has 3px
- [ ] Historical messages (no `iterations` field) render correctly via fallback path
- [ ] Tool ratings still work (via flat `toolCalls` on completed messages)
- [ ] `npx tsc --noEmit` passes with no new errors

---

**Spec reference:** `docs/superpowers/specs/2026-03-19-terminal-log-strip-design.md`
