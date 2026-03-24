/**
 * Clawdia 4.0 — Main Process
 */

import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { runAgentLoop, cancelLoop, pauseLoop, resumeLoop, addContext } from './agent/loop';
import { parseManualAgentProfileOverride } from './agent/agent-profile-override';
import {
  initProcessManager,
  detachCurrent, attachTo, cancelProcess as cancelProc, dismissProcess,
  getAttachedId,
} from './agent/process-manager';
import * as processManager from './agent/process-manager';
import { approveRunApproval, denyRunApproval, listApprovalsForRun, reviseRunApproval } from './agent/approval-manager';
import { listHumanInterventionsForRun, resolveHumanIntervention } from './agent/human-intervention-manager';
import * as policies from './db/policies';
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
import { getBrowserSession } from './browser/session';
import { startCalendarWatcher, stopCalendarWatcher } from './calendar-watcher';
import { initAgentSpawnExecutor } from './agent/agent-spawn-executor';
import { calendarList } from './db/calendar';
import type { MessageAttachment } from '../shared/types';
import { buildUserMessageContent } from './db/conversations';
import { identityStore } from './autonomy/identity-store';
import {
  listSessionDomains,
  mergeDiscoveredSessionAccounts,
  toManagedAccountView,
} from './autonomy/session-discovery';
import { proactiveDetector } from './autonomy/proactive-detector';
import { taskScheduler } from './autonomy/task-scheduler';
import { attachToWebContents } from './autonomy/login-interceptor';
import { getAllUserTabWebContents, setOnNewUserTabCallback } from './browser/manager';

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
      // Wire login interceptor to all current and future user-facing tabs
      for (const wc of getAllUserTabWebContents()) {
        attachToWebContents(wc);
      }
      setOnNewUserTabCallback((wc) => attachToWebContents(wc));
      initProcessManager(mainWindow);
      // Initialize task scheduler — runs stored cron jobs
      taskScheduler.start(async (prompt, taskId) => {
        console.log(`[Scheduler] Running task ${taskId}: ${prompt.slice(0, 60)}`);
        // TODO (Phase 2): wire to process-manager background dispatch
      });
      startCalendarWatcher(mainWindow);
      initAgentSpawnExecutor(mainWindow);
    }
  });

  getDb();
  try {
    const seed = typeof policies.seedPolicyProfiles === 'function' ? policies.seedPolicyProfiles : null;
    if (!seed) console.warn('[Policies] Seed skipped: seedPolicyProfiles export unavailable');
    else seed();
  } catch (error) {
    console.warn('[Policies] Seed failed:', error);
  }
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

  ipcMain.handle(IPC.CHAT_SEND, async (_event, message: string, attachments?: MessageAttachment[]) => {
    const provider = getSelectedProvider();
    const apiKey = getApiKey(provider);
    if (!apiKey) return { error: `No API key set for ${provider}. Go to Settings to add your API key.` };

    const safeAttachments = Array.isArray(attachments) ? attachments : [];
    const synthesizedMessage = !message.trim() && safeAttachments.length > 0
      ? safeAttachments.every((attachment) => attachment.kind === 'image')
        ? `Please analyze the attached image${safeAttachments.length === 1 ? '' : 's'}.`
        : `Please review the attached file${safeAttachments.length === 1 ? '' : 's'}.`
      : message;

    const { cleanedMessage, forcedAgentProfile } = parseManualAgentProfileOverride(synthesizedMessage);
    if (!cleanedMessage.trim()) {
      return { error: 'Slash commands require a prompt, for example: /filesystem-agent find the exact file containing "..." , /bloodhound learn the fastest route to GitHub notifications, /claude-code review this repo for TypeScript errors, or /claude-code-edit fix the failing tests in this repo' };
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
    const processId = processManager.registerProcess(conversationId, cleanedMessage, provider, getSelectedModel(provider));

    addMessage(conversationId, 'user', message.trim(), undefined, safeAttachments);
    proactiveDetector.recordMentions(message.trim());
    const history = getAnthropicHistory(conversationId);
    history.pop();
    const initialUserContent = buildUserMessageContent(cleanedMessage, safeAttachments);

    try {
      const result = await runAgentLoop(cleanedMessage, history, {
        runId: processId,
        provider,
        forcedAgentProfile,
        apiKey,
        model: getSelectedModel(provider),
        onStreamText: (chunk) => processManager.routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, chunk),
        onProgress: (text) => processManager.routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, text),
        onThinking: (thought) => processManager.routeEvent(processId, IPC_EVENTS.CHAT_THINKING, thought),
        onToolActivity: (activity) => {
          processManager.recordToolCall(processId);
          processManager.routeEvent(processId, IPC_EVENTS.CHAT_TOOL_ACTIVITY, activity);
        },
        onToolStream: (payload) => processManager.routeEvent(processId, IPC_EVENTS.CHAT_TOOL_STREAM, payload),
        onWorkflowPlanReset: () => processManager.routeEvent(processId, IPC_EVENTS.CHAT_WORKFLOW_PLAN_RESET, {}),
        onWorkflowPlanText: (chunk) => processManager.routeEvent(processId, IPC_EVENTS.CHAT_WORKFLOW_PLAN_TEXT, chunk),
        onWorkflowPlanEnd: () => processManager.routeEvent(processId, IPC_EVENTS.CHAT_WORKFLOW_PLAN_END, {}),
        onStreamEnd: () => processManager.routeEvent(processId, IPC_EVENTS.CHAT_STREAM_END, {}),
        initialUserContent,
      });

      const finalStatus = result.response?.startsWith('[Cancelled by user]') ? 'cancelled' : 'completed';
      processManager.completeProcess(processId, finalStatus);

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
      processManager.completeProcess(processId, 'failed', err.message);
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
    // Yield to the event loop before running synchronous SQLite queries so any
    // in-flight renders or IPC callbacks can complete first, avoiding UI jank.
    await new Promise<void>((resolve) => setImmediate(resolve));
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
  ipcMain.handle(IPC.CHAT_OPEN_ATTACHMENT, async (_e, filePath: string) => {
    if (!filePath) return { ok: false, error: 'Missing file path' };
    const result = await shell.openPath(filePath);
    return result ? { ok: false, error: result } : { ok: true };
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
  ipcMain.handle(IPC.PROCESS_LIST, async () => processManager.listProcesses());
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
  ipcMain.handle(IPC.POLICY_LIST, async () => policies.listPolicyProfiles());
  ipcMain.handle(IPC.CALENDAR_LIST, (_event, from?: string, to?: string) => {
    return calendarList(from && to ? { from, to } : {});
  });

  // ── Browser URL autocomplete ──
  ipcMain.handle(IPC.BROWSER_HISTORY_MATCH, async (_e, prefix: string) => matchUrlHistory(prefix));

  // ── Filesystem ──
  ipcMain.handle('fs:read-dir', async (_event, dirPath: string) => {
    try {
      const resolved = dirPath.startsWith('~')
        ? dirPath.replace('~', os.homedir())
        : dirPath;
      const entries = fsSync.readdirSync(resolved, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(resolved, e.name),
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
    const resolved = filePath.startsWith('~')
      ? filePath.replace('~', os.homedir())
      : filePath;
    const stat = fsSync.statSync(resolved);
    if (stat.size > 500 * 1024) {
      throw new Error(`File too large: ${Math.round(stat.size / 1024)}KB (max 500KB)`);
    }
    return fsSync.readFileSync(resolved, 'utf-8');
  });

  // ── Desktop app management ──
  ipcMain.handle('desktop:list-apps', async () => {
    if (process.platform !== 'linux') return null;
    try {
      const wmctrlOut = execSync('wmctrl -lp 2>/dev/null', { encoding: 'utf-8' });
      const lines = wmctrlOut.trim().split('\n').filter(Boolean);
      const apps: { name: string; pid: number; windowId: string; memoryMB: number }[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const windowId = parts[0];
        const pid = parseInt(parts[2], 10);
        if (!pid || pid <= 0) continue;
        try {
          const comm = fsSync.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
          const statm = fsSync.readFileSync(`/proc/${pid}/statm`, 'utf-8').trim();
          const pages = parseInt(statm.split(' ')[1], 10);
          const memoryMB = Math.round((pages * 4096) / (1024 * 1024));
          const title = parts.slice(4).join(' ');
          apps.push({ name: title || comm, pid, windowId, memoryMB });
        } catch {
          continue;
        }
      }
      const seen = new Set<number>();
      return apps.filter(a => { if (seen.has(a.pid)) return false; seen.add(a.pid); return true; });
    } catch {
      return [];
    }
  });

  ipcMain.handle('desktop:focus-app', async (_event, windowId: string) => {
    if (process.platform !== 'linux') return;
    try {
      execSync(`wmctrl -ia ${windowId}`);
    } catch { /* ignore */ }
  });

  ipcMain.handle('desktop:kill-app', async (_event, pid: number) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* process may already be gone */ }
  });

  // ── Browser session management ──
  ipcMain.handle('browser:list-sessions', async () => {
    return listSessionDomains(getBrowserSession());
  });

  ipcMain.handle('browser:clear-session', async (_event, domain: string) => {
    const browserSession = getBrowserSession();
    const cookies = await browserSession.cookies.get({ domain });
    for (const cookie of cookies) {
      const cookieDomain = String(cookie.domain || '').replace(/^\./, '');
      if (!cookieDomain) continue;
      const url = `https://${cookieDomain}${cookie.path || '/'}`;
      await browserSession.cookies.remove(url, cookie.name);
    }
  });

  // ── Identity ──
  ipcMain.handle(IPC.IDENTITY_PROFILE_GET, () => {
    return identityStore.getDefaultProfile();
  });

  ipcMain.handle(IPC.IDENTITY_PROFILE_SET, (_e, input: any) => {
    return identityStore.upsertProfile({ ...input, name: 'default', isDefault: true });
  });

  ipcMain.handle(IPC.IDENTITY_ACCOUNTS_LIST, async () => {
    const accounts = identityStore.listAccounts();
    const session = getBrowserSession();
    const managedViews = await Promise.all(accounts.map(async (account) => {
      let accessType: 'session' | 'vault' | 'managed' = 'managed';
      try {
        const cookies = await session.cookies.get({ domain: account.serviceName });
        if (cookies.length > 0) {
          accessType = 'session';
        } else {
          const cred = identityStore.getCredential(account.serviceName, account.serviceName);
          if (cred) accessType = 'vault';
        }
      } catch {
        // cookie check failed — fall through to 'managed'
      }
      return toManagedAccountView(account, accessType);
    }));

    try {
      const discoveredDomains = await listSessionDomains(session);
      return mergeDiscoveredSessionAccounts(managedViews, discoveredDomains);
    } catch {
      return managedViews;
    }
  });

  ipcMain.handle(IPC.IDENTITY_ACCOUNT_ADD, (_e, input: any) => {
    const account = identityStore.saveAccount({ ...input, status: 'active' });
    return toManagedAccountView(account, 'managed');
  });

  ipcMain.handle(IPC.IDENTITY_ACCOUNT_DELETE, (_e, serviceName: string) => {
    identityStore.deleteAccount(serviceName);
    return { ok: true };
  });

  ipcMain.handle(IPC.IDENTITY_CREDENTIALS_LIST, () => {
    return identityStore.listCredentials();
  });

  ipcMain.handle(IPC.IDENTITY_CREDENTIAL_ADD, (_e, label: string, type: string, service: string, valuePlain: string) => {
    identityStore.saveCredential({ label, type: type as any, service, valuePlain });
    return { ok: true };
  });

  ipcMain.handle(IPC.IDENTITY_CREDENTIAL_DELETE, (_e, label: string, service: string) => {
    identityStore.deleteCredential(label, service);
    return { ok: true };
  });
}

app.whenReady().then(createWindow);
app.on('before-quit', () => { closeBrowser(); destroyShell(); });
app.on('window-all-closed', () => { destroyShell(); closeDb(); app.quit(); });
