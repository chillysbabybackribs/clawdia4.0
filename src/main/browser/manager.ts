/**
 * Browser Manager — Multi-tab BrowserView management.
 * 
 * Each tab is a separate BrowserView with its own webContents.
 * Only the active tab is visible (has real bounds). Inactive tabs
 * are hidden at (0,0,0,0). Max 6 tabs to limit memory pressure.
 * 
 * All exported functions (navigate, getVisibleText, etc.) operate
 * on the ACTIVE tab. The agent doesn't need to know about tabs.
 */

import { BrowserView, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { IPC_EVENTS } from '../../shared/ipc-channels';

const MAX_TABS = 6;
const MAX_HISTORY = 200;

interface Tab {
  id: string;
  view: BrowserView;
  url: string;
  title: string;
  isLoading: boolean;
  loadingTimer: ReturnType<typeof setTimeout> | null;
}

let mainWindow: BrowserWindow | null = null;
let tabs: Map<string, Tab> = new Map();
let activeTabId: string | null = null;
let currentBounds = { x: 0, y: 0, width: 0, height: 0 };

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
  createTab('https://www.google.com');
  console.log('[Browser] Initialized with tabs');
}

function getActiveView(): BrowserView | null {
  if (!activeTabId) return null;
  return tabs.get(activeTabId)?.view || null;
}

function emitTabsChanged(): void {
  if (!mainWindow) return;
  mainWindow.webContents.send(IPC_EVENTS.BROWSER_TABS_CHANGED, getTabList());
}

export function getTabList(): { id: string; url: string; title: string; isLoading: boolean; isActive: boolean }[] {
  return Array.from(tabs.values()).map(t => ({
    id: t.id,
    url: t.url,
    title: t.title || 'New Tab',
    isLoading: t.isLoading,
    isActive: t.id === activeTabId,
  }));
}

export function createTab(url?: string): string {
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
      partition: 'persist:browser',
    },
  });

  mainWindow.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  const tab: Tab = { id, view, url: '', title: 'New Tab', isLoading: false, loadingTimer: null };
  tabs.set(id, tab);
  wireTabEvents(tab);
  switchTab(id);

  if (url) view.webContents.loadURL(ensureUrl(url));

  console.log(`[Browser] Created tab ${id} (${tabs.size} total)`);
  emitTabsChanged();
  return id;
}

export function switchTab(id: string): void {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return;

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

  if (tabs.size <= 1) {
    tab.view.webContents.loadURL('https://www.google.com');
    return;
  }

  if (tab.loadingTimer) clearTimeout(tab.loadingTimer);
  mainWindow.removeBrowserView(tab.view);
  (tab.view.webContents as any)?.destroy?.();
  tabs.delete(id);

  if (activeTabId === id) {
    const remaining = Array.from(tabs.keys());
    activeTabId = remaining[remaining.length - 1] || null;
    if (activeTabId) switchTab(activeTabId);
  }

  console.log(`[Browser] Closed tab ${id} (${tabs.size} remaining)`);
  emitTabsChanged();
}

/**
 * Watch an auth/OAuth tab for completion. When the tab navigates to an
 * OAuth callback URL (contains code=, token=, access_token, or returns
 * to the opener's origin), close the auth tab and reload the opener tab
 * so it picks up the new authenticated session.
 */
function watchAuthTab(authTabId: string, openerTabId: string): void {
  const authTab = tabs.get(authTabId);
  if (!authTab) return;

  const onNavigate = (_event: any, url: string) => {
    const isCallback =
      /[?&](code|token|access_token|id_token|state)=/.test(url) ||
      url.includes('/callback') ||
      url.includes('/oauth/callback') ||
      url.includes('/auth/callback');

    if (isCallback) {
      console.log(`[Browser] OAuth callback detected: ${url.slice(0, 120)}`);
      cleanup();

      // Brief delay so the auth tab can finish any final redirects before we close it
      setTimeout(() => {
        // Close auth tab and return to opener
        closeTab(authTabId);
        const openerTab = tabs.get(openerTabId);
        if (openerTab) {
          switchTab(openerTabId);
          // Reload so the opener page sees the new session cookies
          openerTab.view.webContents.reload();
        }
      }, 800);
    }
  };

  const onClose = () => cleanup();

  const cleanup = () => {
    authTab.view.webContents.removeListener('did-navigate', onNavigate);
    authTab.view.webContents.removeListener('did-navigate-in-page', onNavigate);
    authTab.view.webContents.removeListener('destroyed', onClose);
  };

  authTab.view.webContents.on('did-navigate', onNavigate);
  authTab.view.webContents.on('did-navigate-in-page', onNavigate);
  authTab.view.webContents.on('destroyed', onClose);
}

function wireTabEvents(tab: Tab): void {
  const wc = tab.view.webContents;

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
  wc.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame) { console.warn(`[Browser] Tab ${tab.id} load failed: ${errorCode}`); scheduleStop(); }
  });

  wc.setWindowOpenHandler(({ url }) => {
    const isAuthUrl = /accounts\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com|github\.com\/login|auth\.|\/oauth|\/authorize|\/sso|\/saml|\/login\?|\/signin\?/i.test(url);
    if (isAuthUrl) {
      // Open auth URLs in a controlled tab (not a native BrowserWindow — we can't hook those).
      // Watch for OAuth callback navigation and reload the opener tab when complete.
      const openerTabId = activeTabId;
      const authTabId = createTab(url);
      if (openerTabId) watchAuthTab(authTabId, openerTabId);
    } else {
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
  if (view && bounds.width > 0 && bounds.height > 0) {
    view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  }
}

export function hideBrowser(): void { getActiveView()?.setBounds({ x: 0, y: 0, width: 0, height: 0 }); }
export function showBrowser(): void { if (currentBounds.width > 0) setBounds(currentBounds); }

// ═══════════════════════════════════
// Navigation
// ═══════════════════════════════════

function ensureUrl(url: string): string {
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://') && !u.startsWith('file://')) u = 'https://' + u;
  return u;
}

export async function navigate(url: string): Promise<{ title: string; url: string; content: string; elements: string }> {
  const view = getActiveView();
  if (!view) throw new Error('No active tab');
  const wc = view.webContents;
  try { await wc.loadURL(ensureUrl(url)); } catch (err: any) {
    if (!err.message?.includes('ERR_ABORTED')) console.warn(`[Browser] Nav error: ${err.message}`);
  }
  await wait(500);
  // Fetch text + interactive elements in parallel
  const [content, elements] = await Promise.all([getVisibleText(), getInteractiveElements()]);
  return { title: wc.getTitle(), url: wc.getURL(), content, elements };
}

export async function goBack(): Promise<void> { const v = getActiveView(); if (v?.webContents.canGoBack()) v.webContents.goBack(); }
export async function goForward(): Promise<void> { const v = getActiveView(); if (v?.webContents.canGoForward()) v.webContents.goForward(); }
export async function reload(): Promise<void> { getActiveView()?.webContents.reload(); }
export function getCurrentUrl(): string { return getActiveView()?.webContents.getURL() || ''; }

// ═══════════════════════════════════
// Content extraction
// ═══════════════════════════════════

export async function getVisibleText(): Promise<string> {
  const view = getActiveView();
  if (!view) return '';
  try {
    const text = await view.webContents.executeJavaScript(`(function(){const c=document.body.cloneNode(true);c.querySelectorAll('script,style,noscript,svg,iframe').forEach(e=>e.remove());return c.innerText.trim()})()`);
    return text.length > 15000 ? text.slice(0, 15000) + '\n\n[Truncated]' : text;
  } catch (err: any) { return '[Failed to extract text]'; }
}

export async function getInteractiveElements(): Promise<string> {
  const view = getActiveView();
  if (!view) return '';
  try {
    return await view.webContents.executeJavaScript(`(function(){
      var e=[];
      var sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[data-action]';
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
        var d='['+e.length+'] '+t;
        if(rl&&rl!=='button')d+='[role='+rl+']';
        if(ty)d+='[type='+ty+']';
        if(ar)d+=' aria="'+ar.slice(0,60)+'"';
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

export async function clickElement(target: string): Promise<string> {
  const view = getActiveView();
  if (!view) throw new Error('No active tab');
  try {
    const result = await view.webContents.executeJavaScript(`(function(){const t=${JSON.stringify(target)};if(/^\\d+$/.test(t)){const i=parseInt(t),n=Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[onclick]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});if(i>=n.length)return'Error: Index '+i+' out of range ('+n.length+')';n[i].click();return'Clicked ['+i+']: '+(n[i].textContent||'').trim().slice(0,60)}if(t.startsWith('.')||t.startsWith('#')||t.startsWith('[')){const e=document.querySelector(t);if(!e)return'Error: No match "'+t+'"';e.click();return'Clicked: '+(e.textContent||'').trim().slice(0,60)}for(const e of document.querySelectorAll('a,button,[role=button],[onclick]'))if((e.textContent||'').trim().toLowerCase().includes(t.toLowerCase())){e.click();return'Clicked: "'+(e.textContent||'').trim().slice(0,60)+'"'}return'Error: No match "'+t+'"'})()`);
    await wait(800);
    return result;
  } catch (err: any) { return '[Error clicking]: ' + err.message; }
}

export async function typeText(text: string, selector?: string): Promise<string> {
  const view = getActiveView();
  if (!view) throw new Error('No active tab');
  try {
    return await view.webContents.executeJavaScript(`(function(){const t=${JSON.stringify(text)},s=${JSON.stringify(selector||'')};let e;if(s){e=document.querySelector(s);if(!e)return'Error: No match "'+s+'"'}else{e=document.activeElement;if(!e||(e.tagName!=='INPUT'&&e.tagName!=='TEXTAREA'&&!e.isContentEditable))e=document.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea');if(!e)return'Error: No input found'}e.focus();if(e.isContentEditable){e.textContent=t;e.dispatchEvent(new Event('input',{bubbles:true}))}else{const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set||Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(s)s.call(e,t);else e.value=t;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}return'Typed into '+e.tagName.toLowerCase()+(e.name?'[name='+e.name+']':'')})()`);
  } catch (err: any) { return '[Error typing]: ' + err.message; }
}

export async function scrollPage(direction: 'down' | 'up' | 'top' | 'bottom', amount?: number): Promise<string> {
  const view = getActiveView();
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

    return `${status} | ${posInfo}${scrollTarget}\n\n${info.viewportText}`;
  } catch (err: any) { return '[Error scrolling]: ' + err.message; }
}

export async function extractData(instruction: string): Promise<string> {
  const view = getActiveView();
  if (!view) throw new Error('No active tab');

  // Targeted extraction: run JS to extract specific data based on instruction.
  // We analyze common extraction patterns and use DOM queries directly.
  try {
    const result = await view.webContents.executeJavaScript(`(function(){
      var instruction = ${JSON.stringify(instruction)}.toLowerCase();
      var out = [];

      // Table extraction
      if (instruction.match(/table|row|column|header|cell|grid/)) {
        var tables = document.querySelectorAll('table');
        tables.forEach(function(table, ti) {
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
          if (rows.length > 0) out.push('Table ' + (ti+1) + ':\\n' + rows.join('\\n'));
        });
      }

      // List extraction
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

      // Price extraction
      if (instruction.match(/price|cost|\\$|amount|total|fee/)) {
        var priceEls = document.querySelectorAll('[class*=price], [class*=cost], [class*=amount], [data-price]');
        priceEls.forEach(function(el, i) {
          if (i >= 20) return;
          var t = el.textContent.trim();
          if (t && t.match(/[\\$\\d]/)) out.push(t.slice(0, 100));
        });
        // Fallback: regex for price patterns in body text
        if (out.length === 0) {
          var bodyText = document.body.innerText;
          var prices = bodyText.match(/\\$[\\d,.]+/g) || [];
          prices.slice(0, 10).forEach(function(p) { out.push(p); });
        }
      }

      // Link extraction
      if (instruction.match(/link|url|href|navigation|nav/)) {
        document.querySelectorAll('a[href]').forEach(function(a, i) {
          if (i >= 30) return;
          var t = (a.textContent||'').trim().slice(0,80);
          var h = a.getAttribute('href')||'';
          if (t && h && !h.startsWith('#') && !h.startsWith('javascript:')) {
            out.push(t + ' \u2192 ' + h.slice(0, 100));
          }
        });
      }

      // Form field extraction
      if (instruction.match(/form|field|input|label|submit/)) {
        document.querySelectorAll('input, textarea, select').forEach(function(el, i) {
          if (i >= 20) return;
          var t = el.tagName.toLowerCase();
          var ty = el.getAttribute('type') || '';
          var nm = el.getAttribute('name') || '';
          var p = el.getAttribute('placeholder') || '';
          var lab = '';
          var id = el.getAttribute('id');
          if (id) { var lbl = document.querySelector('label[for="'+id+'"]'); if (lbl) lab = lbl.textContent.trim(); }
          var v = (el.value || '').slice(0, 50);
          out.push(t + (ty ? '['+ty+']' : '') + (nm ? ' name='+nm : '') + (lab ? ' label="'+lab+'"' : '') + (p ? ' ('+p+')' : '') + (v ? ' val="'+v+'"' : ''));
        });
      }

      // Heading extraction
      if (instruction.match(/heading|title|section|structure|outline/)) {
        document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h, i) {
          if (i >= 20) return;
          var t = h.textContent.trim().slice(0, 120);
          if (t) out.push(h.tagName + ': ' + t);
        });
      }

      // Image extraction
      if (instruction.match(/image|img|photo|picture|src/)) {
        document.querySelectorAll('img[src]').forEach(function(img, i) {
          if (i >= 15) return;
          var alt = img.getAttribute('alt') || '';
          var src = img.getAttribute('src') || '';
          if (src) out.push((alt ? alt + ' ' : '') + '\u2192 ' + src.slice(0, 120));
        });
      }

      // Generic fallback: if no pattern matched, return focused content area text.
      // Prefer semantic containers over dumping the whole body — avoids nav/footer noise.
      if (out.length === 0) {
        var containers = ['main', '[role=main]', 'article', '#main', '#content', '.content', '.main', '.post', '.article', '.entry', '.body'];
        var best = null;
        for (var ci = 0; ci < containers.length; ci++) {
          best = document.querySelector(containers[ci]);
          if (best && best.textContent.trim().length > 200) break;
          best = null;
        }
        var text = (best || document.body).innerText.trim();
        return text.slice(0, 8000);
      }

      return out.join('\\n\\n').slice(0, 10000);
    })()`);
    return `[Extraction — "${instruction}"]\n\n${result}`;
  } catch (err: any) {
    // Fallback to full text on JS error
    return `[Extraction — "${instruction}"]\n\n${await getVisibleText()}`;
  }
}

export async function takeScreenshot(): Promise<{ base64: string; width: number; height: number; sizeKb: number }> {
  const view = getActiveView();
  if (!view) throw new Error('No active tab');
  const img = await view.webContents.capturePage();
  const s = img.getSize();
  const base64 = img.toPNG().toString('base64');
  return { base64, width: s.width, height: s.height, sizeKb: Math.round(base64.length / 1024) };
}

export async function search(query: string): Promise<string> {
  const view = getActiveView();
  if (!view) throw new Error('No active tab');
  try {
    await view.webContents.loadURL(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
    await wait(1500);
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
    if (parsed.length === 0) return `Search for "${query}":\n\n` + (await getVisibleText()).slice(0, 4000);
    return `Search results for "${query}":\n\n` + parsed.map((r: any, i: number) => `[${i+1}] ${r.title}\n    ${r.url}${r.snippet ? '\n    ' + r.snippet : ''}`).join('\n\n');
  } catch (err: any) { return '[Error searching]: ' + err.message; }
}

export function closeBrowser(): void {
  for (const [, tab] of tabs) {
    if (tab.loadingTimer) clearTimeout(tab.loadingTimer);
    if (mainWindow) mainWindow.removeBrowserView(tab.view);
    (tab.view.webContents as any)?.destroy?.();
  }
  tabs.clear(); activeTabId = null;
}

function wait(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
