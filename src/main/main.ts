/**
 * Clawdia 4.0 — Main Process
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { runAgentLoop, cancelLoop, pauseLoop, resumeLoop, addContext } from './agent/loop';
import {
  initProcessManager, registerProcess, completeProcess, routeEvent,
  detachCurrent, attachTo, cancelProcess as cancelProc, dismissProcess,
  listProcesses, getAttachedId, recordToolCall,
} from './agent/process-manager';
import { approveRunApproval, denyRunApproval, listApprovalsForRun } from './agent/approval-manager';
import { resetGuiStateForNewConversation } from './agent/executors/desktop-executors';
import { destroyShell } from './agent/executors/core-executors';
import { extractMemoryInBackground } from './agent/memory-extractor';
import {
  getApiKey,
  setApiKey,
  getSelectedModel,
  setSelectedModel,
  getUnrestrictedMode,
  setUnrestrictedMode,
} from './store';
import { getDb, closeDb } from './db/database';
import {
  createConversation, listConversations, getConversation,
  deleteConversation, addMessage, getAnthropicHistory,
  getRendererMessages, getMessageCount,
} from './db/conversations';
import { getRunRecord, listRunRecords } from './db/runs';
import { getRunEventRecords } from './db/run-events';
import { listRunChanges } from './db/run-changes';
import {
  initBrowser, navigate, goBack, goForward, reload,
  setBounds, closeBrowser,
  createTab, switchTab, closeTab, getTabList,
  matchUrlHistory,
} from './browser/manager';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';
let activeConversationId: string | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (mainWindow) {
      initBrowser(mainWindow);
      initProcessManager(mainWindow);
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  getDb();
  setupIpcHandlers();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function setupIpcHandlers(): void {
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => mainWindow?.close());

  ipcMain.handle(IPC.CHAT_SEND, async (_event, message: string) => {
    const apiKey = getApiKey();
    if (!apiKey) return { error: 'No API key set. Go to Settings to add your Anthropic API key.' };

    if (!activeConversationId) {
      const conv = createConversation();
      activeConversationId = conv.id;
    }

    // Process registration — only creates trackable processes when
    // detach/background is wired. For now, still register so the
    // infrastructure works, but mark as attached (won't show in sidebar
    // as "completed" since it's the foreground task).
    const processId = registerProcess(activeConversationId, message);

    addMessage(activeConversationId, 'user', message);
    const history = getAnthropicHistory(activeConversationId);
    history.pop();

    try {
      const result = await runAgentLoop(message, history, {
        runId: processId,
        apiKey,
        model: getSelectedModel(),
        onStreamText: (chunk) => routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, chunk),
        onProgress: (text) => routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, text),
        onThinking: (thought) => routeEvent(processId, IPC_EVENTS.CHAT_THINKING, thought),
        onToolActivity: (activity) => {
          recordToolCall(processId);
          routeEvent(processId, IPC_EVENTS.CHAT_TOOL_ACTIVITY, activity);
        },
        onToolStream: (payload) => routeEvent(processId, IPC_EVENTS.CHAT_TOOL_STREAM, payload),
        onStreamEnd: () => routeEvent(processId, IPC_EVENTS.CHAT_STREAM_END, {}),
      });

      // Complete silently — attached foreground processes don't
      // show in "Recently Completed" (only detached ones will)
      completeProcess(processId, 'completed');

      if (result.response) {
        addMessage(activeConversationId!, 'assistant', result.response, result.toolCalls);
        extractMemoryInBackground(apiKey, message, result.response);
      }

      return {
        ok: true,
        runId: processId,
        response: result.response,
        toolCalls: result.toolCalls,
        conversationId: activeConversationId,
      };
    } catch (err: any) {
      completeProcess(processId, 'failed', err.message);
      console.error('[Main] Agent loop error:', err);
      return { error: err.message || 'Unknown error', runId: processId };
    }
  });

  ipcMain.handle(IPC.CHAT_STOP, async () => {
    cancelLoop();
    return { ok: true };
  });
  ipcMain.handle(IPC.CHAT_PAUSE, async () => {
    pauseLoop();
    return { ok: true };
  });
  ipcMain.handle(IPC.CHAT_RESUME, async () => {
    resumeLoop();
    return { ok: true };
  });
  ipcMain.handle(IPC.CHAT_ADD_CONTEXT, async (_e, text: string) => {
    addContext(text);
    return { ok: true };
  });
  ipcMain.handle(IPC.CHAT_NEW, async () => {
    const conv = createConversation();
    activeConversationId = conv.id;
    resetGuiStateForNewConversation();
    return { id: conv.id, title: conv.title };
  });
  ipcMain.handle(IPC.CHAT_LIST, async () => {
    return listConversations().map(c => ({
      id: c.id, title: c.title, updatedAt: c.updated_at, messageCount: getMessageCount(c.id),
    }));
  });
  ipcMain.handle(IPC.CHAT_LOAD, async (_e, id: string) => {
    const conv = getConversation(id);
    if (!conv) return { error: 'Conversation not found' };
    activeConversationId = id;
    resetGuiStateForNewConversation();
    return { id: conv.id, title: conv.title, messages: getRendererMessages(id) };
  });
  ipcMain.handle(IPC.CHAT_DELETE, async (_e, id: string) => {
    deleteConversation(id);
    if (activeConversationId === id) activeConversationId = null;
    return { ok: true };
  });

  ipcMain.handle(IPC.API_KEY_GET, async () => getApiKey());
  ipcMain.handle(IPC.API_KEY_SET, async (_e, key: string) => { setApiKey(key); return { ok: true }; });
  ipcMain.handle(IPC.MODEL_GET, async () => getSelectedModel());
  ipcMain.handle(IPC.MODEL_SET, async (_e, model: string) => { setSelectedModel(model); return { ok: true }; });
  ipcMain.handle(IPC.SETTINGS_GET, async (_e, key: string) => {
    if (key === 'apiKey') return getApiKey() ? 'set' : '';
    if (key === 'unrestrictedMode') return getUnrestrictedMode();
    return null;
  });
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, key: string, value: any) => {
    if (key === 'apiKey') setApiKey(value);
    if (key === 'model') setSelectedModel(value);
    if (key === 'unrestrictedMode') setUnrestrictedMode(!!value);
    return { ok: true };
  });

  ipcMain.handle(IPC.BROWSER_NAVIGATE, async (_e, url: string) => {
    try { return { ok: true, ...(await navigate(url)) }; } catch (err: any) { return { error: err.message }; }
  });
  ipcMain.handle(IPC.BROWSER_BACK, async () => { await goBack(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_FORWARD, async () => { await goForward(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_REFRESH, async () => { await reload(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, async (_e, bounds: any) => { setBounds(bounds); return { ok: true }; });

  ipcMain.handle(IPC.BROWSER_TAB_NEW, async (_e, url?: string) => {
    const id = createTab(url);
    return { ok: true, id, tabs: getTabList() };
  });
  ipcMain.handle(IPC.BROWSER_TAB_LIST, async () => getTabList());
  ipcMain.handle(IPC.BROWSER_TAB_SWITCH, async (_e, id: string) => { switchTab(id); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_TAB_CLOSE, async (_e, id: string) => { closeTab(id); return { ok: true, tabs: getTabList() }; });

  // ── Tool call rating ──
  ipcMain.handle(IPC.CHAT_RATE_TOOL, async (_e, messageId: string, toolId: string, rating: 'up' | 'down' | null, note?: string) => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT tool_calls FROM messages WHERE id = ?').get(messageId) as any;
      if (!row?.tool_calls) return { ok: false };
      const tools = JSON.parse(row.tool_calls) as any[];
      const updated = tools.map((t: any) => {
        if (t.id !== toolId) return t;
        const patched = { ...t, rating };
        if (note !== undefined) patched.ratingNote = note;
        if (rating === null) { delete patched.rating; delete patched.ratingNote; }
        if (rating === 'up') { delete patched.ratingNote; } // up doesn't need a note
        return patched;
      });
      db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?').run(JSON.stringify(updated), messageId);
      console.log(`[Rating] Tool ${toolId} in message ${messageId.slice(0, 8)}: ${rating}${note ? ` ("${note}")` : ''}`);
      return { ok: true };
    } catch (err: any) {
      console.warn(`[Rating] Failed: ${err.message}`);
      return { ok: false };
    }
  });

  // ── Process management ──
  ipcMain.handle(IPC.PROCESS_LIST, async () => listProcesses());
  ipcMain.handle(IPC.PROCESS_DETACH, async () => {
    const id = detachCurrent();
    return { ok: !!id, detachedId: id };
  });
  ipcMain.handle(IPC.PROCESS_ATTACH, async (_e, processId: string) => {
    const result = attachTo(processId);
    if (!result) return { error: 'Process not found' };
    // Switch active conversation to the process's conversation
    activeConversationId = result.process.conversationId;
    return { ok: true, ...result };
  });
  ipcMain.handle(IPC.PROCESS_CANCEL, async (_e, processId: string) => {
    cancelLoop(); // Cancel the running loop (module-level)
    cancelProc(processId);
    return { ok: true };
  });
  ipcMain.handle(IPC.PROCESS_DISMISS, async (_e, processId: string) => {
    return { ok: dismissProcess(processId) };
  });

  // ── Runs (Phase 3 read-only review surface) ──
  ipcMain.handle(IPC.RUN_LIST, async () => listRunRecords());
  ipcMain.handle(IPC.RUN_GET, async (_e, runId: string) => {
    return getRunRecord(runId);
  });
  ipcMain.handle(IPC.RUN_EVENTS, async (_e, runId: string) => {
    return getRunEventRecords(runId);
  });
  ipcMain.handle(IPC.RUN_CHANGES, async (_e, runId: string) => {
    return listRunChanges(runId);
  });
  ipcMain.handle(IPC.RUN_APPROVALS, async (_e, runId: string) => {
    return listApprovalsForRun(runId);
  });
  ipcMain.handle(IPC.RUN_APPROVE, async (_e, approvalId: number) => {
    const approval = approveRunApproval(approvalId);
    return { ok: !!approval, approval };
  });
  ipcMain.handle(IPC.RUN_DENY, async (_e, approvalId: number) => {
    const approval = denyRunApproval(approvalId);
    return { ok: !!approval, approval };
  });

  // ── Browser URL autocomplete ──
  ipcMain.handle(IPC.BROWSER_HISTORY_MATCH, async (_e, prefix: string) => matchUrlHistory(prefix));
}

app.whenReady().then(createWindow);
app.on('before-quit', () => { closeBrowser(); destroyShell(); });
app.on('window-all-closed', () => { destroyShell(); closeDb(); app.quit(); });
