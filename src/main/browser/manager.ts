/**
 * Browser Manager — BrowserView-based browser for the right panel.
 * 
 * Uses Electron's BrowserView (stable in 39.5.1) with direct webContents API.
 * No Playwright dependency — all interaction via webContents.executeJavaScript().
 */

import { BrowserView, BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';

let mainWindow: BrowserWindow | null = null;
let browserView: BrowserView | null = null;
let currentBounds = { x: 0, y: 0, width: 0, height: 0 };
let loadingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize the browser. Creates a BrowserView and attaches it to the window.
 */
export function initBrowser(win: BrowserWindow): void {
  mainWindow = win;

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:browser',
    },
  });

  mainWindow.addBrowserView(browserView);
  browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  const wc = browserView.webContents;

  // ── Navigation events → renderer ──

  // Main frame navigation completed — definitively stop loading
  wc.on('did-navigate', (_event, url) => {
    console.log(`[Browser] Navigated: ${url}`);
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, url);
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, wc.getTitle());
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, url);
  });

  wc.on('page-title-updated', (_event, title) => {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, title);
  });

  // Loading state: debounced to avoid flicker from sub-resource loads.
  // did-start-loading fires for EVERY resource (scripts, images, iframes, tracking pixels).
  // We set loading=true immediately on main navigation, but only set loading=false
  // after a 300ms debounce — if another load starts within that window, the spinner stays.
  wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      // Main frame navigation starting — show loading immediately
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
    }
  });

  wc.on('did-finish-load', () => {
    // Main frame finished loading — debounce the stop to avoid flicker
    scheduleLoadingStop();
  });

  wc.on('did-stop-loading', () => {
    // All resources done — schedule loading stop
    scheduleLoadingStop();
  });

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      console.warn(`[Browser] Load failed: ${errorCode} ${errorDescription} — ${validatedURL}`);
      scheduleLoadingStop();
    }
  });

  // Open links in the same view
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: 'deny' };
  });

  // Load Google as the default landing page
  wc.loadURL('https://www.google.com');

  console.log('[Browser] Initialized — loading Google');
}

function scheduleLoadingStop(): void {
  if (loadingTimer) clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    loadingTimer = null;
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
  }, 300);
}

// ═══════════════════════════════════
// Bounds management
// ═══════════════════════════════════

export function setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  currentBounds = bounds;
  if (browserView && bounds.width > 0 && bounds.height > 0) {
    browserView.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
}

export function hideBrowser(): void {
  browserView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

export function showBrowser(): void {
  if (currentBounds.width > 0) setBounds(currentBounds);
}

// ═══════════════════════════════════
// Navigation
// ═══════════════════════════════════

function ensureUrl(url: string): string {
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://') && !u.startsWith('file://')) {
    u = 'https://' + u;
  }
  return u;
}

export async function navigate(url: string): Promise<{ title: string; url: string; content: string }> {
  if (!browserView) throw new Error('Browser not initialized');

  const wc = browserView.webContents;
  const fullUrl = ensureUrl(url);

  try {
    await wc.loadURL(fullUrl);
  } catch (err: any) {
    if (!err.message?.includes('ERR_ABORTED')) {
      console.warn(`[Browser] Navigation error: ${err.message}`);
    }
  }

  await wait(500);

  return {
    title: wc.getTitle(),
    url: wc.getURL(),
    content: await getVisibleText(),
  };
}

export async function goBack(): Promise<void> {
  if (browserView?.webContents.canGoBack()) browserView.webContents.goBack();
}

export async function goForward(): Promise<void> {
  if (browserView?.webContents.canGoForward()) browserView.webContents.goForward();
}

export async function reload(): Promise<void> {
  browserView?.webContents.reload();
}

export function getCurrentUrl(): string {
  return browserView?.webContents.getURL() || '';
}

// ═══════════════════════════════════
// Content extraction
// ═══════════════════════════════════

export async function getVisibleText(): Promise<string> {
  if (!browserView) return '';
  try {
    const text = await browserView.webContents.executeJavaScript(`
      (function() {
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
        return clone.innerText.trim();
      })()
    `);
    return text.length > 15000
      ? text.slice(0, 15000) + '\n\n[Content truncated — page has more text]'
      : text;
  } catch (err: any) {
    console.warn(`[Browser] Text extraction failed: ${err.message}`);
    return '[Failed to extract page text]';
  }
}

export async function getInteractiveElements(): Promise<string> {
  if (!browserView) return '';
  try {
    return await browserView.webContents.executeJavaScript(`
      (function() {
        const elements = [];
        const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [onclick]');
        nodes.forEach((el, i) => {
          if (i >= 50) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 80);
          const href = el.getAttribute('href') || '';
          const type = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          let desc = '[' + elements.length + '] ' + tag;
          if (type) desc += '[type=' + type + ']';
          if (text) desc += ' "' + text + '"';
          if (href) desc += ' → ' + href.slice(0, 60);
          if (placeholder) desc += ' (' + placeholder + ')';
          elements.push(desc);
        });
        return elements.join('\\n');
      })()
    `);
  } catch { return ''; }
}

export async function clickElement(target: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');
  try {
    const result = await browserView.webContents.executeJavaScript(`
      (function() {
        const target = ${JSON.stringify(target)};
        if (/^\\d+$/.test(target)) {
          const idx = parseInt(target);
          const nodes = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [onclick]')).filter(el => {
            const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
          });
          if (idx >= nodes.length) return 'Error: Index ' + idx + ' out of range (' + nodes.length + ' elements)';
          nodes[idx].click();
          return 'Clicked [' + idx + ']: ' + (nodes[idx].textContent || '').trim().slice(0, 60);
        }
        if (target.startsWith('.') || target.startsWith('#') || target.startsWith('[')) {
          const el = document.querySelector(target);
          if (!el) return 'Error: No element matches "' + target + '"';
          el.click();
          return 'Clicked: ' + (el.textContent || '').trim().slice(0, 60);
        }
        for (const el of document.querySelectorAll('a, button, [role="button"], [onclick]')) {
          if ((el.textContent || '').trim().toLowerCase().includes(target.toLowerCase())) {
            el.click();
            return 'Clicked: "' + (el.textContent || '').trim().slice(0, 60) + '"';
          }
        }
        return 'Error: No clickable element matching "' + target + '"';
      })()
    `);
    await wait(800);
    return result;
  } catch (err: any) {
    return '[Error clicking]: ' + err.message;
  }
}

export async function typeText(text: string, selector?: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');
  try {
    return await browserView.webContents.executeJavaScript(`
      (function() {
        const text = ${JSON.stringify(text)};
        const selector = ${JSON.stringify(selector || '')};
        let el;
        if (selector) {
          el = document.querySelector(selector);
          if (!el) return 'Error: No element matches "' + selector + '"';
        } else {
          el = document.activeElement;
          if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
            el = document.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea');
          }
          if (!el) return 'Error: No input field found';
        }
        el.focus();
        if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, text); else el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return 'Typed into ' + el.tagName.toLowerCase() + (el.name ? '[name=' + el.name + ']' : '');
      })()
    `);
  } catch (err: any) {
    return '[Error typing]: ' + err.message;
  }
}

export async function extractData(instruction: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');
  const text = await getVisibleText();
  return `[Extraction — "${instruction}"]\n\n${text}`;
}

export async function takeScreenshot(): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');
  try {
    const image = await browserView.webContents.capturePage();
    const size = image.getSize();
    const base64 = image.toPNG().toString('base64');
    return `[Screenshot: ${size.width}x${size.height}px, ${Math.round(base64.length / 1024)}KB]`;
  } catch (err: any) {
    return '[Error capturing screenshot]: ' + err.message;
  }
}

export async function search(query: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  try {
    await browserView.webContents.loadURL(searchUrl);
    await wait(1500);

    const results = await browserView.webContents.executeJavaScript(`
      (function() {
        const results = [];
        document.querySelectorAll('div.g, div[data-sokoban-container]').forEach((c, i) => {
          if (i >= 5) return;
          const a = c.querySelector('a[href]');
          const h = c.querySelector('h3');
          const s = c.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
          if (!a || !h) return;
          const url = a.getAttribute('href') || '';
          if (url.startsWith('/search') || url.startsWith('/url')) return;
          results.push({ title: h.textContent.trim(), url: url.trim(), snippet: s ? s.textContent.trim().slice(0, 200) : '' });
        });
        if (results.length === 0) {
          document.querySelectorAll('a[href^="http"]').forEach((a, i) => {
            if (i >= 5) return;
            const t = (a.textContent || '').trim();
            if (t.length > 5 && t.length < 200) results.push({ title: t.slice(0, 100), url: a.href, snippet: '' });
          });
        }
        return JSON.stringify(results);
      })()
    `);

    const parsed = JSON.parse(results || '[]');
    if (parsed.length === 0) {
      const text = await getVisibleText();
      return 'Search results for "' + query + '" (raw text):\\n\\n' + text.slice(0, 3000);
    }
    return 'Search results for "' + query + '":\\n\\n' + parsed.map((r: any, i: number) =>
      '[' + (i + 1) + '] ' + r.title + '\\n    ' + r.url + '\\n    ' + r.snippet
    ).join('\\n\\n');
  } catch (err: any) {
    return '[Error searching]: ' + err.message;
  }
}

export function closeBrowser(): void {
  if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
  if (browserView && mainWindow) {
    mainWindow.removeBrowserView(browserView);
    (browserView.webContents as any)?.destroy?.();
    browserView = null;
  }
  console.log('[Browser] Closed');
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
