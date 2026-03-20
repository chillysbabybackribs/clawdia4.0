/**
 * Clawdia 4.0 — Main Process
 */

import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { runAgentLoop, cancelLoop, pauseLoop, resumeLoop, addContext } from './agent/loop';
import { parseManualAgentProfileOverride } from './agent/agent-profile-override';
import {
  initProcessManager, registerProcess, completeProcess, routeEvent,
  detachCurrent, attachTo, cancelProcess as cancelProc, dismissProcess,
  listProcesses, getAttachedId, recordToolCall,
} from './agent/process-manager';
import { approveRunApproval, denyRunApproval, listApprovalsForRun, reviseRunApproval } from './agent/approval-manager';
import { listHumanInterventionsForRun, resolveHumanIntervention } from './agent/human-intervention-manager';
import { listPolicyProfiles, seedPolicyProfiles } from './db/policies';
import { scheduleAutoGraduation } from './db/executor-auto-graduation';
import { resetGuiStateForNewConversation } from './agent/executors/desktop-executors';
import { destroyShell } from './agent/executors/core-executors';
import { extractMemoryInBackground } from './agent/memory-extractor';
import {
  getApiKey,
  getProviderKeys,
  getSelectedProvider,
  hasAnyApiKey,
  setApiKey,
  getSelectedModel,
  setSelectedProvider,
  setSelectedModel,
  getSelectedPerformanceStance,
  getSelectedPolicyProfile,
  setSelectedPolicyProfile,
  setSelectedPerformanceStance,
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
import { listRunArtifacts } from './db/run-artifacts';
import { listRunChanges } from './db/run-changes';
import {
  initBrowser, navigate, goBack, goForward, reload,
  setBounds, hideBrowser, showBrowser, closeBrowser, getBrowserExecutionMode,
  createTab, switchTab, closeTab, getTabList,
  matchUrlHistory,
} from './browser/manager';
import { startCalendarWatcher, stopCalendarWatcher } from './calendar-watcher';
import { calendarList } from './db/calendar';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';
let activeConversationId: string | null = null;

function isDevToolsShortcut(input: Electron.Input): boolean {
  return input.type === 'keyDown' &&
    (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toUpperCase() === 'I'));
}

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

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isDevToolsShortcut(input)) return;
    event.preventDefault();
    if (mainWindow?.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools();
    else mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  // Context menu for the chat/renderer (copy, paste, select all)
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Cut', role: 'cut', enabled: params.isEditable && params.selectionText.length > 0 },
      { label: 'Copy', role: 'copy', enabled: params.selectionText.length > 0 },
      { label: 'Paste', role: 'paste', enabled: params.isEditable },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    ]);
    menu.popup({ window: mainWindow! });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (mainWindow) {
      initBrowser(mainWindow);
      initProcessManager(mainWindow);
      startCalendarWatcher(mainWindow);
    }
  });

  getDb();
  seedPolicyProfiles();
  scheduleAutoGraduation();
  setupIpcHandlers();

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('will-quit', () => {
  stopCalendarWatcher();
});

function setupIpcHandlers(): void {
  const getAttachedRunId = (): string | null => getAttachedId();

  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => mainWindow?.close());

  ipcMain.handle(IPC.CHAT_SEND, async (_event, message: string) => {
    const provider = getSelectedProvider();
    const apiKey = getApiKey(provider);
    if (!apiKey) return { error: `No API key set for ${provider}. Go to Settings to add your API key.` };

    const { cleanedMessage, forcedAgentProfile } = parseManualAgentProfileOverride(message);
    if (!cleanedMessage.trim()) {
      return { error: 'Agent override commands require a prompt, for example: /filesystem-agent find the exact file containing "..." or /bloodhound learn the fastest route to GitHub notifications' };
    }

    if (!activeConversationId) {
      const conv = createConversation();
      activeConversationId = conv.id;
    }
    const conversationId = activeConversationId;

    // Process registration — only creates trackable processes when
    // detach/background is wired. For now, still register so the
    // infrastructure works, but mark as attached (won't show in sidebar
    // as "completed" since it's the foreground task).
    const processId = registerProcess(conversationId, cleanedMessage, provider, getSelectedModel(provider));

    addMessage(conversationId, 'user', cleanedMessage);
    const history = getAnthropicHistory(conversationId);
    history.pop();

    try {
      const result = await runAgentLoop(cleanedMessage, history, {
        runId: processId,
        provider,
        forcedAgentProfile,
        apiKey,
        model: getSelectedModel(provider),
        onStreamText: (chunk) => routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, chunk),
        onProgress: (text) => routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, text),
        onThinking: (thought) => routeEvent(processId, IPC_EVENTS.CHAT_THINKING, thought),
        onToolActivity: (activity) => {
          recordToolCall(processId);
          routeEvent(processId, IPC_EVENTS.CHAT_TOOL_ACTIVITY, activity);
        },
        onToolStream: (payload) => routeEvent(processId, IPC_EVENTS.CHAT_TOOL_STREAM, payload),
        onWorkflowPlanReset: () => routeEvent(processId, IPC_EVENTS.CHAT_WORKFLOW_PLAN_RESET, {}),
        onWorkflowPlanText: (chunk) => routeEvent(processId, IPC_EVENTS.CHAT_WORKFLOW_PLAN_TEXT, chunk),
        onWorkflowPlanEnd: () => routeEvent(processId, IPC_EVENTS.CHAT_WORKFLOW_PLAN_END, {}),
        onStreamEnd: () => routeEvent(processId, IPC_EVENTS.CHAT_STREAM_END, {}),
      });

      const finalStatus = result.response?.startsWith('[Cancelled by user]') ? 'cancelled' : 'completed';
      completeProcess(processId, finalStatus);

      if (result.response) {
        addMessage(conversationId, 'assistant', result.response, result.toolCalls);
        extractMemoryInBackground(provider, apiKey, message, result.response);
      }

      return {
        ok: true,
        runId: processId,
        response: result.response,
        toolCalls: result.toolCalls,
        conversationId,
      };
    } catch (err: any) {
      completeProcess(processId, 'failed', err.message);
      console.error('[Main] Agent loop error:', err);
      return { error: err.message || 'Unknown error', runId: processId };
    }
  });

  ipcMain.handle(IPC.CHAT_STOP, async () => {
    const runId = getAttachedRunId();
    return { ok: runId ? cancelLoop(runId) : false };
  });
  ipcMain.handle(IPC.CHAT_PAUSE, async () => {
    const runId = getAttachedRunId();
    return { ok: runId ? pauseLoop(runId) : false };
  });
  ipcMain.handle(IPC.CHAT_RESUME, async () => {
    const runId = getAttachedRunId();
    return { ok: runId ? resumeLoop(runId) : false };
  });
  ipcMain.handle(IPC.CHAT_ADD_CONTEXT, async (_e, text: string) => {
    const runId = getAttachedRunId();
    return { ok: runId ? addContext(runId, text) : false };
  });
  ipcMain.handle(IPC.CHAT_NEW, async () => {
    if (getAttachedRunId()) detachCurrent();
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
    if (getAttachedRunId()) detachCurrent();
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

  ipcMain.handle(IPC.API_KEY_GET, async (_e, provider?: string) => getApiKey(provider as any));
  ipcMain.handle(IPC.API_KEY_SET, async (_e, provider: string, key: string) => { setApiKey(provider as any, key); return { ok: true }; });
  ipcMain.handle(IPC.MODEL_GET, async (_e, provider?: string) => getSelectedModel(provider as any));
  ipcMain.handle(IPC.MODEL_SET, async (_e, provider: string, model: string) => { setSelectedModel(provider as any, model); return { ok: true }; });
  ipcMain.handle(IPC.SETTINGS_GET, async (_e, key: string) => {
    if (key === 'apiKey') return hasAnyApiKey() ? 'set' : '';
    if (key === 'providerKeys') return getProviderKeys();
    if (key === 'selectedProvider') return getSelectedProvider();
    if (key === 'unrestrictedMode') return getUnrestrictedMode();
    if (key === 'policyProfile') return getSelectedPolicyProfile();
    if (key === 'performanceStance') return getSelectedPerformanceStance();
    return null;
  });
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, key: string, value: any) => {
    if (key === 'selectedProvider') setSelectedProvider(value);
    if (key === 'unrestrictedMode') setUnrestrictedMode(!!value);
    if (key === 'policyProfile') setSelectedPolicyProfile(String(value || 'standard'));
    if (key === 'performanceStance') setSelectedPerformanceStance(value);
    return { ok: true };
  });

  ipcMain.handle(IPC.BROWSER_NAVIGATE, async (_e, url: string) => {
    try { return { ok: true, ...(await navigate(url)) }; } catch (err: any) { return { error: err.message }; }
  });
  ipcMain.handle(IPC.BROWSER_BACK, async () => { await goBack(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_FORWARD, async () => { await goForward(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_REFRESH, async () => { await reload(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, async (_e, bounds: any) => { setBounds(bounds); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_GET_EXECUTION_MODE, async () => getBrowserExecutionMode());
  ipcMain.handle(IPC.BROWSER_HIDE, async () => { hideBrowser(); return { ok: true }; });
  ipcMain.handle(IPC.BROWSER_SHOW, async () => { showBrowser(); return { ok: true }; });

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
    cancelLoop(processId);
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
  ipcMain.handle(IPC.RUN_ARTIFACTS, async (_e, runId: string) => {
    return listRunArtifacts(runId);
  });
  ipcMain.handle(IPC.RUN_CHANGES, async (_e, runId: string) => {
    return listRunChanges(runId);
  });
  ipcMain.handle(IPC.RUN_APPROVALS, async (_e, runId: string) => {
    return listApprovalsForRun(runId);
  });
  ipcMain.handle(IPC.RUN_HUMAN_INTERVENTIONS, async (_e, runId: string) => {
    return listHumanInterventionsForRun(runId);
  });
  ipcMain.handle(IPC.RUN_APPROVE, async (_e, approvalId: number) => {
    const approval = approveRunApproval(approvalId);
    return { ok: !!approval, approval };
  });
  ipcMain.handle(IPC.RUN_REVISE, async (_e, approvalId: number) => {
    const approval = reviseRunApproval(approvalId);
    return { ok: !!approval, approval };
  });
  ipcMain.handle(IPC.RUN_DENY, async (_e, approvalId: number) => {
    const approval = denyRunApproval(approvalId);
    return { ok: !!approval, approval };
  });
  ipcMain.handle(IPC.RUN_RESOLVE_HUMAN_INTERVENTION, async (_e, interventionId: number) => {
    const intervention = resolveHumanIntervention(interventionId);
    return { ok: !!intervention, intervention };
  });
  ipcMain.handle(IPC.POLICY_LIST, async () => listPolicyProfiles());
  ipcMain.handle(IPC.CALENDAR_LIST, (_event, from?: string, to?: string) => {
    return calendarList(from && to ? { from, to } : {});
  });

  // ── Browser URL autocomplete ──
  ipcMain.handle(IPC.BROWSER_HISTORY_MATCH, async (_e, prefix: string) => matchUrlHistory(prefix));
}

app.whenReady().then(createWindow);
app.on('before-quit', () => { closeBrowser(); destroyShell(); });
app.on('window-all-closed', () => { destroyShell(); closeDb(); app.quit(); });
