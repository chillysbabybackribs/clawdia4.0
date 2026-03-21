import type { BrowserView } from 'electron';
import { withTimeout } from './waits';

export interface BrowserNetworkEntry {
  id: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  timestamp: number;
  tabId?: string;
  errorText?: string;
}

export interface DebuggerEvaluateOptions {
  timeoutMs?: number;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  userGesture?: boolean;
  frameId?: string;
}

type DebuggerEventHandler = (method: string, params: Record<string, any>, view: BrowserView) => void;

interface SessionState {
  wcId: number;
  attached: boolean;
  handlers: Set<DebuggerEventHandler>;
  network: {
    enabled: boolean;
    limit: number;
    buffer: BrowserNetworkEntry[];
    byRequestId: Map<string, BrowserNetworkEntry>;
  };
  onMessage: ((event: Event, method: string, params?: Record<string, any>) => void) | null;
  onDetach: ((event: Event, reason: string) => void) | null;
  onDestroyed: (() => void) | null;
}

const sessions = new Map<number, SessionState>();

function getSessionState(view: BrowserView): SessionState {
  const wcId = view.webContents.id;
  let state = sessions.get(wcId);
  if (state) return state;

  state = {
    wcId,
    attached: false,
    handlers: new Set(),
    network: {
      enabled: false,
      limit: 200,
      buffer: [],
      byRequestId: new Map(),
    },
    onMessage: null,
    onDetach: null,
    onDestroyed: null,
  };
  sessions.set(wcId, state);
  return state;
}

function bindLifecycle(view: BrowserView, state: SessionState): void {
  if (state.onMessage) return;
  const wc = view.webContents;

  state.onMessage = (_event: Event, method: string, params?: Record<string, any>) => {
    const payload = params || {};
    if (state.network.enabled) captureNetworkEvent(state, method, payload);
    for (const handler of state.handlers) handler(method, payload, view);
  };
  state.onDetach = () => {
    state.attached = false;
    state.network.enabled = false;
    state.network.byRequestId.clear();
  };
  state.onDestroyed = () => cleanupDebuggerSession(view);

  wc.debugger.on('message', state.onMessage as any);
  wc.debugger.on('detach', state.onDetach as any);
  wc.on('destroyed', state.onDestroyed);
}

export async function ensureDebuggerAttached(view: BrowserView): Promise<void> {
  const wc = view.webContents;
  if (wc.isDestroyed()) throw new Error('Cannot attach debugger to a destroyed browser view');
  const state = getSessionState(view);
  bindLifecycle(view, state);

  if (wc.debugger.isAttached()) {
    state.attached = true;
    return;
  }

  try {
    wc.debugger.attach('1.3');
    state.attached = true;
  } catch (error: any) {
    if (wc.debugger.isAttached()) {
      state.attached = true;
      return;
    }
    throw new Error(`Failed to attach debugger: ${error?.message || String(error)}`);
  }
}

export async function detachDebugger(view: BrowserView): Promise<void> {
  const wc = view.webContents;
  const state = sessions.get(wc.id);
  if (!state) return;
  if (wc.isDestroyed()) {
    cleanupDebuggerSession(view);
    return;
  }

  if (wc.debugger.isAttached()) {
    try {
      wc.debugger.detach();
    } catch {
      // Ignore stale detach failures during teardown.
    }
  }
  state.attached = false;
  state.network.enabled = false;
  state.network.byRequestId.clear();
}

export async function sendDebuggerCommand<T = Record<string, any>>(
  view: BrowserView,
  method: string,
  params?: Record<string, any>,
  timeoutMs: number = 5_000,
): Promise<T> {
  await ensureDebuggerAttached(view);
  const wc = view.webContents;
  if (wc.isDestroyed()) throw new Error(`Cannot send ${method} to a destroyed browser view`);

  try {
    return await withTimeout(
      wc.debugger.sendCommand(method, params || {}) as Promise<T>,
      timeoutMs,
      `Timed out waiting for debugger command ${method}`,
    );
  } catch (error: any) {
    if (!wc.isDestroyed() && !wc.debugger.isAttached()) {
      await ensureDebuggerAttached(view);
      return await withTimeout(
        wc.debugger.sendCommand(method, params || {}) as Promise<T>,
        timeoutMs,
        `Timed out waiting for debugger command ${method} after reattach`,
      );
    }
    throw new Error(`Debugger command ${method} failed: ${error?.message || String(error)}`);
  }
}

export async function evaluateDebuggerExpression<T = Record<string, any>>(
  view: BrowserView,
  expression: string,
  options: DebuggerEvaluateOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const params: Record<string, any> = {
    expression,
    returnByValue: options.returnByValue !== false,
    awaitPromise: options.awaitPromise !== false,
    userGesture: options.userGesture !== false,
  };

  if (options.frameId) {
    const world = await sendDebuggerCommand<{ executionContextId: number }>(
      view,
      'Page.createIsolatedWorld',
      {
        frameId: options.frameId,
        worldName: `clawdia-frame-${view.webContents.id}`,
        grantUniversalAccess: false,
      },
      timeoutMs,
    );
    params.contextId = world.executionContextId;
  }

  return await sendDebuggerCommand<T>(view, 'Runtime.evaluate', params, timeoutMs);
}

export function subscribeToDebuggerEvents(view: BrowserView, handler: DebuggerEventHandler): () => void {
  const state = getSessionState(view);
  bindLifecycle(view, state);
  state.handlers.add(handler);
  return () => {
    const nextState = sessions.get(view.webContents.id);
    nextState?.handlers.delete(handler);
  };
}

export async function startNetworkWatch(view: BrowserView, limit: number = 200): Promise<void> {
  const state = getSessionState(view);
  state.network.limit = Math.max(10, Math.min(limit, 500));
  state.network.enabled = true;
  state.network.buffer = [];
  state.network.byRequestId.clear();
  await sendDebuggerCommand(view, 'Network.enable');
}

export async function stopNetworkWatch(view: BrowserView): Promise<void> {
  const state = getSessionState(view);
  if (!state.network.enabled) return;
  state.network.enabled = false;
  state.network.byRequestId.clear();
  if (!view.webContents.isDestroyed() && view.webContents.debugger.isAttached()) {
    try {
      await sendDebuggerCommand(view, 'Network.disable');
    } catch {
      // Best-effort shutdown only.
    }
  }
}

export function getRecentNetworkActivity(view: BrowserView, limit: number = 50): BrowserNetworkEntry[] {
  const state = getSessionState(view);
  const slice = state.network.buffer.slice(-Math.max(1, Math.min(limit, state.network.limit)));
  return slice.map(entry => ({ ...entry }));
}

export function cleanupDebuggerSession(view: BrowserView): void {
  const wc = view.webContents;
  const state = sessions.get(wc.id);
  if (!state) return;

  if (state.onMessage) wc.debugger.removeListener('message', state.onMessage as any);
  if (state.onDetach) wc.debugger.removeListener('detach', state.onDetach as any);
  if (state.onDestroyed) wc.removeListener('destroyed', state.onDestroyed);

  if (!wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      wc.debugger.detach();
    } catch {
      // Ignore detach failures on teardown.
    }
  }

  sessions.delete(wc.id);
}

function captureNetworkEvent(state: SessionState, method: string, params: Record<string, any>): void {
  if (method === 'Network.requestWillBeSent') {
    const entry: BrowserNetworkEntry = {
      id: params.requestId || `req-${Date.now()}`,
      url: params.request?.url || '',
      method: params.request?.method || 'GET',
      resourceType: params.type || 'Other',
      timestamp: Date.now(),
    };
    state.network.byRequestId.set(entry.id, entry);
    pushNetworkEntry(state, entry);
    return;
  }

  if (method === 'Network.responseReceived') {
    const requestId = params.requestId;
    const existing = requestId ? state.network.byRequestId.get(requestId) : undefined;
    const entry: BrowserNetworkEntry = existing || {
      id: requestId || `resp-${Date.now()}`,
      url: params.response?.url || '',
      method: 'GET',
      timestamp: Date.now(),
    };
    entry.status = params.response?.status;
    entry.resourceType = params.type || entry.resourceType;
    entry.url = params.response?.url || entry.url;
    entry.timestamp = Date.now();
    state.network.byRequestId.set(entry.id, entry);
    pushNetworkEntry(state, entry);
    return;
  }

  if (method === 'Network.loadingFailed') {
    const requestId = params.requestId;
    const existing = requestId ? state.network.byRequestId.get(requestId) : undefined;
    const entry: BrowserNetworkEntry = existing || {
      id: requestId || `fail-${Date.now()}`,
      url: '',
      method: 'GET',
      timestamp: Date.now(),
    };
    entry.errorText = params.errorText || 'Request failed';
    entry.timestamp = Date.now();
    state.network.byRequestId.set(entry.id, entry);
    pushNetworkEntry(state, entry);
  }
}

function pushNetworkEntry(state: SessionState, entry: BrowserNetworkEntry): void {
  const copy = { ...entry };
  state.network.buffer.push(copy);
  if (state.network.buffer.length > state.network.limit) {
    state.network.buffer.splice(0, state.network.buffer.length - state.network.limit);
  }
}
