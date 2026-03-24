/**
 * Browser Manager — Multi-tab BrowserView management.
 *
 * Each tab is a separate BrowserView with its own webContents.
 * Only the active tab is visible (has real bounds). Inactive tabs
 * are hidden at (0,0,0,0). Max 12 tabs to support parallel agent usage.
 *
 * AGENT TAB REGISTRY
 * ------------------
 * Sub-agents spawned by agent_spawn run in parallel and need isolated browser
 * contexts so they don't clobber each other's navigation state.
 *
 * Call allocateAgentTab(runId) before a sub-agent starts its loop — this
 * creates a dedicated hidden tab and binds it to that runId. All browser
 * tool functions accept an optional runId; when provided they operate on the
 * agent's private tab instead of the visible active tab. Call
 * releaseAgentTab(runId) when the sub-agent finishes to destroy the tab.
 *
 * The main (user-facing) loop passes no runId, so it always uses the active
 * visible tab as before — zero behaviour change for the primary agent.
 */

import { app, BrowserView, BrowserWindow, Menu } from 'electron';
import { randomUUID } from 'crypto';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import type { BrowserExecutionMode } from '../../shared/types';
import { BROWSER_PARTITION, getBrowserSession } from './session';
import { wait, waitForDomSettled, waitForLoad, waitForPageReady, waitForPotentialNavigation, waitForSelector, waitForText, waitForUrlMatch, withTimeout } from './waits';
import { fillFieldWithInputEvents } from './native-input';
import {
  cleanupDebuggerSession,
  evaluateDebuggerExpression,
  getRecentNetworkActivity,
  sendDebuggerCommand,
  startNetworkWatch,
  stopNetworkWatch,
} from './debugger-session';
import { buildDomSnapshot, type DomSnapshotResult } from './dom-snapshot';
import { buildCommerceExtractionScript, buildComparisonResult, isCommerceInstruction, pickExtractionKind } from './commerce-extract';
import { executeBrowserBatchSteps } from './batch';
import { buildEvalErrorEnvelope, buildEvalSuccessEnvelope, normalizeEvalException, normalizeThrownEvalError } from './eval-envelope';
import { buildPageStateSnapshot, summarizeExtraction } from './page-state';
import type {
  BrowserBatchResult,
  BrowserBatchStep,
  BrowserPageStateSnapshot,
  ProductComparisonResult,
  StructuredExtractionEnvelope,
} from './runtime-types';

const MAX_TABS = 6;
const MAX_HISTORY = 200;
const CHROME_FALLBACK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const AUTH_POPUP_PATH_RE = /\/oauth|\/authorize|\/login|\/signin|\/sign-in|\/auth|\/sso|\/saml/i;

interface Tab {
  id: string;
  view: BrowserView;
  url: string;
  title: string;
  isLoading: boolean;
  loadingTimer: ReturnType<typeof setTimeout> | null;
  faviconUrl: string;
  hidden: boolean;
  ownerRunId?: string;
}

export interface BrowserTarget {
  tabId?: string;
  runId?: string;
  frameId?: string;
}

export interface BrowserEvalOptions {
  timeoutMs?: number;
  awaitPromise?: boolean;
  maxResultChars?: number;
}

let mainWindow: BrowserWindow | null = null;
let tabs: Map<string, Tab> = new Map();
let activeTabId: string | null = null;
let isolatedTabsByRunId: Map<string, string> = new Map();
let currentBounds = { x: 0, y: 0, width: 0, height: 0 };
let executionMode: BrowserExecutionMode = 'headed';
let browserSessionInitialized = false;
let pageStateByTabId = new Map<string, {
  extractedEntities: Record<string, any>;
  recentExtractionResults: Array<{ kind: string; recordedAt: string; data: any }>;
  lastActionResult?: { action: string; recordedAt: string; summary: string; ok: boolean };
  version: number;
  updatedAt: string;
}>();

// URL history for autocomplete — stores visited URLs, most recent first
let urlHistory: string[] = [];

function addToHistory(url: string): void {
  if (!url || url === 'about:blank') return;
  // Remove if already present (move to front)
  urlHistory = urlHistory.filter(u => u !== url);
  urlHistory.unshift(url);
  // Cap size
  if (urlHistory.length > MAX_HISTORY) urlHistory.length = MAX_HISTORY;
}

/**
 * Find the best URL match for a prefix. Used by the URL bar autocomplete.
 * Matches against the full URL and also against the domain without protocol.
 * Returns the full URL or empty string.
 */
export function matchUrlHistory(prefix: string): string {
  if (!prefix || prefix.length < 2) return '';
  const lower = prefix.toLowerCase();

  for (const url of urlHistory) {
    // Match against full URL
    if (url.toLowerCase().startsWith(lower)) return url;
    // Match against URL without protocol (user types "yah" matches "https://yahoo.com")
    const noProto = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (noProto.toLowerCase().startsWith(lower)) return url;
  }
  return '';
}

// ═══════════════════════════════════
// Initialization + Tab Lifecycle
// ═══════════════════════════════════

export function initBrowser(win: BrowserWindow): void {
  mainWindow = win;
  initBrowserSession();
  createTab('https://www.google.com');
  emitModeChanged('init');
  console.log('[Browser] Initialized with tabs');
}

function getChromeLikeUserAgent(): string {
  const base = (app.userAgentFallback || '').trim();
  if (!base) return CHROME_FALLBACK_UA;

  const withoutElectron = base
    .replace(/\sElectron\/[^\s]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return /Chrome\/\d+/i.test(withoutElectron) ? withoutElectron : CHROME_FALLBACK_UA;
}

function initBrowserSession(): void {
  if (browserSessionInitialized) return;
  browserSessionInitialized = true;

  const sess = getBrowserSession();
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = {
      ...details.requestHeaders,
      'Accept-Language': 'en-US,en;q=0.9',
    };
    callback({ requestHeaders });
  });
}

function getActiveView(target?: BrowserTarget): BrowserView | null {
  return resolveTab(target)?.view || null;
}

function emitTabsChanged(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send(IPC_EVENTS.BROWSER_TABS_CHANGED, getTabList());
}

function safeRemoveBrowserView(view: BrowserView): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.removeBrowserView(view);
  } catch (error: any) {
    console.warn('[Browser] removeBrowserView skipped:', error?.message || error);
  }
}

export function getTabList(): { id: string; url: string; title: string; isLoading: boolean; isActive: boolean; faviconUrl: string }[] {
  return Array.from(tabs.values()).filter(t => !t.hidden).map(t => ({
    id: t.id,
    url: t.url,
    title: t.title || 'New Tab',
    isLoading: t.isLoading,
    isActive: t.id === activeTabId,
    faviconUrl: t.faviconUrl || '',
  }));
}

function resolveTab(target?: BrowserTarget): Tab | null {
  if (target?.tabId) return tabs.get(target.tabId) || null;
  if (target?.runId) {
    const isolatedTabId = isolatedTabsByRunId.get(target.runId);
    if (isolatedTabId) return tabs.get(isolatedTabId) || null;
  }
  if (!activeTabId) return null;
  return tabs.get(activeTabId) || null;
}

function getOrCreatePageState(tabId: string) {
  let state = pageStateByTabId.get(tabId);
  if (state) return state;
  state = {
    extractedEntities: {},
    recentExtractionResults: [],
    version: 0,
    updatedAt: new Date().toISOString(),
  };
  pageStateByTabId.set(tabId, state);
  return state;
}

function markPageStateUpdated(tabId: string, mutate?: (state: ReturnType<typeof getOrCreatePageState>) => void): void {
  const state = getOrCreatePageState(tabId);
  if (mutate) mutate(state);
  state.version += 1;
  state.updatedAt = new Date().toISOString();
}

function recordLastAction(target: BrowserTarget | undefined, action: string, summary: string, ok: boolean): void {
  const tab = resolveTab(target);
  if (!tab) return;
  markPageStateUpdated(tab.id, (state) => {
    state.lastActionResult = {
      action,
      summary: summary.slice(0, 240),
      ok,
      recordedAt: new Date().toISOString(),
    };
  });
}

function recordExtraction(target: BrowserTarget | undefined, kind: string, data: any): void {
  const tab = resolveTab(target);
  if (!tab) return;
  markPageStateUpdated(tab.id, (state) => {
    state.extractedEntities[kind] = data;
    state.recentExtractionResults.push({
      kind,
      data,
      recordedAt: new Date().toISOString(),
    });
    if (state.recentExtractionResults.length > 5) {
      state.recentExtractionResults.splice(0, state.recentExtractionResults.length - 5);
    }
  });
}

export function createTab(url?: string, opts: { hidden?: boolean; activate?: boolean; ownerRunId?: string } = {}): string {
  if (!mainWindow) throw new Error('Browser not initialized');
  if (tabs.size >= MAX_TABS) {
    console.warn(`[Browser] Tab limit reached (${MAX_TABS}).`);
    return activeTabId || '';
  }

  const id = randomUUID().slice(0, 8);
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: BROWSER_PARTITION,
    },
  });
  view.webContents.setUserAgent(getChromeLikeUserAgent());

  mainWindow.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  const tab: Tab = {
    id,
    view,
    url: '',
    title: 'New Tab',
    isLoading: false,
    loadingTimer: null,
    faviconUrl: '',
    hidden: opts.hidden === true,
    ownerRunId: opts.ownerRunId,
  };
  tabs.set(id, tab);
  if (opts.ownerRunId) isolatedTabsByRunId.set(opts.ownerRunId, id);
  wireTabEvents(tab);
  if (opts.activate !== false && !tab.hidden) switchTab(id);

  if (url) view.webContents.loadURL(ensureUrl(url));

  // Notify login interceptor of new user-facing tab
  if (!opts.ownerRunId) {
    _notifyNewUserTab(view.webContents);
  }

  console.log(`[Browser] Created tab ${id} (${tabs.size} total)`);
  emitTabsChanged();
  return id;
}

export function switchTab(id: string): void {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return;
  if (tab.hidden) {
    console.warn(`[Browser] Refusing to switch visible view to hidden tab ${id}`);
    return;
  }

  if (activeTabId && activeTabId !== id) {
    const prevTab = tabs.get(activeTabId);
    if (prevTab) prevTab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  activeTabId = id;

  if (currentBounds.width > 0 && currentBounds.height > 0) {
    tab.view.setBounds({
      x: Math.round(currentBounds.x), y: Math.round(currentBounds.y),
      width: Math.round(currentBounds.width), height: Math.round(currentBounds.height),
    });
  }

  mainWindow.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, tab.url);
  mainWindow.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, tab.title);
  mainWindow.webContents.send(IPC_EVENTS.BROWSER_LOADING, tab.isLoading);
  emitTabsChanged();
}

export function closeTab(id: string): void {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return;

  if (!tab.hidden && getTabList().length <= 1) {
    tab.view.webContents.loadURL('https://www.google.com');
    return;
  }

  if (tab.loadingTimer) clearTimeout(tab.loadingTimer);
  cleanupDebuggerSession(tab.view);
  safeRemoveBrowserView(tab.view);
  (tab.view.webContents as any)?.destroy?.();
  pageStateByTabId.delete(id);
  tabs.delete(id);
  if (tab.ownerRunId) isolatedTabsByRunId.delete(tab.ownerRunId);

  if (activeTabId === id) {
    const remaining = Array.from(tabs.values()).filter(candidate => !candidate.hidden).map(candidate => candidate.id);
    activeTabId = remaining[remaining.length - 1] || null;
    if (activeTabId) switchTab(activeTabId);
  }

  console.log(`[Browser] Closed tab ${id} (${tabs.size} remaining)`);
  emitTabsChanged();
}

export function allocateIsolatedTab(runId: string, url = 'about:blank'): string {
  const existing = isolatedTabsByRunId.get(runId);
  if (existing && tabs.has(existing)) return existing;
  return createTab(url, { hidden: true, activate: false, ownerRunId: runId });
}

export function releaseIsolatedTab(runId: string): void {
  const tabId = isolatedTabsByRunId.get(runId);
  if (!tabId) return;
  isolatedTabsByRunId.delete(runId);
  if (tabs.has(tabId)) closeTab(tabId);
}

/** Known auth provider hostnames — navigations within these are part of the flow, not completion. */
const AUTH_PROVIDER_HOSTS = new Set([
  'accounts.google.com', 'google.com',
  'login.microsoftonline.com', 'login.live.com', 'account.microsoft.com',
  'appleid.apple.com',
  'github.com',
  'accounts.reddit.com',
  'auth0.com',
  'okta.com',
]);

function isSameOriginUrl(currentUrl: string, targetUrl: string): boolean {
  try {
    return new URL(currentUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}

function looksLikeAuthPopup(url: string, features?: string): boolean {
  const popupFeatures = (features || '').toLowerCase();
  return isAuthProviderHost(url) ||
    AUTH_POPUP_PATH_RE.test(url) ||
    /(?:^|,)(?:popup|width|height|left|top)=/i.test(popupFeatures);
}

function isDevToolsShortcut(input: Electron.Input): boolean {
  return input.type === 'keyDown' &&
    (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toUpperCase() === 'I'));
}

function toggleDevTools(wc: Electron.WebContents): void {
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

function isAuthProviderHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // Match exact hosts and subdomains (e.g. foo.okta.com)
    for (const provider of AUTH_PROVIDER_HOSTS) {
      if (host === provider || host.endsWith('.' + provider)) return true;
    }
  } catch {}
  return false;
}

/**
 * Watch an auth/OAuth tab for completion. Completion = the tab leaves the
 * auth provider's domain entirely (navigates back to the app's domain).
 * At that point we close the auth tab and reload the opener.
 */
function watchAuthTab(authTabId: string, openerTabId: string): void {
  const authTab = tabs.get(authTabId);
  if (!authTab) return;

  let completing = false;

  const onNavigate = (_event: any, url: string) => {
    if (completing) return;
    // Still on the auth provider — user is going through sign-in steps, do nothing
    if (isAuthProviderHost(url)) return;

    // Navigated away from the auth provider = handshake complete.
    // Wait for the page to finish loading before closing the tab — closing
    // mid-navigation tears the renderer widget and causes Mojo errors.
    completing = true;
    console.log(`[Browser] OAuth complete, returned to: ${url.slice(0, 80)}`);

    const wc = authTab.view.webContents;

    const finish = () => {
      cleanup();
      if (wc.isDestroyed()) return;
      // Small delay to let the page settle before tearing down the BrowserView
      setTimeout(() => {
        if (tabs.has(authTabId)) closeTab(authTabId);
        const openerTab = tabs.get(openerTabId);
        if (openerTab && !openerTab.view.webContents.isDestroyed()) {
          switchTab(openerTabId);
          openerTab.view.webContents.reload();
        }
      }, 300);
    };

    // If already finished loading, go immediately; otherwise wait for it
    if (!wc.isLoading()) {
      finish();
    } else {
      wc.once('did-finish-load', finish);
      wc.once('did-fail-load', finish);
      // Safety timeout — don't wait more than 5s for the callback page to load
      setTimeout(() => { if (completing) finish(); }, 5000);
    }
  };

  const cleanup = () => {
    if (!authTab.view.webContents.isDestroyed()) {
      authTab.view.webContents.removeListener('did-navigate', onNavigate);
      authTab.view.webContents.removeListener('destroyed', cleanup);
    }
  };

  authTab.view.webContents.on('did-navigate', onNavigate);
  authTab.view.webContents.on('destroyed', cleanup);
}

function wireTabEvents(tab: Tab): void {
  const wc = tab.view.webContents;

  wc.on('before-input-event', (event, input) => {
    if (!isDevToolsShortcut(input)) return;
    event.preventDefault();
    toggleDevTools(wc);
  });

  // Context menu for browser pages (copy, paste, back/forward, inspect)
  wc.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText.length > 0) {
      items.push({ label: 'Copy', role: 'copy' });
    }
    if (params.isEditable) {
      items.push(
        { label: 'Cut', role: 'cut', enabled: params.selectionText.length > 0 },
        { label: 'Paste', role: 'paste' },
      );
    }
    if (params.linkURL) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { label: 'Open Link in New Tab', click: () => createTab(params.linkURL) },
        { label: 'Copy Link Address', click: () => { require('electron').clipboard.writeText(params.linkURL); } },
      );
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Forward', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    );
    Menu.buildFromTemplate(items).popup({ window: mainWindow! });
  });

  wc.on('did-navigate', (_event, url) => {
    tab.url = url;
    tab.title = wc.getTitle();
    addToHistory(url); // Track for autocomplete
    if (tab.id === activeTabId) {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, url);
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, tab.title);
    }
    emitTabsChanged();
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    tab.url = url;
    addToHistory(url);
    if (tab.id === activeTabId) {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, url);
    }
    emitTabsChanged();
  });

  wc.on('page-title-updated', (_event, title) => {
    tab.title = title;
    if (tab.id === activeTabId) {
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, title);
    }
    emitTabsChanged();
  });

  wc.on('page-favicon-updated', (_event, favicons: string[]) => {
    if (favicons && favicons.length > 0) {
      tab.faviconUrl = favicons[0];
      emitTabsChanged();
    }
  });

  wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      tab.isLoading = true;
      if (tab.loadingTimer) { clearTimeout(tab.loadingTimer); tab.loadingTimer = null; }
      if (tab.id === activeTabId) {
        mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
      }
      emitTabsChanged();
    }
  });

  const scheduleStop = () => {
    if (tab.loadingTimer) clearTimeout(tab.loadingTimer);
    tab.loadingTimer = setTimeout(() => {
      tab.loadingTimer = null;
      tab.isLoading = false;
      if (tab.id === activeTabId) {
        mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
      }
      emitTabsChanged();
    }, 300);
  };

  wc.on('did-finish-load', scheduleStop);
  wc.on('did-stop-loading', scheduleStop);
  wc.on('dom-ready', scheduleStop);
  wc.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    const normalizedUrl = String(failedUrl || '').trim();
    const benignAbort = errorCode === -3 || /ERR_ABORTED/i.test(String(errorDescription || ''));
    const benignBlank = errorCode === -300 && normalizedUrl === 'about:blank';
    if (!benignAbort && !benignBlank) {
      console.warn(`[Browser] Tab ${tab.id} load failed: ${errorCode}${errorDescription ? ` ${errorDescription}` : ''}`);
    }
    scheduleStop();
  });

  wc.setWindowOpenHandler(({ url, features }) => {
    try {
      const isSameOrigin = isSameOriginUrl(wc.getURL(), url);
      const isAuthPopup = looksLikeAuthPopup(url, features);

      if (isSameOrigin && !isAuthPopup) {
        // Same-origin popup/in-app modal — navigate the current tab.
        // Opening a new tab breaks modal/overlay flows.
        wc.loadURL(url);
        return { action: 'deny' };
      }

      if (isAuthPopup) {
        // Auth provider popup — open in controlled tab and watch for callback
        const openerTabId = activeTabId;
        const authTabId = createTab(url);
        if (openerTabId) watchAuthTab(authTabId, openerTabId);
      } else {
        // Generic external link — open in new tab
        createTab(url);
      }
    } catch {
      createTab(url);
    }
    return { action: 'deny' };
  });
}

// ═══════════════════════════════════
// Bounds
// ═══════════════════════════════════

export function setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  currentBounds = bounds;
  const view = getActiveView();
  if (executionMode !== 'headless' && view && bounds.width > 0 && bounds.height > 0) {
    view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  }
}

export function hideBrowser(): void { getActiveView()?.setBounds({ x: 0, y: 0, width: 0, height: 0 }); }
export function showBrowser(): void { if (currentBounds.width > 0) setBounds(currentBounds); }

export function getBrowserExecutionMode(): BrowserExecutionMode {
  return executionMode;
}

export function setBrowserExecutionMode(mode: BrowserExecutionMode, reason = 'manual'): void {
  if (executionMode === mode) return;
  executionMode = mode;

  if (mode === 'headless') hideBrowser();
  else showBrowser();

  emitModeChanged(reason);
  console.log(`[Browser] Execution mode → ${mode} (${reason})`);
}

function emitModeChanged(reason: string): void {
  mainWindow?.webContents.send(IPC_EVENTS.BROWSER_MODE_CHANGED, { mode: executionMode, reason });
}

// ═══════════════════════════════════
// Navigation
// ═══════════════════════════════════

export function ensureUrl(url: string): string {
  let u = url.trim();
  if (!u) return u;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u;
  if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
  return u;
}

export async function navigate(url: string, target?: BrowserTarget): Promise<{ title: string; url: string; content: string; elements: string }> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  const wc = view.webContents;
  try { await wc.loadURL(ensureUrl(url)); } catch (err: any) {
    if (!err.message?.includes('ERR_ABORTED')) console.warn(`[Browser] Nav error: ${err.message}`);
  }
  await waitForPageReady(view, { timeoutMs: 12_000, settleMs: 200 });
  // Fetch text + interactive elements in parallel
  const [content, elements] = await Promise.all([getVisibleText(target), getInteractiveElements(target)]);
  recordLastAction(target, 'navigate', `Loaded ${wc.getURL()}`, true);
  return { title: wc.getTitle(), url: wc.getURL(), content, elements };
}

export async function goBack(target?: BrowserTarget): Promise<void> { const v = getActiveView(target); if (v?.webContents.canGoBack()) v.webContents.goBack(); }
export async function goForward(target?: BrowserTarget): Promise<void> { const v = getActiveView(target); if (v?.webContents.canGoForward()) v.webContents.goForward(); }
export async function reload(target?: BrowserTarget): Promise<void> { getActiveView(target)?.webContents.reload(); }
export function getCurrentUrl(target?: BrowserTarget): string { return getActiveView(target)?.webContents.getURL() || ''; }

// ═══════════════════════════════════
// Content extraction
// ═══════════════════════════════════

export async function getVisibleText(target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) return '';
  try {
    const text = await view.webContents.executeJavaScript(`(function(){const c=document.body.cloneNode(true);c.querySelectorAll('script,style,noscript,svg,iframe').forEach(e=>e.remove());return c.innerText.trim()})()`);
    return text.length > 15000 ? text.slice(0, 15000) + '\n\n[Truncated]' : text;
  } catch (err: any) { return '[Failed to extract text]'; }
}

export async function getInteractiveElements(target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) return '';
  try {
    return await view.webContents.executeJavaScript(`(function(){
      var e=[];
      var sel='a[href],button,input,textarea,select,[contenteditable="true"],[role=button],[role=link],[role=tab],[role=menuitem],[role=textbox],[onclick],[data-action]';
      function labelFor(el){
        var aria=el.getAttribute('aria-label')||'';
        if(aria) return aria.trim();
        var placeholder=el.getAttribute('placeholder')||'';
        if(placeholder) return placeholder.trim();
        var labelledby=el.getAttribute('aria-labelledby')||'';
        if(labelledby){
          var text=labelledby.split(/\\s+/).map(function(id){
            var ref=document.getElementById(id);
            return ref ? (ref.textContent||'').trim() : '';
          }).filter(Boolean).join(' ');
          if(text) return text.slice(0,80);
        }
        var tx=(el.textContent||'').trim().replace(/\\s+/g,' ');
        if(tx) return tx.slice(0,80);
        var parent=el.closest('label');
        if(parent){
          var parentText=(parent.textContent||'').trim().replace(/\\s+/g,' ');
          if(parentText) return parentText.slice(0,80);
        }
        return '';
      }
      document.querySelectorAll(sel).forEach(function(el){
        if(e.length>=100)return;
        var r=el.getBoundingClientRect();
        if(r.width===0||r.height===0)return;
        var t=el.tagName.toLowerCase();
        var tx=(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80);
        var h=el.getAttribute('href')||'';
        var ty=el.getAttribute('type')||'';
        var p=el.getAttribute('placeholder')||'';
        var ar=el.getAttribute('aria-label')||'';
        var nm=el.getAttribute('name')||'';
        var rl=el.getAttribute('role')||'';
        var ce=el.getAttribute('contenteditable')||'';
        var lb=labelFor(el);
        var d='['+e.length+'] '+t;
        if(rl&&rl!=='button')d+='[role='+rl+']';
        if(ty)d+='[type='+ty+']';
        if(ce==='true')d+='[contenteditable=true]';
        if(ar)d+=' aria="'+ar.slice(0,60)+'"';
        else if(lb)d+=' "'+lb+'"';
        else if(tx)d+=' "'+tx+'"';
        if(nm)d+=' name='+nm;
        if(h&&h.length<80)d+=' → '+h;
        else if(h)d+=' → '+h.slice(0,60)+'...';
        if(p)d+=' ('+p+')';
        e.push(d);
      });
      return e.join('\\n');
    })()`);
  } catch { return ''; }
}

export async function clickElement(target: string, browserTarget?: BrowserTarget): Promise<string> {
  const view = getActiveView(browserTarget);
  if (!view) throw new Error('No active tab');
  try {
    const result = await view.webContents.executeJavaScript(`(function(){
      const t=${JSON.stringify(target)};
      const candidates=Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[contenteditable="true"],[role=button],[role=textbox],[onclick]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});
      function describe(el){
        return (el.getAttribute('aria-label')||(el.textContent||'').trim()||el.getAttribute('placeholder')||el.tagName.toLowerCase()).slice(0,60);
      }
      function activate(el){
        if(typeof el.focus==='function') el.focus();
        if(el.isContentEditable){
          const range=document.createRange();
          range.selectNodeContents(el);
          range.collapse(true);
          const sel=window.getSelection();
          if(sel){sel.removeAllRanges();sel.addRange(range);}
        }
        if(typeof el.click==='function') el.click();
        return describe(el);
      }
      if(/^\\d+$/.test(t)){
        const i=parseInt(t,10);
        if(i>=candidates.length)return'Error: Index '+i+' out of range ('+candidates.length+')';
        const desc=activate(candidates[i]);
        return 'Clicked ['+i+']: '+desc;
      }
      if(t.startsWith('.')||t.startsWith('#')||t.startsWith('[')){
        const el=document.querySelector(t);
        if(!el)return'Error: No match "'+t+'"';
        return 'Clicked: '+activate(el);
      }
      const lowered=t.toLowerCase();
      for(const el of candidates){
        const text=((el.getAttribute('aria-label')||'')+' '+((el.textContent||'').trim())+' '+(el.getAttribute('placeholder')||'')).toLowerCase();
        if(text.includes(lowered)) return 'Clicked: '+activate(el);
      }
      return'Error: No match "'+t+'"';
    })()`);
    await waitForPotentialNavigation(view, { timeoutMs: 6_000, settleMs: 200 });
    recordLastAction(browserTarget, 'click', result, !String(result).startsWith('Error:'));
    return result;
  } catch (err: any) { return '[Error clicking]: ' + err.message; }
}

export async function typeText(text: string, selector?: string, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  if (selector) {
    const found = await waitForSelector(view, selector, { timeoutMs: 4_000 });
    if (!found) return `[Error typing]: Selector "${selector}" did not become available`;
  }
  try {
    const result = await view.webContents.executeJavaScript(`(function(){
      var t=${JSON.stringify(text)};
      var s=${JSON.stringify(selector||'')};
      function isEditable(el){
        if(!el) return false;
        if(el.isContentEditable) return true;
        var tag=el.tagName;
        var type=(el.getAttribute('type')||'').toLowerCase();
        var role=(el.getAttribute('role')||'').toLowerCase();
        if(role==='textbox') return true;
        if(tag==='TEXTAREA') return true;
        if(tag==='INPUT' && !['hidden','submit','button','checkbox','radio','file'].includes(type)) return true;
        // Web Component support: if the element has a shadowRoot, look for an
        // editable element inside it (Reddit, GitHub, etc. use custom elements)
        if(el.shadowRoot){
          var inner=el.shadowRoot.querySelector('input,textarea,[contenteditable="true"],[role=textbox]');
          if(inner) return true;
        }
        // Also check if any child is contenteditable (for wrapper elements)
        var ceChild=el.querySelector&&el.querySelector('[contenteditable="true"],[role=textbox],textarea,input:not([type=hidden])');
        if(ceChild) return true;
        return false;
      }
      function descriptor(el){
        if(!el) return 'unknown element';
        var parts=[el.tagName.toLowerCase()];
        var role=el.getAttribute('role');
        var name=el.getAttribute('name');
        var placeholder=el.getAttribute('placeholder');
        var aria=el.getAttribute('aria-label');
        if(role) parts.push('[role='+role+']');
        if(name) parts.push('[name='+name+']');
        if(placeholder) parts.push('(placeholder='+placeholder+')');
        if(aria) parts.push('(aria='+aria+')');
        if(el.isContentEditable) parts.push('[contenteditable=true]');
        return parts.join('');
      }
      var e=null;
      if(s){
        e=document.querySelector(s);
        if(!e)return'Error: No match "'+s+'"';
        if(!isEditable(e)) return 'Error: Target is not an editable field: '+descriptor(e);
      }else{
        e=document.activeElement;
        if(!isEditable(e)) return 'Error: No focused editable field. Click the exact title/body input before typing.';
      }
      e.focus();

      // Resolve the actual editable element — for Web Components and wrapper
      // elements, drill into shadowRoot or child to find the real input.
      var actualTarget=e;
      if(!e.isContentEditable && e.tagName!=='INPUT' && e.tagName!=='TEXTAREA'){
        // Check shadowRoot first (Web Components like Reddit's faceplate-textarea-input)
        if(e.shadowRoot){
          var inner=e.shadowRoot.querySelector('textarea,input:not([type=hidden]),[contenteditable="true"],[role=textbox]');
          if(inner){actualTarget=inner;actualTarget.focus();}
        }
        // Then check light DOM children
        if(actualTarget===e){
          var child=e.querySelector('textarea,input:not([type=hidden]),[contenteditable="true"],[role=textbox]');
          if(child){actualTarget=child;actualTarget.focus();}
        }
      }
      e=actualTarget;

      // Clear existing content
      if(e.isContentEditable){
        // For rich text editors (Lexical, ProseMirror, etc.), select all + delete
        // via execCommand instead of direct DOM mutation
        e.focus();
        document.execCommand('selectAll',false,null);
        document.execCommand('delete',false,null);
      }else{
        // Use native setter for React/Vue compatibility when clearing
        var setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set||
                   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set||
                   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        if(setter) setter.call(e,''); else e.value='';
        e.dispatchEvent(new InputEvent('input',{bubbles:true,data:null,inputType:'deleteContent'}));
      }

      // Type text — for contenteditable, use execCommand('insertText') which
      // works with rich text frameworks (Lexical, ProseMirror, Slate, etc.).
      // For native inputs, use char-by-char keyboard event simulation.
      if(e.isContentEditable){
        // execCommand approach — frameworks hook into this properly
        document.execCommand('insertText',false,t);
      }else{
        // Char-by-char for native inputs with full keyboard event sequence
        for(var i=0;i<t.length;i++){
          var ch=t[i];
          var code=ch.charCodeAt(0);
          var keyCode=code;
          var kbProps={bubbles:true,cancelable:true,key:ch,code:'Key'+ch.toUpperCase(),keyCode:keyCode,which:keyCode,charCode:code};

          // keydown
          e.dispatchEvent(new KeyboardEvent('keydown',kbProps));

          // beforeinput (cancelable — some fields use it to reject chars)
          var bi=new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:ch});
          var allowed=e.dispatchEvent(bi);
          if(!allowed) continue; // field rejected this character

          // Append character
          var curVal=e.value||'';
          if(setter) setter.call(e,curVal+ch); else e.value=curVal+ch;

          // input (not cancelable)
          e.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));

          // keyup
          e.dispatchEvent(new KeyboardEvent('keyup',kbProps));
        }
      }

      // Final change event (normally fires on blur, but we fire early for form libs)
      e.dispatchEvent(new Event('change',{bubbles:true}));

      // Verify the text actually stuck
      var finalValue=e.isContentEditable ? (e.textContent||'').trim() : (e.value||'');
      var desc=descriptor(e);

      if(finalValue!==t){
        // Check if it's a partial match (some chars were filtered)
        if(finalValue.length>0 && t.startsWith(finalValue)){
          return 'Partial type into '+desc+': got "'+finalValue.slice(0,60)+'" (expected '+t.length+' chars, got '+finalValue.length+')';
        }
        return 'Warning: Type mismatch on '+desc+': expected "'+t.slice(0,40)+'" but field contains "'+finalValue.slice(0,40)+'"';
      }

      // Check for nearby validation errors
      var form=e.closest('form');
      var errEl=form?form.querySelector('[role=alert],.error,[class*=error],[class*=invalid]'):null;
      var errText=errEl?(errEl.textContent||'').trim().slice(0,80):'';
      if(errText) return 'Typed into '+desc+' | \u26a0 Validation: '+errText;

      return 'Typed into '+desc;
    })()`);
    await waitForDomSettled(view, { timeoutMs: 1_500, settleMs: 120 });
    recordLastAction(target, 'type', result, !String(result).startsWith('Error:') && !String(result).startsWith('Warning:'));
    return result;
  } catch (err: any) { return '[Error typing]: ' + err.message; }
}

export async function scrollPage(direction: 'down' | 'up' | 'top' | 'bottom', amount?: number, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  try {
    // Scroll and return position info + viewport-visible text.
    // Handles both document-level scrolling AND scrollable container divs
    // (Gmail, Twitter, SPAs use overflow containers instead of document scroll).
    const result = await view.webContents.executeJavaScript(`(function(){
      var dir = ${JSON.stringify(direction)};
      var amt = ${amount || 0};

      // Find the actual scrollable element: document OR a scrollable container
      function findScrollable() {
        // Check if document itself scrolls
        if (document.documentElement.scrollHeight > window.innerHeight + 10) {
          return { el: null, isDoc: true }; // null = use window
        }
        // Look for a scrollable container div
        var candidates = document.querySelectorAll('div, main, section, [role="main"]');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var style = getComputedStyle(el);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
            return { el: el, isDoc: false };
          }
        }
        return { el: null, isDoc: true }; // fallback to document
      }

      var target = findScrollable();
      var scrollEl = target.el;

      // Get current position
      var before = target.isDoc ? window.scrollY : scrollEl.scrollTop;
      var maxScroll = target.isDoc
        ? document.documentElement.scrollHeight - window.innerHeight
        : scrollEl.scrollHeight - scrollEl.clientHeight;
      var viewH = target.isDoc ? window.innerHeight : scrollEl.clientHeight;
      var step = amt || Math.round(viewH * 0.8);

      // Execute scroll
      if (dir === 'top') {
        target.isDoc ? window.scrollTo(0, 0) : (scrollEl.scrollTop = 0);
      } else if (dir === 'bottom') {
        target.isDoc ? window.scrollTo(0, maxScroll) : (scrollEl.scrollTop = maxScroll);
      } else if (dir === 'up') {
        target.isDoc ? window.scrollBy(0, -step) : (scrollEl.scrollTop -= step);
      } else {
        target.isDoc ? window.scrollBy(0, step) : (scrollEl.scrollTop += step);
      }

      var after = target.isDoc ? window.scrollY : scrollEl.scrollTop;
      var pct = maxScroll > 0 ? Math.round((after / maxScroll) * 100) : 100;
      var atBottom = (maxScroll - after) < 10;
      var atTop = after < 10;

      // Extract text that's currently VISIBLE in the viewport, not the full DOM.
      // This gives the LLM new content it hasn't seen yet.
      function getViewportText() {
        var viewTop = target.isDoc ? window.scrollY : scrollEl.getBoundingClientRect().top;
        var viewBot = viewTop + viewH;
        var texts = [];
        var walker = document.createTreeWalker(target.isDoc ? document.body : scrollEl, NodeFilter.SHOW_TEXT, null);
        var node;
        while (node = walker.nextNode()) {
          var range = document.createRange();
          range.selectNode(node);
          var rect = range.getBoundingClientRect();
          // Include text nodes whose bounding rect overlaps the viewport
          if (rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0) {
            var t = node.textContent.trim();
            if (t.length > 0) texts.push(t);
          }
        }
        return texts.join('\\n').slice(0, 12000);
      }

      var vpText = getViewportText();

      return JSON.stringify({
        scrollY: Math.round(after),
        maxScroll: Math.round(maxScroll),
        percent: pct,
        atTop: atTop,
        atBottom: atBottom,
        moved: Math.round(after - before),
        scrollTarget: target.isDoc ? 'document' : (scrollEl.tagName + '.' + (scrollEl.className || '').split(' ')[0]),
        viewportText: vpText
      });
    })()`);
    const info = JSON.parse(result);

    let status: string;
    if (info.moved === 0) {
      status = info.atBottom ? 'Already at bottom of page' : info.atTop ? 'Already at top of page' : 'Scroll position unchanged';
    } else {
      status = `Scrolled ${direction} (${Math.abs(info.moved)}px)`;
    }

    const posInfo = `Position: ${info.percent}% (${info.scrollY}/${info.maxScroll}px)${info.atBottom ? ' [END OF PAGE]' : ''}${info.atTop ? ' [TOP OF PAGE]' : ''}`;
    const scrollTarget = info.scrollTarget !== 'document' ? ` [scrolled: ${info.scrollTarget}]` : '';

    const output = `${status} | ${posInfo}${scrollTarget}\n\n${info.viewportText}`;
    recordLastAction(target, 'scroll', status, true);
    return output;
  } catch (err: any) { return '[Error scrolling]: ' + err.message; }
}

export async function extractData(instruction: string, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  if (isCommerceInstruction(instruction)) {
    const kind = pickExtractionKind(instruction);
    const result = await view.webContents.executeJavaScript(buildCommerceExtractionScript(kind));
    recordExtraction(target, result.kind, result.data);
    recordLastAction(target, 'extract', summarizeExtraction(result.kind, result.data), true);
    return JSON.stringify(result, null, 2);
  }

  try {
    const result = await view.webContents.executeJavaScript(`(function(){
      var instruction = ${JSON.stringify(instruction)}.toLowerCase();
      var out = [];
      if (instruction.match(/table|row|column|header|cell|grid/)) {
        document.querySelectorAll('table').forEach(function(table, ti) {
          if (ti >= 3) return;
          var rows = [];
          table.querySelectorAll('tr').forEach(function(tr, ri) {
            if (ri >= 50) return;
            var cells = [];
            tr.querySelectorAll('th, td').forEach(function(td) {
              cells.push(td.textContent.trim().replace(/\\s+/g, ' ').slice(0, 100));
            });
            if (cells.length > 0) rows.push(cells.join(' | '));
          });
          if (rows.length > 0) out.push('Table ' + (ti + 1) + ':\\n' + rows.join('\\n'));
        });
      }
      if (instruction.match(/list|items|bullet|options|menu/)) {
        document.querySelectorAll('ul, ol, [role=list], [role=listbox]').forEach(function(list, li) {
          if (li >= 5 || out.length >= 3) return;
          var items = [];
          list.querySelectorAll('li, [role=option], [role=listitem]').forEach(function(item, ii) {
            if (ii >= 30) return;
            var t = item.textContent.trim().replace(/\\s+/g, ' ').slice(0, 150);
            if (t) items.push('- ' + t);
          });
          if (items.length > 0) out.push('List:\\n' + items.join('\\n'));
        });
      }
      if (instruction.match(/price|cost|\\$|amount|total|fee/)) {
        document.querySelectorAll('[class*=price], [class*=cost], [class*=amount], [data-price]').forEach(function(el, i) {
          if (i >= 20) return;
          var t = el.textContent.trim();
          if (t && t.match(/[\\$\\d]/)) out.push(t.slice(0, 100));
        });
      }
      if (instruction.match(/link|url|href|navigation|nav/)) {
        document.querySelectorAll('a[href]').forEach(function(a, i) {
          if (i >= 30) return;
          var t = (a.textContent||'').trim().slice(0,80);
          var h = a.getAttribute('href')||'';
          if (t && h && !h.startsWith('#') && !h.startsWith('javascript:')) out.push(t + ' → ' + h.slice(0, 100));
        });
      }
      if (instruction.match(/form|field|input|label|submit/)) {
        document.querySelectorAll('input, textarea, select').forEach(function(el, i) {
          if (i >= 20) return;
          var t = el.tagName.toLowerCase();
          var ty = el.getAttribute('type') || '';
          var nm = el.getAttribute('name') || '';
          var p = el.getAttribute('placeholder') || '';
          out.push(t + (ty ? '['+ty+']' : '') + (nm ? ' name='+nm : '') + (p ? ' ('+p+')' : ''));
        });
      }
      if (instruction.match(/heading|title|section|structure|outline/)) {
        document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h, i) {
          if (i >= 20) return;
          var t = h.textContent.trim().slice(0, 120);
          if (t) out.push(h.tagName + ': ' + t);
        });
      }
      if (out.length === 0) {
        var main = document.querySelector('main, [role=main], article');
        return ((main || document.body).innerText || '').trim().slice(0, 8000);
      }
      return out.join('\\n\\n').slice(0, 10000);
    })()`);
    const envelope: StructuredExtractionEnvelope<any> = {
      kind: 'generic',
      pageType: 'unknown',
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      data: result,
    };
    recordExtraction(target, envelope.kind, result);
    recordLastAction(target, 'extract', summarizeExtraction(envelope.kind, result), true);
    return JSON.stringify(envelope, null, 2);
  } catch {
    const text = await getVisibleText(target);
    recordExtraction(target, 'generic', text);
    recordLastAction(target, 'extract', 'generic: fallback to visible text', true);
    return JSON.stringify({
      kind: 'generic',
      pageType: 'unknown',
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      data: text,
    }, null, 2);
  }
}

async function runStructuredExtraction<T = any>(
  kind: 'listings' | 'product_details' | 'reviews_summary',
  target?: BrowserTarget,
): Promise<StructuredExtractionEnvelope<T>> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  const result = await view.webContents.executeJavaScript(buildCommerceExtractionScript(kind));
  recordExtraction(target, result.kind, result.data);
  recordLastAction(target, 'extract', summarizeExtraction(result.kind, result.data), true);
  return result;
}

export async function extractListings(target?: BrowserTarget): Promise<StructuredExtractionEnvelope<any>> {
  return await runStructuredExtraction('listings', target);
}

export async function extractProductDetails(target?: BrowserTarget): Promise<StructuredExtractionEnvelope<any>> {
  return await runStructuredExtraction('product_details', target);
}

export async function extractReviewsSummary(target?: BrowserTarget): Promise<StructuredExtractionEnvelope<any>> {
  return await runStructuredExtraction('reviews_summary', target);
}

export async function takeScreenshot(target?: BrowserTarget): Promise<{ base64: string; width: number; height: number; sizeKb: number }> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active browser tab');

  // capturePage() returns a 0×0 image when the BrowserView has zero bounds
  // (headless mode or hidden). Temporarily assign real bounds so the
  // Chromium compositor has a surface to rasterize, then restore.
  const bounds = view.getBounds();
  const needsTempBounds = bounds.width === 0 || bounds.height === 0;

  if (needsTempBounds) {
    view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
    await waitForDomSettled(view, { timeoutMs: 500, settleMs: 120 });
  }

  try {
    const img = await view.webContents.capturePage();
    const s = img.getSize();
    if (s.width === 0 || s.height === 0) {
      throw new Error('Screenshot captured 0×0 image — browser view may not be ready');
    }
    const base64 = img.toPNG().toString('base64');
    return { base64, width: s.width, height: s.height, sizeKb: Math.round(base64.length / 1024) };
  } finally {
    // Restore zero bounds if we were in headless/hidden mode
    if (needsTempBounds) {
      if (executionMode === 'headless') {
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } else {
        // Headed but momentarily hidden — restore whatever was there
        view.setBounds(bounds);
      }
    }
  }
}

export async function search(query: string, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  try {
    await view.webContents.loadURL(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
    await waitForLoad(view, { timeoutMs: 12_000, settleMs: 200 });
    const results = await view.webContents.executeJavaScript(`(function(){
      var r=[];
      // Try multiple Google result container selectors — Google frequently changes DOM structure.
      // Priority order: classic div.g, newer data-* containers, any block with an h3 + external link.
      var containers = Array.from(document.querySelectorAll('div.g, div[data-sokoban-container], div[data-hveid], .tF2Cxc, .N54PNb'));
      // Deduplicate by URL
      var seen = new Set();
      containers.forEach(function(c) {
        if (r.length >= 6) return;
        var a = c.querySelector('a[href^="http"], a[href^="https"]') || c.querySelector('a[href]');
        var h = c.querySelector('h3');
        var s = c.querySelector('[data-sncf], .VwiC3b, .lEBKkf, [style*="-webkit-line-clamp"], span[style]');
        if (!a || !h) return;
        var u = a.href || a.getAttribute('href') || '';
        if (!u || u.startsWith('https://www.google') || seen.has(u)) return;
        seen.add(u);
        r.push({title:h.textContent.trim(), url:u.trim(), snippet:s?s.textContent.trim().slice(0,250):''});
      });
      // Fallback: scan all external links with meaningful anchor text
      if (r.length === 0) {
        var seen2 = new Set();
        document.querySelectorAll('a[href^="http"]').forEach(function(a) {
          if (r.length >= 6) return;
          var t = (a.textContent||'').trim().replace(/\\s+/g,' ');
          var u = a.href;
          if (t.length > 10 && t.length < 200 && !u.includes('google.') && !seen2.has(u)) {
            seen2.add(u);
            r.push({title:t.slice(0,120), url:u, snippet:''});
          }
        });
      }
      return JSON.stringify(r);
    })()`);
    const parsed = JSON.parse(results || '[]');
    if (parsed.length === 0) return `Search for "${query}":\n\n` + (await getVisibleText(target)).slice(0, 4000);
    return `Search results for "${query}":\n\n` + parsed.map((r: any, i: number) => `[${i+1}] ${r.title}\n    ${r.url}${r.snippet ? '\n    ' + r.snippet : ''}`).join('\n\n');
  } catch (err: any) { return '[Error searching]: ' + err.message; }
}

import { executeHarness as _executeHarness, findHarnessByUrl, saveHarness, getHarnessesForDomain, getHarnessContextForUrl } from './site-harness';
import type { SiteHarness, HarnessExecResult } from './site-harness';

/**
 * Fill a single form field using native browser input events.
 * This is the primary form-filling primitive — replaces the old JS-based typeText
 * for cases where reliability matters (React, Web Components, rich text editors).
 */
export async function fillField(selector: string, text: string, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  const found = await waitForSelector(view, selector, { timeoutMs: 5_000 });
  if (!found) return `✗ Selector "${selector}" did not become available (5000ms)`;
  const result = await fillFieldWithInputEvents(view, selector, text);
  if (result.success) {
    const output = `✓ ${result.message} (${result.elapsedMs}ms)`;
    recordLastAction(target, 'fill_field', output, true);
    return output;
  }
  const output = `✗ ${result.message} (${result.elapsedMs}ms)`;
  recordLastAction(target, 'fill_field', output, false);
  return output;
}

/**
 * Execute a stored site harness — deterministic native-input form fill, zero LLM cost.
 */
export async function runHarness(domain: string, actionName: string, fieldValues: Record<string, string>, autoSubmit: boolean = false, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');

  // Find the harness
  const harnesses = getHarnessesForDomain(domain);
  const harness = harnesses.find(h => h.actionName === actionName);
  if (!harness) {
    return `[Error] No harness found for ${domain}/${actionName}. Available: ${harnesses.map(h => h.actionName).join(', ') || 'none'}`;
  }

  // Check which fields are missing
  const missingRequired = harness.fields
    .filter(f => f.required && !(f.name in fieldValues))
    .map(f => f.name);
  if (missingRequired.length > 0) {
    return `[Error] Missing required fields: ${missingRequired.join(', ')}. Harness "${actionName}" needs: ${harness.fields.map(f => f.name + (f.required ? '*' : '')).join(', ')}`;
  }

  const result = await _executeHarness(view, harness, fieldValues, autoSubmit);

  const fieldSummary = result.fieldResults.map(f =>
    `  ${f.success ? '✓' : '✗'} ${f.name}: ${f.message}`
  ).join('\n');

  return `${result.success ? '✓' : '✗'} Harness "${actionName}" on ${domain} (${result.elapsedMs}ms):\n${fieldSummary}\n${result.message}`;
}

/**
 * Register a new site harness from a successful form interaction.
 * Called by the LLM after it successfully fills a form for the first time.
 */
export async function registerHarness(harnessJson: string): Promise<string> {
  try {
    const harness: SiteHarness = JSON.parse(harnessJson);
    // Validate required fields
    if (!harness.domain || !harness.actionName || !harness.urlPattern || !harness.fields?.length) {
      return '[Error] Harness must have domain, actionName, urlPattern, and at least one field';
    }
    // Validate each field has selector and name
    for (const f of harness.fields) {
      if (!f.name || !f.selector) return `[Error] Field missing name or selector: ${JSON.stringify(f)}`;
      if (!f.fieldType) f.fieldType = 'input'; // default
      if (f.required === undefined) f.required = true; // default
    }
    if (!harness.submit?.selector) {
      return '[Error] Harness must have a submit.selector';
    }
    harness.successCount = 0;
    harness.failCount = 0;
    harness.createdAt = new Date().toISOString();
    harness.lastUsed = new Date().toISOString();

    const id = saveHarness(harness);
    return `✓ Registered harness "${harness.actionName}" for ${harness.domain} (id: ${id}, ${harness.fields.length} fields)`;
  } catch (err: any) {
    return `[Error] Invalid harness JSON: ${err.message}`;
  }
}

/** Re-export for prompt injection */
export { getHarnessContextForUrl };

// ═══════════════════════════════════
// Legacy form-aware tools (kept for backward compat, but browser_fill_field is preferred)
// ═══════════════════════════════════

export async function focusField(selector: string, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  try {
    return await view.webContents.executeJavaScript(`(function(){
      var selector=${JSON.stringify(selector)};
      var el=document.querySelector(selector);
      if(!el) return 'Error: No element matching '+selector;

      // Scroll into view so element is visible and clickable
      el.scrollIntoView({behavior:'instant',block:'center'});

      // For Web Components, try to drill into shadowRoot to find the real input
      var target=el;
      if(el.shadowRoot){
        var inner=el.shadowRoot.querySelector('textarea,input:not([type=hidden]),[contenteditable="true"],[role=textbox]');
        if(inner) target=inner;
      }
      // Also check light DOM children for wrapper elements
      if(target===el && !el.isContentEditable && el.tagName!=='INPUT' && el.tagName!=='TEXTAREA'){
        var child=el.querySelector('textarea,input:not([type=hidden]),[contenteditable="true"],[role=textbox]');
        if(child) target=child;
      }

      // Focus the resolved target
      if(typeof target.focus==='function') target.focus();
      // Also click it — some Web Components need a click to activate
      if(typeof target.click==='function') target.click();

      // If contenteditable, place cursor at end
      if(target.isContentEditable){
        var range=document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        var sel=window.getSelection();
        if(sel){sel.removeAllRanges();sel.addRange(range);}
      }

      // Verify focus succeeded — relaxed check: activeElement can be the
      // target, its parent, or a shadow host (all valid for Web Components)
      var active=document.activeElement;
      var focusOk=(active===target || active===el || (target.contains && target.contains(active)) || (el.contains && el.contains(active)));
      // Also accept if activeElement is inside the element (shadow DOM case)
      if(!focusOk && active && el.contains && el.contains(active)) focusOk=true;

      // Build descriptor
      var parts=[el.tagName.toLowerCase()];
      var role=el.getAttribute('role');
      var name=el.getAttribute('name');
      var placeholder=el.getAttribute('placeholder');
      var aria=el.getAttribute('aria-label');
      if(role) parts.push('[role='+role+']');
      if(name) parts.push('[name='+name+']');
      if(placeholder) parts.push('(placeholder='+placeholder+')');
      if(aria) parts.push('(aria='+aria+')');
      if(el.isContentEditable) parts.push('[contenteditable=true]');
      var desc=parts.join('');

      if(!focusOk){
        return 'Warning: Focus uncertain on '+desc+'. Active: '+(active?.tagName?.toLowerCase()||'unknown')+'. Try browser_click on this element instead.';
      }
      return 'Focused '+desc;
    })()`);
  } catch (err: any) { return '[Error focusing]: ' + err.message; }
}

export async function detectForm(instruction: string, target?: BrowserTarget): Promise<string> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  try {
    return await view.webContents.executeJavaScript(`(function(){
      var instruction=${JSON.stringify(instruction)}.toLowerCase();
      var results=[];

      // Check explicit <form> elements
      var forms=document.querySelectorAll('form');
      forms.forEach(function(form,fi){
        if(fi>=10) return;
        var id=form.id||'';
        var name=form.name||'';
        var action=form.action||'';
        var method=(form.method||'GET').toUpperCase();

        var fields=[];
        form.querySelectorAll('input,textarea,select').forEach(function(f,i){
          if(i>=20) return;
          var r=f.getBoundingClientRect();
          if(r.width===0||r.height===0) return; // skip hidden
          var ty=f.getAttribute('type')||'text';
          if(['hidden','submit','button'].includes(ty.toLowerCase())) return;
          var nm=f.getAttribute('name')||'';
          var fid=f.id||'';
          var p=f.getAttribute('placeholder')||'';
          var ar=f.getAttribute('aria-label')||'';
          var lab='';
          if(fid){var lbl=document.querySelector('label[for="'+fid+'"]');if(lbl)lab=(lbl.textContent||'').trim();}
          // Build a stable CSS selector for this field
          var sel='';
          if(fid) sel='#'+fid;
          else if(nm) sel=f.tagName.toLowerCase()+'[name="'+nm+'"]';
          else if(ar) sel='[aria-label="'+ar+'"]';
          else if(p) sel='[placeholder="'+p+'"]';
          else sel=f.tagName.toLowerCase()+(ty?'[type='+ty+']':'');
          fields.push({type:ty,name:nm,id:fid,placeholder:p,ariaLabel:ar,label:lab,selector:sel});
        });

        if(fields.length===0) return;

        var submitBtn=form.querySelector('button[type=submit],input[type=submit],button:not([type])');
        var submitText=submitBtn?(submitBtn.textContent||'').trim().slice(0,40):'';
        var submitSel='';
        if(submitBtn){
          if(submitBtn.id) submitSel='#'+submitBtn.id;
          else if(submitBtn.getAttribute('name')) submitSel='[name="'+submitBtn.getAttribute('name')+'"]';
          else submitSel=submitBtn.tagName.toLowerCase()+'[type=submit]';
        }

        var fieldNames=fields.map(function(f){return f.name||f.label||f.placeholder||f.ariaLabel}).filter(Boolean).join(', ');
        var sig='Form('+(id?'id='+id:name?'name='+name:'unnamed')+'): ['+fieldNames+']';

        // Score relevance to instruction
        var haystack=(id+' '+name+' '+fieldNames+' '+submitText+' '+action).toLowerCase();
        var relevance=0;
        if(haystack.includes(instruction)) relevance+=100;
        instruction.split(/\\s+/).forEach(function(w){if(w.length>2&&haystack.includes(w))relevance+=30;});
        if(relevance===0) relevance=1; // still return it, just low priority

        results.push({signature:sig,action:action,method:method,fields:fields,submitText:submitText,submitSelector:submitSel,relevance:relevance});
      });

      // Also detect formless input groups (common in SPAs)
      // Extended selector catches Web Components with name attributes (Reddit, GitHub, etc.)
      if(results.length===0){
        var loose=[];
        // Cast a wide net: any element with a name attribute OR known editable roles.
        // This catches custom elements like <faceplate-textarea-input name="title">.
        var seen=new Set();
        document.querySelectorAll('input,textarea,select,[role=textbox],[contenteditable=true]').forEach(function(f){seen.add(f);});
        // Also find ANY element with a name attr that looks like a form field
        document.querySelectorAll('[name]').forEach(function(f){
          if(seen.has(f)) return;
          var tag=f.tagName.toLowerCase();
          // Skip structural/meta elements
          if(['form','meta','iframe','script','style','link','html','body','head','slot','template'].includes(tag)) return;
          // Skip if it has no visible size
          var r=f.getBoundingClientRect();
          if(r.width<10||r.height<10) return;
          seen.add(f);
        });
        var looseCount=0;
        seen.forEach(function(f){
          if(looseCount>=20) return;
          var r=f.getBoundingClientRect();
          if(r.width===0||r.height===0) return;
          var tag=f.tagName.toLowerCase();
          var ty=f.getAttribute('type')||'';
          // For standard inputs, skip non-editable types
          if((tag==='input')&&['hidden','submit','button'].includes(ty.toLowerCase())) return;
          var nm=f.getAttribute('name')||'';
          var fid=f.id||'';
          var p=f.getAttribute('placeholder')||'';
          var ar=f.getAttribute('aria-label')||'';
          var lab='';
          if(fid){var lbl=document.querySelector('label[for="'+fid+'"]');if(lbl)lab=(lbl.textContent||'').trim();}
          // Build selector — use actual tag name (works for custom elements)
          var sel='';
          if(fid) sel='#'+fid;
          else if(nm) sel=tag+'[name="'+nm+'"]';
          else if(ar) sel=tag+'[aria-label="'+ar+'"]';
          else if(p) sel=tag+'[placeholder="'+p+'"]';
          else sel=tag+(ty?'[type='+ty+']':'');
          // Determine field type
          var fieldType=ty||'text';
          if(f.isContentEditable||f.getAttribute('role')==='textbox') fieldType='contenteditable';
          else if(tag!=='input'&&tag!=='textarea'&&tag!=='select') fieldType='web-component';
          loose.push({type:fieldType,name:nm,id:fid,placeholder:p,ariaLabel:ar,label:lab,selector:sel,tag:tag});
          looseCount++;
        });
        if(loose.length>0){
          results.push({signature:'Formless inputs ('+loose.length+' fields)',action:'',method:'',fields:loose,submitText:'',submitSelector:'',relevance:1});
        }
      }

      results.sort(function(a,b){return b.relevance-a.relevance;});
      if(results.length===0) return 'No forms found on page';
      return JSON.stringify(results,null,2);
    })()`);
  } catch (err: any) { return '[Error detecting form]: ' + err.message; }
}

export function closeBrowser(): void {
  for (const [, tab] of tabs) {
    if (tab.loadingTimer) clearTimeout(tab.loadingTimer);
    cleanupDebuggerSession(tab.view);
    safeRemoveBrowserView(tab.view);
    (tab.view.webContents as any)?.destroy?.();
  }
  tabs.clear(); isolatedTabsByRunId.clear(); activeTabId = null; pageStateByTabId.clear();
  mainWindow = null;
}

export async function evaluateScript(
  expression: string,
  options: BrowserEvalOptions = {},
  target?: BrowserTarget,
): Promise<Record<string, any>> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 5_000, 15_000));
  const maxResultChars = Math.max(200, Math.min(options.maxResultChars ?? 6_000, 20_000));
  const url = view.webContents.getURL();

  try {
    const result = await evaluateDebuggerExpression<any>(view, expression, {
      timeoutMs,
      returnByValue: true,
      awaitPromise: options.awaitPromise !== false,
      userGesture: true,
      frameId: target?.frameId,
    });

    if (result.exceptionDetails) {
      const envelope = buildEvalErrorEnvelope(url, normalizeEvalException(result.exceptionDetails));
      recordLastAction(target, 'eval', envelope.error?.message || 'Evaluation failed', false);
      return envelope;
    }

    const envelope = buildEvalSuccessEnvelope(url, result, maxResultChars);
    recordLastAction(target, 'eval', `Evaluation returned type=${envelope.type}`, envelope.ok);
    return envelope;
  } catch (error: any) {
    const envelope = normalizeThrownEvalError(url, error);
    recordLastAction(target, 'eval', envelope.error?.message || 'Evaluation failed', false);
    return envelope;
  }
}

export async function getDomSnapshot(target?: BrowserTarget): Promise<DomSnapshotResult> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  return await buildDomSnapshot(view, { frameId: target?.frameId });
}

export async function getPageState(target?: BrowserTarget): Promise<BrowserPageStateSnapshot> {
  const tab = resolveTab(target);
  const view = getActiveView(target);
  if (!tab || !view) throw new Error('No active tab');
  const snapshot = await buildDomSnapshot(view, { frameId: target?.frameId });
  const state = getOrCreatePageState(tab.id);
  return buildPageStateSnapshot({
    snapshot,
    extractedEntities: state.extractedEntities,
    recentExtractionResults: state.recentExtractionResults,
    lastActionResult: state.lastActionResult,
    recentNetworkActivity: getRecentNetworkActivity(view, 10),
    version: state.version,
    updatedAt: state.updatedAt,
  });
}

export async function watchNetwork(
  action: 'start' | 'stop' | 'read',
  options: { limit?: number } = {},
  target?: BrowserTarget,
): Promise<Record<string, any>> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  const limit = Math.max(10, Math.min(options.limit ?? 50, 500));

  if (action === 'start') {
    await startNetworkWatch(view, limit);
    return { status: 'watching', limit, tabId: resolveTab(target)?.id || null };
  }
  if (action === 'stop') {
    const entries = getRecentNetworkActivity(view, limit);
    await stopNetworkWatch(view);
    return { status: 'stopped', count: entries.length, entries };
  }
  const entries = getRecentNetworkActivity(view, limit);
  return { status: 'watching', count: entries.length, entries };
}

export async function waitForBrowser(
  kind: 'selector' | 'text' | 'url' | 'ready',
  input: { selector?: string; text?: string; url?: string; match?: 'includes' | 'equals' | 'regex'; timeoutMs?: number; settleMs?: number } = {},
  target?: BrowserTarget,
): Promise<Record<string, any>> {
  const view = getActiveView(target);
  if (!view) throw new Error('No active tab');
  const timeoutMs = input.timeoutMs ?? 5_000;

  if (kind === 'selector') {
    const ok = await waitForSelector(view, input.selector || '', { timeoutMs, settleMs: input.settleMs });
    return { ok, waitedFor: 'selector', selector: input.selector || '', timeoutMs };
  }
  if (kind === 'text') {
    const ok = await waitForText(view, input.text || '', { timeoutMs, settleMs: input.settleMs });
    return { ok, waitedFor: 'text', text: input.text || '', timeoutMs };
  }
  if (kind === 'url') {
    const ok = await waitForUrlMatch(view, input.url || '', { timeoutMs, settleMs: input.settleMs, match: input.match });
    return { ok, waitedFor: 'url', url: input.url || '', match: input.match || 'includes', timeoutMs };
  }
  await waitForPageReady(view, { timeoutMs, settleMs: input.settleMs });
  return { ok: true, waitedFor: 'ready', timeoutMs };
}

export async function executeBrowserBatch(
  steps: BrowserBatchStep[],
  target?: BrowserTarget,
): Promise<BrowserBatchResult> {
  return await executeBrowserBatchSteps(steps, {
    navigate: async (input) => await navigate(String(input?.url || ''), target),
    click: async (input) => await clickElement(String(input?.target || ''), target),
    type: async (input) => await typeText(String(input?.text || ''), typeof input?.selector === 'string' ? input.selector : undefined, target),
    extract: async (input) => await extractData(String(input?.instruction || ''), target),
    extractListings: async () => await extractListings(target),
    extractProductDetails: async () => await extractProductDetails(target),
    extractReviewsSummary: async () => await extractReviewsSummary(target),
    readPage: async () => await getVisibleText(target),
    scroll: async (input) => await scrollPage((input?.direction || 'down') as any, input?.amount, target),
    wait: async (input) => await waitForBrowser((input?.kind || 'ready') as any, input || {}, target),
  });
}

export async function compareProducts(
  urls: string[],
  target?: BrowserTarget,
): Promise<ProductComparisonResult> {
  const limited = urls.filter(Boolean).slice(0, 5);
  const products = [];
  for (const url of limited) {
    if (!isLikelyProductUrl(url)) {
      continue;
    }
    await navigate(url, target);
    const extracted = await extractProductDetails(target);
    if (!isValidProductExtraction(extracted)) {
      continue;
    }
    const reviews = await extractReviewsSummary(target).catch(() => null);
    products.push({
      details: extracted.data,
      reviews: reviews?.pageType === 'product' ? reviews.data : undefined,
    });
  }
  if (products.length === 0) {
    throw new Error('No valid product detail pages were available to compare. Provide product URLs, not search/listing URLs.');
  }
  recordExtraction(target, 'comparison', products);
  recordLastAction(target, 'compare_products', `Compared ${products.length} products`, true);
  return buildComparisonResult(products);
}

export function isLikelyProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (/\/dp\/[a-z0-9]{6,}/i.test(path) || /\/gp\/product\/[a-z0-9]{6,}/i.test(path)) return true;
    if (parsed.searchParams.has('k') || parsed.searchParams.has('q') || parsed.searchParams.has('search')) return false;
    return false;
  } catch {
    return false;
  }
}

export function isValidProductExtraction(extracted: StructuredExtractionEnvelope<any>): boolean {
  if (extracted.pageType !== 'product') return false;
  const title = String(extracted.data?.title || extracted.title || '').trim();
  if (!title) return false;
  if (/^page not found$/i.test(title)) return false;
  if (/^\d+-\d+\s+of\s+\d+\s+results/i.test(title)) return false;
  return true;
}

/** Returns webContents for all user-facing (non-agent-isolated) tabs. Used by login interceptor. */
export function getAllUserTabWebContents(): import('electron').WebContents[] {
  return Array.from(tabs.values())
    .filter(t => !t.ownerRunId)
    .map(t => t.view.webContents);
}

let _onNewUserTabCb: ((wc: import('electron').WebContents) => void) | null = null;

/** Register a callback to be called whenever a new user-facing tab is created. */
export function setOnNewUserTabCallback(cb: (wc: import('electron').WebContents) => void): void {
  _onNewUserTabCb = cb;
}

/** Called internally by createTab for non-isolated tabs. */
function _notifyNewUserTab(wc: import('electron').WebContents): void {
  _onNewUserTabCb?.(wc);
}
