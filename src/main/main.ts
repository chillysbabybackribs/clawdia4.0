/**
 * Clawdia 4.0 — Main Process
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { IPC, IPC_EVENTS } from '../shared/ipc-channels';
import { runAgentLoop } from './agent/loop';
import { getApiKey, setApiKey, getSelectedModel, setSelectedModel } from './store';
import { getDb, closeDb } from './db/database';
import {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  addMessage,
  getAnthropicHistory,
  getRendererMessages,
  getMessageCount,
} from './db/conversations';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

// Track the active conversation — null means no conversation yet
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

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Initialize database
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
  // ── Window controls ──
  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => mainWindow?.close());

  // ── Chat ──
  ipcMain.handle(IPC.CHAT_SEND, async (_event, message: string) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { error: 'No API key set. Go to Settings to add your Anthropic API key.' };
    }

    // Auto-create conversation if none active
    if (!activeConversationId) {
      const conv = createConversation();
      activeConversationId = conv.id;
      console.log(`[Main] Auto-created conversation: ${conv.id}`);
    }

    // Persist the user message
    addMessage(activeConversationId, 'user', message);

    // Get conversation history for the LLM (Anthropic format)
    const history = getAnthropicHistory(activeConversationId);
    // Remove the last message (the one we just added) — it'll be passed as the userMessage
    history.pop();

    try {
      const result = await runAgentLoop(message, history, {
        apiKey,
        model: getSelectedModel(),
        onStreamText: (chunk) => {
          mainWindow?.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, chunk);
        },
        onThinking: (thought) => {
          mainWindow?.webContents.send(IPC_EVENTS.CHAT_THINKING, thought);
        },
        onToolActivity: (activity) => {
          mainWindow?.webContents.send(IPC_EVENTS.CHAT_TOOL_ACTIVITY, activity);
        },
        onStreamEnd: () => {
          mainWindow?.webContents.send(IPC_EVENTS.CHAT_STREAM_END, {});
        },
      });

      // Persist the assistant response
      if (result.response) {
        addMessage(activeConversationId!, 'assistant', result.response, result.toolCalls);
      }

      return {
        ok: true,
        response: result.response,
        toolCalls: result.toolCalls,
        conversationId: activeConversationId,
      };
    } catch (err: any) {
      console.error('[Main] Agent loop error:', err);
      return { error: err.message || 'Unknown error' };
    }
  });

  ipcMain.handle(IPC.CHAT_STOP, async () => ({ ok: true }));

  ipcMain.handle(IPC.CHAT_NEW, async () => {
    const conv = createConversation();
    activeConversationId = conv.id;
    console.log(`[Main] New conversation: ${conv.id}`);
    return { id: conv.id, title: conv.title };
  });

  ipcMain.handle(IPC.CHAT_LIST, async () => {
    const convs = listConversations();
    return convs.map(c => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updated_at,
      messageCount: getMessageCount(c.id),
    }));
  });

  ipcMain.handle(IPC.CHAT_LOAD, async (_e, id: string) => {
    const conv = getConversation(id);
    if (!conv) return { error: 'Conversation not found' };

    activeConversationId = id;
    const messages = getRendererMessages(id);
    console.log(`[Main] Loaded conversation ${id} with ${messages.length} messages`);

    return {
      id: conv.id,
      title: conv.title,
      messages,
    };
  });

  ipcMain.handle(IPC.CHAT_DELETE, async (_e, id: string) => {
    deleteConversation(id);
    if (activeConversationId === id) {
      activeConversationId = null;
    }
    console.log(`[Main] Deleted conversation ${id}`);
    return { ok: true };
  });

  // ── Settings ──
  ipcMain.handle(IPC.API_KEY_GET, async () => getApiKey());
  ipcMain.handle(IPC.API_KEY_SET, async (_event, key: string) => {
    setApiKey(key);
    console.log(`[Settings] API key ${key ? 'saved' : 'cleared'} (${key.length} chars)`);
    return { ok: true };
  });
  ipcMain.handle(IPC.MODEL_GET, async () => getSelectedModel());
  ipcMain.handle(IPC.MODEL_SET, async (_event, model: string) => {
    setSelectedModel(model);
    console.log(`[Settings] Model set to: ${model}`);
    return { ok: true };
  });
  ipcMain.handle(IPC.SETTINGS_GET, async (_event, key: string) => {
    if (key === 'apiKey') return getApiKey() ? 'set' : '';
    return null;
  });
  ipcMain.handle(IPC.SETTINGS_SET, async (_event, key: string, value: any) => {
    if (key === 'apiKey') setApiKey(value);
    if (key === 'model') setSelectedModel(value);
    return { ok: true };
  });

  // ── Browser stubs ──
  ipcMain.handle(IPC.BROWSER_NAVIGATE, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_BACK, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_FORWARD, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_REFRESH, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_TAB_NEW, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_TAB_LIST, async () => []);
  ipcMain.handle(IPC.BROWSER_TAB_SWITCH, async () => ({ ok: true }));
  ipcMain.handle(IPC.BROWSER_TAB_CLOSE, async () => ({ ok: true }));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  closeDb();
  app.quit();
});
