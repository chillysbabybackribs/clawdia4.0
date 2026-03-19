/**
 * Browser Manager — WebContentsView-based browser for the right panel.
 * 
 * Uses Electron's BrowserView (stable in 39.5.1) with direct webContents API.
 * No Playwright dependency — all interaction via webContents.executeJavaScript().
 * 
 * The BrowserView is a native Chromium surface positioned over the browser panel
 * area at exact pixel coordinates sent from the renderer via IPC.
 */

import { BrowserView, BrowserWindow, session } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';

let mainWindow: BrowserWindow | null = null;
let browserView: BrowserView | null = null;
let currentBounds = { x: 0, y: 0, width: 0, height: 0 };
let isInitialized = false;

/**
 * Initialize the browser. Creates a BrowserView and attaches it to the window.
 * Call this after the main window is created and ready.
 */
export function initBrowser(win: BrowserWindow): void {
  mainWindow = win;

  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Use a separate session partition so agent browsing doesn't leak into the app
      partition: 'persist:browser',
    },
  });

  mainWindow.addBrowserView(browserView);

  // Start hidden — renderer will send bounds once the panel is measured
  browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  // Wire navigation events → renderer
  const wc = browserView.webContents;

  wc.on('did-navigate', (_event, url) => {
    console.log(`[Browser] Navigated: ${url}`);
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, url);
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, wc.getTitle());
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_URL_CHANGED, url);
  });

  wc.on('page-title-updated', (_event, title) => {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_TITLE_CHANGED, title);
  });

  wc.on('did-start-loading', () => {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, true);
  });

  wc.on('did-stop-loading', () => {
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
  });

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.warn(`[Browser] Load failed: ${errorCode} ${errorDescription} — ${validatedURL}`);
    mainWindow?.webContents.send(IPC_EVENTS.BROWSER_LOADING, false);
  });

  // Open external links in the same view (don't spawn new windows)
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: 'deny' };
  });

  isInitialized = true;
  console.log('[Browser] Initialized');
}

/**
 * Update the BrowserView position/size. Called when the renderer
 * sends the browser panel viewport's bounding rect via IPC.
 */
export function setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  currentBounds = bounds;
  if (browserView && bounds.width > 0 && bounds.height > 0) {
    browserView.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    browserView.setAutoResize({ width: false, height: false });
  }
}

/**
 * Hide the BrowserView (when browser panel is toggled off).
 */
export function hideBrowser(): void {
  if (browserView) {
    browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}

/**
 * Show the BrowserView at the last known bounds.
 */
export function showBrowser(): void {
  if (browserView && currentBounds.width > 0) {
    setBounds(currentBounds);
  }
}

// ═══════════════════════════════════
// Navigation — used by both IPC handlers and tool executors
// ═══════════════════════════════════

function ensureUrl(url: string): string {
  let u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://') && !u.startsWith('file://')) {
    u = 'https://' + u;
  }
  return u;
}

/**
 * Navigate to a URL. Returns page title, final URL, and visible text.
 */
export async function navigate(url: string): Promise<{ title: string; url: string; content: string }> {
  if (!browserView) throw new Error('Browser not initialized');

  const wc = browserView.webContents;
  const fullUrl = ensureUrl(url);

  try {
    await wc.loadURL(fullUrl);
  } catch (err: any) {
    // loadURL throws on network errors but the page may have partially loaded
    if (!err.message?.includes('ERR_ABORTED')) {
      console.warn(`[Browser] Navigation error: ${err.message}`);
    }
  }

  // Wait a beat for dynamic content
  await wait(500);

  const title = wc.getTitle();
  const finalUrl = wc.getURL();
  const content = await getVisibleText();

  return { title, url: finalUrl, content };
}

export async function goBack(): Promise<void> {
  if (browserView?.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
}

export async function goForward(): Promise<void> {
  if (browserView?.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
}

export async function reload(): Promise<void> {
  browserView?.webContents.reload();
}

export function getCurrentUrl(): string {
  return browserView?.webContents.getURL() || '';
}

export function getTitle(): string {
  return browserView?.webContents.getTitle() || '';
}

// ═══════════════════════════════════
// Content extraction — used by tool executors
// ═══════════════════════════════════

/**
 * Get the visible text content of the current page (body.innerText).
 * Truncated to ~15,000 chars to stay within reasonable token limits.
 */
export async function getVisibleText(): Promise<string> {
  if (!browserView) return '';

  try {
    const text = await browserView.webContents.executeJavaScript(`
      (function() {
        // Remove script/style/noscript elements from the text extraction
        const clone = document.body.cloneNode(true);
        const remove = clone.querySelectorAll('script, style, noscript, svg, iframe');
        remove.forEach(el => el.remove());
        return clone.innerText.trim();
      })()
    `);
    // Truncate to ~15K chars
    if (text.length > 15000) {
      return text.slice(0, 15000) + '\n\n[Content truncated — page has more text]';
    }
    return text;
  } catch (err: any) {
    console.warn(`[Browser] Text extraction failed: ${err.message}`);
    return '[Failed to extract page text]';
  }
}

/**
 * Get interactive elements on the page (links, buttons, inputs) with indices.
 * The agent uses these indices with browser_click.
 */
export async function getInteractiveElements(): Promise<string> {
  if (!browserView) return '';

  try {
    return await browserView.webContents.executeJavaScript(`
      (function() {
        const elements = [];
        const selectors = 'a[href], button, input, textarea, select, [role="button"], [onclick]';
        const nodes = document.querySelectorAll(selectors);
        
        nodes.forEach((el, i) => {
          if (i >= 50) return; // Cap at 50 elements
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return; // Skip hidden
          
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 80);
          const href = el.getAttribute('href') || '';
          const type = el.getAttribute('type') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const name = el.getAttribute('name') || '';
          
          let desc = '[' + elements.length + '] ' + tag;
          if (type) desc += '[type=' + type + ']';
          if (text) desc += ' "' + text + '"';
          if (href) desc += ' → ' + href.slice(0, 60);
          if (placeholder) desc += ' (' + placeholder + ')';
          if (name) desc += ' name=' + name;
          
          elements.push(desc);
        });
        
        return elements.join('\\n');
      })()
    `);
  } catch (err: any) {
    return '[Failed to get interactive elements]';
  }
}

/**
 * Click an element. Supports:
 *   - Numeric string → click nth interactive element
 *   - Starts with . # [ → CSS selector
 *   - Otherwise → find by visible text
 */
export async function clickElement(target: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');

  try {
    const result = await browserView.webContents.executeJavaScript(`
      (function() {
        const target = ${JSON.stringify(target)};
        
        // Numeric index
        if (/^\\d+$/.test(target)) {
          const idx = parseInt(target);
          const selectors = 'a[href], button, input, textarea, select, [role="button"], [onclick]';
          const nodes = Array.from(document.querySelectorAll(selectors)).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (idx >= nodes.length) return 'Error: Index ' + idx + ' out of range (found ' + nodes.length + ' elements)';
          nodes[idx].click();
          return 'Clicked element [' + idx + ']: ' + (nodes[idx].textContent || '').trim().slice(0, 60);
        }
        
        // CSS selector
        if (target.startsWith('.') || target.startsWith('#') || target.startsWith('[')) {
          const el = document.querySelector(target);
          if (!el) return 'Error: No element matches selector "' + target + '"';
          el.click();
          return 'Clicked: ' + (el.textContent || '').trim().slice(0, 60);
        }
        
        // Text match
        const allClickable = document.querySelectorAll('a, button, [role="button"], [onclick]');
        for (const el of allClickable) {
          if ((el.textContent || '').trim().toLowerCase().includes(target.toLowerCase())) {
            el.click();
            return 'Clicked: "' + (el.textContent || '').trim().slice(0, 60) + '"';
          }
        }
        
        return 'Error: No clickable element found matching "' + target + '"';
      })()
    `);

    // Wait for potential page load
    await wait(800);
    return result;
  } catch (err: any) {
    return `[Error clicking]: ${err.message}`;
  }
}

/**
 * Type text into an input field.
 */
export async function typeText(text: string, selector?: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');

  try {
    const result = await browserView.webContents.executeJavaScript(`
      (function() {
        const text = ${JSON.stringify(text)};
        const selector = ${JSON.stringify(selector || '')};
        
        let el;
        if (selector) {
          el = document.querySelector(selector);
          if (!el) return 'Error: No element matches selector "' + selector + '"';
        } else {
          // Find the focused input, or the first visible input
          el = document.activeElement;
          if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable)) {
            el = document.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea');
          }
          if (!el) return 'Error: No input field found';
        }
        
        // Focus and set value
        el.focus();
        
        if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Use native setter to bypass React controlled component issues
          const nativeSetter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(el), 'value'
          )?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          
          if (nativeSetter) {
            nativeSetter.call(el, text);
          } else {
            el.value = text;
          }
          
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        
        return 'Typed "' + text.slice(0, 40) + '" into ' + el.tagName.toLowerCase() + (el.name ? '[name=' + el.name + ']' : '');
      })()
    `);
    return result;
  } catch (err: any) {
    return `[Error typing]: ${err.message}`;
  }
}

/**
 * Extract structured data based on a natural language instruction.
 * For V1, just returns visible text — the LLM parses it.
 */
export async function extractData(instruction: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');

  const text = await getVisibleText();
  return `[Page content for extraction — instruction: "${instruction}"]\n\n${text}`;
}

/**
 * Take a screenshot. Returns base64 PNG.
 */
export async function takeScreenshot(): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');

  try {
    const image = await browserView.webContents.capturePage();
    const base64 = image.toPNG().toString('base64');
    return `[Screenshot captured: ${image.getSize().width}x${image.getSize().height}px]\ndata:image/png;base64,${base64.slice(0, 200)}... (${base64.length} chars total)`;
  } catch (err: any) {
    return `[Error capturing screenshot]: ${err.message}`;
  }
}

/**
 * Perform a Google search and extract results.
 */
export async function search(query: string): Promise<string> {
  if (!browserView) throw new Error('Browser not initialized');

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  
  try {
    await browserView.webContents.loadURL(searchUrl);
    await wait(1500); // Google needs a moment

    const results = await browserView.webContents.executeJavaScript(`
      (function() {
        const results = [];
        
        // Google search result selectors (these change occasionally)
        const containers = document.querySelectorAll('div.g, div[data-sokoban-container]');
        
        containers.forEach((container, i) => {
          if (i >= 5) return; // Top 5
          
          const linkEl = container.querySelector('a[href]');
          const titleEl = container.querySelector('h3');
          const snippetEl = container.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
          
          if (!linkEl || !titleEl) return;
          
          const url = linkEl.getAttribute('href') || '';
          const title = titleEl.textContent || '';
          const snippet = snippetEl ? snippetEl.textContent || '' : '';
          
          if (url.startsWith('/search') || url.startsWith('/url')) return; // Skip internal
          
          results.push({
            title: title.trim(),
            url: url.trim(),
            snippet: snippet.trim().slice(0, 200),
          });
        });
        
        // Fallback: if structured extraction failed, get any links
        if (results.length === 0) {
          const links = document.querySelectorAll('a[href^="http"]');
          links.forEach((a, i) => {
            if (i >= 5) return;
            const text = (a.textContent || '').trim();
            if (text.length > 5 && text.length < 200) {
              results.push({
                title: text.slice(0, 100),
                url: a.getAttribute('href') || '',
                snippet: '',
              });
            }
          });
        }
        
        return JSON.stringify(results);
      })()
    `);

    const parsed = JSON.parse(results || '[]');

    if (parsed.length === 0) {
      // Fallback: just return the visible text
      const text = await getVisibleText();
      return `Search results for "${query}" (structured extraction failed, raw text):\n\n${text.slice(0, 3000)}`;
    }

    const formatted = parsed.map((r: any, i: number) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`
    ).join('\n\n');

    return `Search results for "${query}":\n\n${formatted}`;
  } catch (err: any) {
    return `[Error searching]: ${err.message}`;
  }
}

/**
 * Clean up.
 */
export function closeBrowser(): void {
  if (browserView && mainWindow) {
    mainWindow.removeBrowserView(browserView);
    (browserView.webContents as any)?.destroy?.();
    browserView = null;
  }
  isInitialized = false;
  console.log('[Browser] Closed');
}

// Helper
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
