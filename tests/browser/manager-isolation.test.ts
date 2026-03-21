import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

class FakeDebugger extends EventEmitter {
  attached = false;
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  async sendCommand() { return {}; }
}

let nextId = 1;

class FakeWebContents extends EventEmitter {
  id = nextId++;
  debugger = new FakeDebugger();
  currentUrl = 'about:blank';
  destroyed = false;
  windowOpenHandler: ((details: { url: string; features?: string }) => { action: 'deny' | 'allow' }) | null = null;

  setUserAgent() {}
  async loadURL(url: string) { this.currentUrl = url; }
  getTitle() { return 'Fake'; }
  getURL() { return this.currentUrl; }
  isLoading() { return false; }
  isLoadingMainFrame() { return false; }
  canGoBack() { return false; }
  canGoForward() { return false; }
  goBack() {}
  goForward() {}
  reload() {}
  isDestroyed() { return this.destroyed; }
  async executeJavaScript() { return ''; }
  setWindowOpenHandler(handler: any) { this.windowOpenHandler = handler; }
  capturePage = vi.fn(async () => ({
    getSize: () => ({ width: 10, height: 10 }),
    toPNG: () => Buffer.from('png'),
  }));
  openDevTools() {}
  closeDevTools() {}
  isDevToolsOpened() { return false; }
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}

class FakeBrowserView {
  webContents = new FakeWebContents();
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  setBounds(bounds: any) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
}

const fromPartition = vi.fn(() => ({
  webRequest: {
    onBeforeSendHeaders: vi.fn(),
  },
  cookies: {
    get: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
  },
}));

vi.mock('electron', () => ({
  app: { userAgentFallback: 'Mozilla/5.0 Chrome/136.0.0.0 Safari/537.36' },
  BrowserView: FakeBrowserView,
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  session: { fromPartition },
}));

async function loadManager() {
  vi.resetModules();
  return await import('../../src/main/browser/manager');
}

function makeWindow() {
  return {
    addBrowserView: vi.fn(),
    removeBrowserView: vi.fn(),
    webContents: { send: vi.fn() },
  } as any;
}

describe('browser manager isolated tabs', () => {
  beforeEach(() => {
    nextId = 1;
    fromPartition.mockClear();
  });

  it('allocates hidden run-owned tabs without exposing them in the user tab list', async () => {
    const manager = await loadManager();
    manager.initBrowser(makeWindow());

    const before = manager.getTabList();
    expect(before).toHaveLength(1);

    const isolatedId = manager.allocateIsolatedTab('run-123', 'https://example.com');
    expect(isolatedId).toBeTruthy();

    const after = manager.getTabList();
    expect(after).toHaveLength(1);
    expect(after.some(tab => tab.id === isolatedId)).toBe(false);

    manager.releaseIsolatedTab('run-123');
    expect(manager.getTabList()).toHaveLength(1);
    manager.closeBrowser();
  });
});
