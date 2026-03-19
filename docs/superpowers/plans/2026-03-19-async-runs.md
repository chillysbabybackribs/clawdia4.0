# Async Runs + Background Autonomy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the agent loop from the IPC chat session so runs survive window close/minimize, unify `processId`/`runId` into a single `runId`, add a `pending` queue status, and wire a full approval checkpoint system from tool executor through loop to UI.

**Architecture:** A `RunQueue` singleton in the main process holds the sequential run queue. `chat:send` creates a `pending` run and enqueues it. The queue runner starts runs independently of any IPC connection. Approval checkpoints suspend the loop via the existing `waitIfPaused` mechanism and emit IPC events + Electron desktop notifications. The `processId`/`runId` split is eliminated — `process-manager.ts` is refactored to key on `runId` directly.

**Tech Stack:** TypeScript, Electron IPC, better-sqlite3, Electron `Notification` API, existing `loop.ts`/`process-manager.ts`/`runs.ts` infrastructure.

**Spec:** `docs/superpowers/specs/2026-03-19-platform-expansion-design.md` — Subsystem A

**Key existing signatures (verified before writing plan):**
- `createRunApproval(runId, { actionType, target, summary, request? })` — no `db` arg, no `id` field, field is `request` not `requestJson`, returns `RunApprovalRecord` with numeric `.id`
- `resolveRunApproval(id: number, status)` — no `db` arg, `id` is integer rowid
- `completeRun(id, status, error?)` — no `db` arg, second arg is status string not response
- `completeProcess(processId, status, error?)` — second arg is `'completed'|'failed'|'cancelled'`
- `DEFAULT_RUN_KEY` lives in `loop.ts` line 58, NOT in `process-manager.ts`
- All `runs.ts` and `run-approvals.ts` functions call `getDb()` internally — no `db` parameter

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `src/main/db/database.ts` | Migration v13: add `pending` to runs status CHECK |
| Modify | `src/main/db/runs.ts` | Add `createPendingRun()`, `setPendingRun()`, `setRunStatus()` — follow module convention (no `db` param, use `getDb()`) |
| Modify | `src/main/agent/process-manager.ts` | Replace `processId` key with `runId` passed by caller |
| Create | `src/main/agent/run-queue.ts` | Sequential run queue singleton |
| Create | `src/main/agent/approval-gate.ts` | `needsApproval()` async function — tool executor interface |
| Modify | `src/main/main.ts` | Wire queue into `chat:send`; update renderer IPC call shape |
| Modify | `src/renderer/InputBar.tsx` | Update `chat:send` IPC call to send `{ conversationId, message, apiKey, model }` |
| Modify | `src/shared/ipc-channels.ts` | Add `RUN_APPROVAL_RESOLVE`, `RUN_AWAITING_APPROVAL` channels |
| Modify | `src/main/preload.ts` | Expose new IPC channels including `listRuns` |
| Modify | `src/renderer/components/Sidebar.tsx` | Run status indicators (spinner, checkmark, approval badge) |
| Create | `src/renderer/components/ApprovalModal.tsx` | Approval checkpoint UI |
| Modify | `src/renderer/App.tsx` | Wire approval modal |

---

### Task 1: DB migration v13 — add `pending` status

**Files:**
- Modify: `src/main/db/database.ts`

- [ ] **Step 1: Read the current v12 migration block**

Open `src/main/db/database.ts` and find the `if (currentVersion < 12)` block (around line 277). Note the exact CHECK constraint string and the `INSERT INTO schema_version` pattern.

- [ ] **Step 2: Add migration v13 immediately after the v12 block**

Add this block after the closing `}` of the v12 migration:

```typescript
if (currentVersion < 13) {
  console.log('[DB] Running migration v13: add pending run status + run queue');
  db.exec(`
    ALTER TABLE runs RENAME TO runs_v12;

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_approval','completed','failed','cancelled')),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      was_detached INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO runs SELECT * FROM runs_v12;
    DROP TABLE runs_v12;

    CREATE INDEX IF NOT EXISTS idx_runs_conversation ON runs(conversation_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at DESC);

    INSERT INTO schema_version (version) VALUES (13);
  `);
}
```

- [ ] **Step 3: Update the `pragma user_version` line**

Find `db.pragma('user_version = 12')` and change to `db.pragma('user_version = 13')`.

- [ ] **Step 4: Build and verify**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors.

- [ ] **Step 5: Smoke test — delete the DB and let it recreate**

```bash
rm -f ~/.config/clawdia/data.sqlite
npm run dev 2>&1 | grep -E '\[DB\]|error' | head -20
```

Expected: `[DB] Running migration v13` appears, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/db/database.ts
git commit -m "feat(db): migration v13 — add pending status to runs"
```

---

### Task 2: Add `createPendingRun`, `setPendingRun`, `setRunStatus` to runs.ts

**Files:**
- Modify: `src/main/db/runs.ts`

**Important:** Every existing function in this module calls `getDb()` internally and takes NO `db` parameter. Follow this pattern exactly.

- [ ] **Step 1: Read `src/main/db/runs.ts` fully**

Confirm the `RunStatus` type and locate `getDb()` import. Note the `getDb()` call pattern used throughout.

- [ ] **Step 2: Update `RunStatus` type**

Find:
```typescript
export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
```
Change to:
```typescript
export type RunStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
```

- [ ] **Step 3: Add `createPendingRun()` — follows module convention, no `db` parameter**

After the existing `createRun()` function, add:

```typescript
export function createPendingRun(
  id: string,
  conversationId: string,
  title: string,
  goal: string
): RunRecord {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO runs (id, conversation_id, title, goal, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, conversationId, title, goal, now, now);
  return toRunRecord(db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow);
}
```

- [ ] **Step 4: Add `setPendingRun()` — transitions pending→running**

```typescript
export function setPendingRun(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(now, id);
}
```

- [ ] **Step 5: Add `setRunStatus()` if not already present**

Check if a generic `setRunStatus` function exists. If not, add:

```typescript
export function setRunStatus(id: string, status: RunStatus, error?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
    .run(status, error ?? null, now, id);
}
```

- [ ] **Step 6: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 7: Commit**

```bash
git add src/main/db/runs.ts
git commit -m "feat(db): add createPendingRun, setPendingRun, setRunStatus to runs.ts"
```

---

### Task 3: Refactor process-manager.ts to key on runId

**Files:**
- Modify: `src/main/agent/process-manager.ts`

**Note:** `DEFAULT_RUN_KEY` is in `loop.ts`, NOT here. Do not touch `loop.ts` in this task.

- [ ] **Step 1: Read `src/main/agent/process-manager.ts` fully**

Note the current `registerProcess` signature, the `processes` Map, and every exported function that takes a process key.

- [ ] **Step 2: Change `registerProcess` signature to accept `runId` from caller**

Find:
```typescript
export function registerProcess(conversationId: string, goal: string): string {
```

Change to:
```typescript
export function registerProcess(runId: string, conversationId: string, goal: string): void {
```

Update the function body: use the passed `runId` as the map key instead of generating an internal ID. Return `void`.

- [ ] **Step 3: Update all internal references**

Replace every instance of the internal `processId` variable with `runId` inside the function body. The `ProcessInfo` type's `id` field becomes the `runId`.

- [ ] **Step 4: Build — expect errors at call sites in main.ts**

```bash
npm run build 2>&1 | grep -i error | head -30
```

Expected: TypeScript errors at `main.ts` call sites only — those will be fixed in Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/process-manager.ts
git commit -m "refactor(process-manager): accept runId from caller instead of generating processId"
```

---

### Task 4: Create run-queue.ts — sequential run queue singleton

**Files:**
- Create: `src/main/agent/run-queue.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/main/agent/run-queue.ts
// Sequential run queue — one run executes at a time; others wait as 'pending'

import { setPendingRun, completeRun, setRunStatus } from '../db/runs';
import { appendRunEvent } from '../db/run-events';
import { Notification } from 'electron';

type RunHandler = (runId: string) => Promise<string>;

interface QueuedRun {
  runId: string;
  handler: RunHandler;
}

let queue: QueuedRun[] = [];
let running = false;

export function enqueueRun(runId: string, handler: RunHandler): void {
  queue.push({ runId, handler });
  processQueue();
}

async function processQueue(): Promise<void> {
  if (running || queue.length === 0) return;
  running = true;

  const { runId, handler } = queue.shift()!;

  try {
    setPendingRun(runId);
    appendRunEvent(runId, { kind: 'run_started', payload: {} });

    const response = await handler(runId);

    completeRun(runId, 'completed');
    appendRunEvent(runId, { kind: 'run_completed', payload: { preview: response.slice(0, 200) } });
    notifyComplete(response);
  } catch (err: any) {
    const msg = err?.message ?? 'Unknown error';
    setRunStatus(runId, 'failed', msg);
    appendRunEvent(runId, { kind: 'run_failed', payload: { error: msg } });
    notifyFailed(msg);
  } finally {
    running = false;
    processQueue(); // process next if any
  }
}

function notifyComplete(response: string): void {
  const preview = response.slice(0, 80) + (response.length > 80 ? '…' : '');
  new Notification({ title: 'Clawdia — Task complete', body: preview }).show();
}

function notifyFailed(error: string): void {
  new Notification({ title: 'Clawdia — Task failed', body: error.slice(0, 80) }).show();
}

export function getQueueLength(): number {
  return queue.length;
}
```

- [ ] **Step 2: Check `appendRunEvent` signature in `src/main/db/run-events.ts`**

Read `src/main/db/run-events.ts` and verify the `AppendRunEventInput` type fields. If the field names differ from `{ runId, kind, toolName, payloadJson }`, adjust the calls in Step 1 to match the actual type.

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/run-queue.ts
git commit -m "feat: run-queue singleton — sequential pending→running→complete lifecycle with event logging"
```

---

### Task 5: Create approval-gate.ts — needsApproval() contract

**Files:**
- Create: `src/main/agent/approval-gate.ts`

**Key signatures (already verified):**
- `createRunApproval(runId, { actionType, target, summary, request? })` returns `RunApprovalRecord` with numeric `.id`
- `resolveRunApproval(id: number, status)` — `id` is integer, not UUID
- `pauseLoop(runId?)` and `resumeLoop(runId?)` live in `loop.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/main/agent/approval-gate.ts
// Approval checkpoint — tool executors call needsApproval() before sensitive actions.
// Suspends the loop until user approves or rejects via UI or PWA.

import { createRunApproval, resolveRunApproval } from '../db/run-approvals';
import { setRunStatus } from '../db/runs';
import { pauseLoop, resumeLoop } from './loop';
import { BrowserWindow, Notification } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';

export type RiskLevel = 'low' | 'medium' | 'high';

export class ApprovalRejected extends Error {
  constructor(action: string) {
    super(`Action rejected by user: ${action}`);
    this.name = 'ApprovalRejected';
  }
}

// Pending approval resolvers keyed by numeric DB rowid (as string for map key)
const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();

/**
 * Called by tool executors before performing sensitive actions.
 * Suspends the loop until the user approves or rejects.
 * Throws ApprovalRejected if denied.
 */
export async function needsApproval(
  runId: string,
  actionDesc: string,
  riskLevel: RiskLevel
): Promise<void> {
  // Write to DB — returns record with auto-increment numeric id
  const approval = createRunApproval(runId, {
    actionType: 'user_approval',
    target: actionDesc,
    summary: actionDesc,
    request: { riskLevel },
  });

  const approvalKey = String(approval.id);

  // Suspend loop
  pauseLoop(runId);
  setRunStatus(runId, 'awaiting_approval');

  // Notify renderer
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send(IPC_EVENTS.RUN_AWAITING_APPROVAL, {
    runId,
    approvalKey,
    actionDesc,
    riskLevel,
  });

  // Desktop notification
  new Notification({
    title: 'Clawdia — Approval required',
    body: actionDesc.slice(0, 80),
  }).show();

  // Wait for resolution from IPC handler
  const approved = await new Promise<boolean>((resolve) => {
    pendingApprovals.set(approvalKey, { resolve });
  });

  // Resume loop
  resumeLoop(runId);
  setRunStatus(runId, 'running');

  if (!approved) {
    resolveRunApproval(approval.id, 'denied');
    throw new ApprovalRejected(actionDesc);
  }

  resolveRunApproval(approval.id, 'approved');
}

/**
 * Called from IPC handler when user approves or rejects.
 * approvalKey is the stringified numeric DB rowid.
 */
export function resolveApproval(approvalKey: string, approved: boolean): void {
  const pending = pendingApprovals.get(approvalKey);
  if (!pending) {
    console.warn('[ApprovalGate] No pending approval for key:', approvalKey);
    return;
  }
  pendingApprovals.delete(approvalKey);
  pending.resolve(approved);
}
```

- [ ] **Step 2: Add `RUN_AWAITING_APPROVAL` and `RUN_APPROVAL_RESOLVE` to ipc-channels.ts**

Open `src/shared/ipc-channels.ts`. In the `IPC` object (handlers), add:
```typescript
RUN_APPROVAL_RESOLVE: 'run:approval-resolve',
```

In the `IPC_EVENTS` object (events), add:
```typescript
RUN_AWAITING_APPROVAL: 'run:awaiting-approval',
```

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/main/agent/approval-gate.ts src/shared/ipc-channels.ts
git commit -m "feat: approval-gate — needsApproval() suspends loop, emits IPC + desktop notification"
```

---

### Task 6: Wire main.ts — use run-queue, fix call sites

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Read `src/main/main.ts` and `src/renderer/components/InputBar.tsx` fully**

Note exactly how `chat:send` is currently called from the renderer (what shape is sent) and how the main process handler receives it. Note the current `completeProcess` call site and `registerProcess` call.

- [ ] **Step 2: Update the `CHAT_SEND` handler in main.ts**

Replace the current handler body. The handler now receives `{ conversationId, message, apiKey, model }`:

```typescript
ipcMain.handle(IPC.CHAT_SEND, async (_event, { conversationId, message, apiKey, model }) => {
  const runId = randomUUID();

  // Create pending run (no db arg — uses getDb() internally)
  createPendingRun(runId, conversationId, message.slice(0, 80), message);

  // Register with process manager (now takes runId as first arg)
  registerProcess(runId, conversationId, message);

  // Enqueue — runs sequentially in background, returns immediately
  enqueueRun(runId, async (runId) => {
    const result = await runAgentLoop({
      runId,
      conversationId,
      userMessage: message,
      apiKey,
      model,
      onProgress: (event: any) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send(IPC_EVENTS.CHAT_STREAM, event);
      },
    });
    completeProcess(runId, 'completed');
    return result.response;
  });

  return { runId };
});
```

- [ ] **Step 3: Add `RUN_APPROVAL_RESOLVE` handler**

```typescript
ipcMain.handle(IPC.RUN_APPROVAL_RESOLVE, (_event, { approvalKey, approved }) => {
  resolveApproval(approvalKey, approved);
});
```

- [ ] **Step 4: Add new imports at top of main.ts**

```typescript
import { enqueueRun } from './agent/run-queue';
import { createPendingRun } from './db/runs';
import { resolveApproval } from './agent/approval-gate';
import { randomUUID } from 'crypto';
```

- [ ] **Step 5: Build — note all remaining type errors**

```bash
npm run build 2>&1 | grep -i error | head -30
```

Fix remaining errors. The most likely are:
- `runAgentLoop` parameter shape — match whatever the current call site passes
- Any remaining `processId` references

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(main): wire run-queue into chat:send — background execution, approval handler"
```

---

### Task 7: Update InputBar.tsx — send correct IPC shape

**Files:**
- Modify: `src/renderer/components/InputBar.tsx`

- [ ] **Step 1: Read `src/renderer/components/InputBar.tsx`**

Find where `window.electron.sendChat(...)` or `ipcRenderer.invoke('chat:send', ...)` is called. Note the current argument shape.

- [ ] **Step 2: Update the send call**

The main process now expects `{ conversationId, message, apiKey, model }`. Update the call to send this shape:

```typescript
const result = await window.electron.sendChat({
  conversationId: currentConversationId,
  message: inputText,
  apiKey: storedApiKey,
  model: storedModel,
});
```

If the current call already sends an object, verify field names match exactly. If it sends a plain string, restructure to the object shape above.

- [ ] **Step 3: Update `global.d.ts` if needed**

Open `src/renderer/global.d.ts` and verify `sendChat` is typed to accept the new object shape. Update if needed:

```typescript
sendChat: (args: { conversationId: string; message: string; apiKey: string; model: string }) => Promise<{ runId: string }>;
```

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/InputBar.tsx src/renderer/global.d.ts
git commit -m "feat(renderer): update chat:send IPC call to send {conversationId, message, apiKey, model}"
```

---

### Task 8: Update preload.ts — expose all new IPC channels

**Files:**
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Read `src/main/preload.ts` fully**

Note the existing `contextBridge.exposeInMainWorld` structure and the type of `window.electron`.

- [ ] **Step 2: Add new channels to the exposed API**

```typescript
// Approval resolution
resolveApproval: (approvalKey: string, approved: boolean) =>
  ipcRenderer.invoke(IPC.RUN_APPROVAL_RESOLVE, { approvalKey, approved }),

// Listen for approval requests
onRunAwaitingApproval: (cb: (data: {
  runId: string;
  approvalKey: string;
  actionDesc: string;
  riskLevel: 'low' | 'medium' | 'high';
}) => void) => {
  ipcRenderer.on(IPC_EVENTS.RUN_AWAITING_APPROVAL, (_e, data) => cb(data));
  return () => ipcRenderer.removeAllListeners(IPC_EVENTS.RUN_AWAITING_APPROVAL);
},

// List runs (already has IPC.RUN_LIST handler in main.ts)
listRuns: () => ipcRenderer.invoke(IPC.RUN_LIST),
```

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat(preload): expose resolveApproval, onRunAwaitingApproval, listRuns"
```

---

### Task 9: Create ApprovalModal.tsx

**Files:**
- Create: `src/renderer/components/ApprovalModal.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/renderer/components/ApprovalModal.tsx
import React from 'react';

interface Props {
  approvalKey: string;
  runId: string;
  actionDesc: string;
  riskLevel: 'low' | 'medium' | 'high';
  onResolve: (approvalKey: string, approved: boolean) => void;
}

const riskColors = {
  low: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10',
  medium: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  high: 'text-red-400 border-red-400/30 bg-red-400/10',
};

const riskLabels = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk — review carefully',
};

export function ApprovalModal({ approvalKey, actionDesc, riskLevel, onResolve }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 rounded-xl border border-white/10 bg-[#1a1a20] shadow-2xl">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">⚠️</span>
            <h2 className="text-white font-semibold text-lg">Approval Required</h2>
          </div>

          <p className="text-white/70 text-sm mb-4">
            Clawdia wants to perform this action:
          </p>

          <div className="rounded-lg border border-white/10 bg-white/5 p-4 mb-4">
            <p className="text-white text-sm font-mono">{actionDesc}</p>
          </div>

          <div className={`rounded-lg border px-3 py-2 text-xs font-medium mb-6 ${riskColors[riskLevel]}`}>
            {riskLabels[riskLevel]}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => onResolve(approvalKey, false)}
              className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 text-white/70 text-sm hover:bg-white/5 transition-colors"
            >
              Reject
            </button>
            <button
              onClick={() => onResolve(approvalKey, true)}
              className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ApprovalModal.tsx
git commit -m "feat(ui): ApprovalModal — approve/reject pending tool actions"
```

---

### Task 10: Wire ApprovalModal into App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Read `src/renderer/App.tsx`**

Note the existing state structure and JSX return.

- [ ] **Step 2: Add approval state and listener**

```tsx
const [pendingApproval, setPendingApproval] = React.useState<{
  approvalKey: string;
  runId: string;
  actionDesc: string;
  riskLevel: 'low' | 'medium' | 'high';
} | null>(null);

React.useEffect(() => {
  const unsub = window.electron.onRunAwaitingApproval((data) => {
    setPendingApproval(data);
  });
  return unsub;
}, []);

const handleApprovalResolve = (approvalKey: string, approved: boolean) => {
  window.electron.resolveApproval(approvalKey, approved);
  setPendingApproval(null);
};
```

- [ ] **Step 3: Render the modal**

In the JSX return, add before the closing root tag:

```tsx
{pendingApproval && (
  <ApprovalModal
    {...pendingApproval}
    onResolve={handleApprovalResolve}
  />
)}
```

- [ ] **Step 4: Import ApprovalModal**

```tsx
import { ApprovalModal } from './components/ApprovalModal';
```

- [ ] **Step 5: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(ui): wire ApprovalModal into App — listens for run:awaiting-approval events"
```

---

### Task 11: Add run status indicators to Sidebar

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

- [ ] **Step 1: Read `src/renderer/components/Sidebar.tsx`**

Note where conversations/processes are listed and the existing component structure.

- [ ] **Step 2: Add active runs polling state**

`window.electron.listRuns()` is now exposed from preload (Task 8). Poll every 2 seconds:

```tsx
const [activeRuns, setActiveRuns] = React.useState<any[]>([]);

React.useEffect(() => {
  const poll = async () => {
    const runs = await window.electron.listRuns();
    const active = (runs ?? []).filter((r: any) =>
      ['pending', 'running', 'awaiting_approval'].includes(r.status)
    );
    setActiveRuns(active);
  };
  poll();
  const interval = setInterval(poll, 2000);
  return () => clearInterval(interval);
}, []);
```

- [ ] **Step 3: Render active runs section**

```tsx
{activeRuns.length > 0 && (
  <div className="px-3 py-2 border-b border-white/5">
    <p className="text-white/30 text-xs uppercase tracking-wider mb-2">Active Runs</p>
    {activeRuns.map((run) => (
      <div key={run.id} className="flex items-center gap-2 py-1">
        {run.status === 'running' && (
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
        )}
        {run.status === 'pending' && (
          <span className="w-2 h-2 rounded-full bg-white/30 flex-shrink-0" />
        )}
        {run.status === 'awaiting_approval' && (
          <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse flex-shrink-0" />
        )}
        <span className="text-white/60 text-xs truncate">{run.title}</span>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | grep -i error | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(ui): run status indicators in sidebar — pending/running/awaiting_approval"
```

---

### Task 12: End-to-end smoke test

- [ ] **Step 1: Start the app in dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Send a normal task**

Type a simple message. Verify:
- Response streams back as before
- No TypeScript errors in terminal
- Electron DevTools console shows no JS errors

- [ ] **Step 3: Verify run is created and completed in DB**

```bash
sqlite3 ~/.config/clawdia/data.sqlite "SELECT id, status, title FROM runs ORDER BY started_at DESC LIMIT 5;"
```

Expected: a row with `status = 'completed'`.

- [ ] **Step 4: Verify sidebar shows active run briefly during execution**

On a longer task, the sidebar should show the run as `running` (blue pulse) and then clear when done.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: async runs complete — background loop, approval gate, run queue, UI wired"
```

---

## Approval Policy Wiring (Post-plan follow-on)

After this plan is confirmed working, wire `needsApproval()` into specific tool executors:

- `shell_exec` — when command matches: `git push`, `rm -rf`, `apt install`, `pip install`, `flatpak install`, `npm install -g`
- `file_write` / `file_edit` — when path is outside `$HOME` or matches `/etc/**`, `/usr/**`, `/bin/**`
- `browser_*` — when performing purchases or form submissions on financial/account pages

This is a separate task after the infrastructure is confirmed working.
