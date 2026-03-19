# Claude Code Prompt — Playwright + BrowserView Integration for Clawdia 4.0

## Context

Clawdia 4.0 is an Electron 39.5.1 desktop AI agent at `~/Desktop/clawdia4.0`. It has a working agent loop with streaming, tool execution (filesystem tools work), SQLite persistence, and a React + Tailwind UI with a chat panel (left 35%) and browser panel (right 65%). The browser panel currently shows a static placeholder — no real web content loads.

**Your task:** Wire a real Playwright-controlled browser into the browser panel so Clawdia can browse the web. The user sees pages load in the right panel in real-time. The agent's browser tools (`browser_search`, `browser_navigate`, `browser_click`, `browser_type`, `browser_extract`, `browser_screenshot`, `browser_read_page`) call Playwright, which controls a BrowserView visible in the Electron window.

## Critical Constraints

- **Electron 39.5.1** — pinned exactly (no caret). Electron 40+ crashes on this machine (HP Pavilion, hybrid NVIDIA/Intel GPU, Ubuntu Linux).
- **GPU flags** are already in package.json scripts: `--no-sandbox --disable-gpu --disable-software-rasterizer --disable-gpu-sandbox --disable-dev-shader-cache --disable-accelerated-2d-canvas --use-gl=swiftshader`
- **Playwright** must connect to the Electron BrowserView's Chrome DevTools Protocol (CDP) session — it does NOT launch its own browser. Playwright controls the same page the user sees.
- **The renderer is React + Tailwind** — the BrowserPanel component at `src/renderer/components/BrowserPanel.tsx` needs to become a real webview container.
- **TypeScript compilation**: Main process compiles with `npx tsc -p tsconfig.main.json` (outDir: `dist/`, rootDir: `src/`). Renderer compiles with Vite.

## Architecture

### How BrowserView + Playwright works in Electron:

1. **Electron main process** creates a `BrowserView` and attaches it to the main window, positioned over the browser panel area.
2. The BrowserView has its own `webContents` with a debugger/CDP port.
3. **Playwright** connects to this CDP port via `chromium.connectOverCDP()` to control the page.
4. When the agent calls `browser_navigate`, Playwright's `page.goto()` runs — the user sees the page load live in the BrowserView.
5. The renderer communicates the browser panel's position/size via IPC so the main process can resize the BrowserView.

### Files to create/modify:

**New file: `src/main/browser/manager.ts`**
- Creates and manages the BrowserView lifecycle
- Attaches BrowserView to the main window
- Handles bounds updates from the renderer (IPC: `browser:set-bounds`)
- Exposes the Playwright `Page` object for tool executors
- Manages CDP port detection
- Handles tab-like behavior (for now, single BrowserView — multi-tab later)
- Sends URL/title change events to the renderer

**Modify: `src/main/agent/executors/browser-executors.ts`**
- Replace all stubs with real Playwright calls
- `executeBrowserSearch`: Navigate to Google, extract results (or use a simpler approach: navigate to `https://www.google.com/search?q=...` and extract result snippets)
- `executeBrowserNavigate`: `page.goto(url)`, wait for load, return page title + visible text content
- `executeBrowserReadPage`: `page.content()` or `page.evaluate()` to get visible text
- `executeBrowserClick`: `page.click(selector)` or by text/index
- `executeBrowserType`: `page.fill(selector, text)` or `page.type(selector, text)`
- `executeBrowserExtract`: `page.evaluate()` with the extraction instruction
- `executeBrowserScreenshot`: `page.screenshot()` → base64

**Modify: `src/main/main.ts`**
- Import and initialize the browser manager after window creation
- Wire real IPC handlers for `browser:navigate`, `browser:back`, `browser:forward`, `browser:refresh`, `browser:set-bounds`
- Forward URL/title change events to renderer

**Modify: `src/renderer/components/BrowserPanel.tsx`**
- Remove the placeholder viewport
- Add a `useEffect` that sends the browser panel's bounding rect to main process via IPC (`browser:set-bounds`) on mount and on resize
- Use a `ResizeObserver` on the viewport div to track size changes
- Wire the URL bar to call `browser:navigate` via IPC on submit
- Wire back/forward/refresh buttons to their IPC handlers
- Listen for `browser:url-changed` and `browser:title-changed` events to update the URL bar and tab titles

**Modify: `src/renderer/components/BrowserPanel.tsx` (preload bridge)**
The preload already has browser methods wired:
```
browser.navigate(url), browser.back(), browser.forward(), browser.refresh(),
browser.setBounds(bounds), browser.onUrlChanged(cb), browser.onTitleChanged(cb), browser.onLoading(cb)
```

### IPC Channels (already defined in `src/shared/ipc-channels.ts`):

Invoke (renderer → main):
- `browser:navigate` — Navigate to URL
- `browser:back` — Go back
- `browser:forward` — Go forward  
- `browser:refresh` — Reload page
- `browser:set-bounds` — Update BrowserView position/size: `{ x, y, width, height }`

Events (main → renderer):
- `browser:url-changed` — URL changed (navigation, redirect)
- `browser:title-changed` — Page title changed
- `browser:loading` — Loading state changed (true/false)

## Implementation Steps

### Step 1: Install Playwright
```bash
cd ~/Desktop/clawdia4.0
npm install playwright
```
Note: We do NOT need `@playwright/mcp` or playwright browsers — we're connecting to Electron's built-in Chromium via CDP.

### Step 2: Create `src/main/browser/manager.ts`

Key functions:
```typescript
// Initialize: Create BrowserView, attach to window, connect Playwright
export async function initBrowser(mainWindow: BrowserWindow): Promise<void>

// Get the Playwright Page (used by tool executors)
export function getPage(): Page | null

// Navigation
export async function navigate(url: string): Promise<{ title: string; url: string; content: string }>
export async function goBack(): Promise<void>
export async function goForward(): Promise<void>
export async function refresh(): Promise<void>

// Bounds management
export function setBounds(bounds: { x: number; y: number; width: number; height: number }): void

// Cleanup
export async function closeBrowser(): Promise<void>
```

CDP connection approach:
```typescript
import { chromium } from 'playwright';

// The BrowserView's webContents has a debugger.
// We need to find the CDP port. Electron exposes it via:
// app.commandLine.appendSwitch('remote-debugging-port', '0') — picks a free port
// Then connect Playwright to it.

// Alternative: Use webContents.debugger.attach() and control via CDP directly,
// then connect Playwright via connectOverCDP to localhost:{port}
```

**Important**: The CDP port must be picked BEFORE Electron starts (using `app.commandLine.appendSwitch`). Use `ss -tln` to find a free port from candidates [9222, 9223, 9224, ...].

### Step 3: Wire browser executors to real Playwright

Each executor imports `getPage()` from the manager and uses the Playwright Page API:

```typescript
import { getPage, navigate } from '../../browser/manager';

export async function executeBrowserNavigate(input: Record<string, any>): Promise<string> {
  const result = await navigate(input.url);
  return `Title: ${result.title}\nURL: ${result.url}\n\n${result.content}`;
}
```

For `browser_search`, navigate to Google search URL and extract result snippets:
```typescript
export async function executeBrowserSearch(input: Record<string, any>): Promise<string> {
  const page = getPage();
  const query = encodeURIComponent(input.query);
  await page.goto(`https://www.google.com/search?q=${query}`);
  // Extract search results via page.evaluate()
  const results = await page.evaluate(() => {
    // Extract titles, URLs, snippets from Google's result divs
  });
  return formatResults(results);
}
```

For `browser_click`, support three target types:
1. Numeric string → click nth interactive element
2. Starts with `.` or `#` or `[` → CSS selector
3. Otherwise → text content match

For `browser_extract`, use `page.evaluate()` with a function that extracts based on the instruction.

For `browser_screenshot`, use `page.screenshot({ encoding: 'base64' })`.

### Step 4: Update BrowserPanel.tsx

The viewport div needs to report its position so the main process can overlay the BrowserView exactly on top of it. The BrowserView is a native Chromium surface — it's not a React component. It sits ON TOP of the Electron window at the exact pixel coordinates we specify.

```tsx
const viewportRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  const el = viewportRef.current;
  if (!el) return;

  const updateBounds = () => {
    const rect = el.getBoundingClientRect();
    window.clawdia.browser.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  };

  // Update on mount
  updateBounds();

  // Update on resize
  const observer = new ResizeObserver(updateBounds);
  observer.observe(el);

  return () => observer.disconnect();
}, []);
```

The URL bar should call `window.clawdia.browser.navigate(url)` on form submit, and listen for `onUrlChanged` to update the displayed URL.

### Step 5: Wire main.ts

```typescript
import { initBrowser, navigate, goBack, goForward, refresh, setBounds, closeBrowser } from './browser/manager';

// After window creation:
await initBrowser(mainWindow);

// Replace stub IPC handlers:
ipcMain.handle(IPC.BROWSER_NAVIGATE, async (_e, url: string) => navigate(url));
ipcMain.handle(IPC.BROWSER_BACK, async () => goBack());
ipcMain.handle(IPC.BROWSER_FORWARD, async () => goForward());
ipcMain.handle(IPC.BROWSER_REFRESH, async () => refresh());
ipcMain.handle(IPC.BROWSER_SET_BOUNDS, async (_e, bounds) => setBounds(bounds));

// On app quit:
app.on('before-quit', () => closeBrowser());
```

## Testing

After implementation, test these scenarios:

1. **App boots** → BrowserView should be created and positioned over the browser panel area
2. **Type URL in URL bar + Enter** → Page loads visually in the browser panel
3. **Ask Clawdia "search for Anthropic pricing"** → Agent calls `browser_search`, Google loads in the panel, results are returned to the LLM
4. **Ask Clawdia "go to docs.anthropic.com"** → Agent calls `browser_navigate`, page loads visually
5. **Back/Forward buttons** → Navigate browser history
6. **Resize the window** → BrowserView should resize to match the panel

## Important Notes

- `BrowserView` is positioned with absolute pixel coordinates on the window. When the user hides the browser panel (toggle button), set bounds to `{ x: 0, y: 0, width: 0, height: 0 }` or remove the BrowserView.
- Page content extraction should return visible text, not raw HTML. Use `page.evaluate(() => document.body.innerText)` trimmed to ~10,000 chars.
- For `browser_search`, Google may show CAPTCHAs. Have a fallback: if the page doesn't contain search results, return an error message suggesting the user try a different search.
- The `browser_extract` tool should use `page.evaluate()` with a function that tries to extract structured data based on the natural language instruction. For V1, this can be simple — just return the page's visible text and let the LLM parse it.
- Handle navigation errors gracefully — if a URL fails to load, return the error to the agent, don't crash.
