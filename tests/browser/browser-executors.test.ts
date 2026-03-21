import { beforeEach, describe, expect, it, vi } from 'vitest';

const manager = {
  evaluateScript: vi.fn(),
  getDomSnapshot: vi.fn(),
  watchNetwork: vi.fn(),
  fillField: vi.fn(),
  typeText: vi.fn(),
  search: vi.fn(),
  navigate: vi.fn(),
  getVisibleText: vi.fn(),
  getInteractiveElements: vi.fn(),
  getCurrentUrl: vi.fn(),
  clickElement: vi.fn(),
  extractData: vi.fn(),
  extractListings: vi.fn(),
  extractProductDetails: vi.fn(),
  extractReviewsSummary: vi.fn(),
  takeScreenshot: vi.fn(),
  scrollPage: vi.fn(),
  focusField: vi.fn(),
  detectForm: vi.fn(),
  runHarness: vi.fn(),
  registerHarness: vi.fn(),
  getHarnessContextForUrl: vi.fn(),
  getPageState: vi.fn(),
  waitForBrowser: vi.fn(),
  executeBrowserBatch: vi.fn(),
  compareProducts: vi.fn(),
  createTab: vi.fn(),
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  getTabList: vi.fn(),
};

vi.mock('../../src/main/browser/manager', () => manager);
vi.mock('../../src/main/db/site-profiles', () => ({
  recordVisit: vi.fn(),
  getSiteProfile: vi.fn(() => null),
  extractDomain: vi.fn((url: string) => new URL(url).hostname),
}));

describe('browser executors', () => {
  beforeEach(() => {
    Object.values(manager).forEach(fn => typeof fn === 'function' && 'mockReset' in fn && fn.mockReset());
  });

  it('routes browser_eval through the debugger-backed manager API', async () => {
    manager.evaluateScript.mockResolvedValue({ url: 'https://example.com', value: { ok: true }, truncated: false, type: 'object' });
    const { executeBrowserEval } = await import('../../src/main/agent/executors/browser-executors');
    const result = await executeBrowserEval({ expression: 'document.title', __runId: 'run-1', frame_id: 'frame-1', timeout_ms: 900 });
    expect(manager.evaluateScript).toHaveBeenCalledWith('document.title', { timeoutMs: 900, awaitPromise: undefined, maxResultChars: undefined }, { runId: 'run-1', tabId: undefined, frameId: 'frame-1' });
    expect(result).toContain('"ok": true');
  });

  it('routes browser_dom_snapshot through the manager snapshot API', async () => {
    manager.getDomSnapshot.mockResolvedValue({ url: 'https://example.com', title: 'Example', visibleText: 'Hello', interactiveElements: [], forms: [], frames: [] });
    const { executeBrowserDomSnapshot } = await import('../../src/main/agent/executors/browser-executors');
    const result = await executeBrowserDomSnapshot({ tabId: 'tab-1', frame_id: 'frame-2' });
    expect(manager.getDomSnapshot).toHaveBeenCalledWith({ runId: undefined, tabId: 'tab-1', frameId: 'frame-2' });
    expect(result).toContain('"title": "Example"');
  });

  it('routes browser_network_watch through the manager watcher API', async () => {
    manager.watchNetwork.mockResolvedValue({ status: 'watching', count: 1, entries: [{ url: 'https://example.com/api' }] });
    const { executeBrowserNetworkWatch } = await import('../../src/main/agent/executors/browser-executors');
    const result = await executeBrowserNetworkWatch({ action: 'read', limit: 25, __runId: 'run-2' });
    expect(manager.watchNetwork).toHaveBeenCalledWith('read', { limit: 25 }, { runId: 'run-2', tabId: undefined });
    expect(result).toContain('example.com/api');
  });

  it('routes typed extraction tools through manager APIs', async () => {
    manager.extractListings.mockResolvedValue({ kind: 'listings', data: [{ title: 'Item', url: 'https://example.com/p' }] });
    manager.extractProductDetails.mockResolvedValue({ kind: 'product_details', data: { title: 'Widget', url: 'https://example.com/p', bullets: [] } });
    manager.extractReviewsSummary.mockResolvedValue({ kind: 'reviews_summary', data: { title: 'Widget', url: 'https://example.com/p', highlights: [], histogram: [] } });
    const {
      executeBrowserExtractListings,
      executeBrowserExtractProductDetails,
      executeBrowserExtractReviewsSummary,
    } = await import('../../src/main/agent/executors/browser-executors');
    expect(await executeBrowserExtractListings({})).toContain('"kind": "listings"');
    expect(await executeBrowserExtractProductDetails({})).toContain('"kind": "product_details"');
    expect(await executeBrowserExtractReviewsSummary({})).toContain('"kind": "reviews_summary"');
  });

  it('routes page state, wait, batch, and compare helpers through manager APIs', async () => {
    manager.getPageState.mockResolvedValue({ pageType: 'product', url: 'https://example.com/p' });
    manager.waitForBrowser.mockResolvedValue({ ok: true, waitedFor: 'selector' });
    manager.executeBrowserBatch.mockResolvedValue({ ok: true, steps: [] });
    manager.compareProducts.mockResolvedValue({ rows: [{ title: 'A', url: 'https://example.com/a', highlights: [] }] });
    const {
      executeBrowserPageState,
      executeBrowserWait,
      executeBrowserBatch,
      executeBrowserCompareProducts,
    } = await import('../../src/main/agent/executors/browser-executors');
    expect(await executeBrowserPageState({})).toContain('"pageType": "product"');
    expect(await executeBrowserWait({ kind: 'selector', selector: '#x' })).toContain('"ok": true');
    expect(await executeBrowserBatch({ steps: [] })).toContain('"ok": true');
    expect(await executeBrowserCompareProducts({ urls: ['https://example.com/a'] })).toContain('"rows"');
  });

  it('prefers reliable fillField when browser_type is given a selector', async () => {
    manager.fillField.mockResolvedValue('filled');
    const { executeBrowserType } = await import('../../src/main/agent/executors/browser-executors');
    const result = await executeBrowserType({ selector: '#email', text: 'user@example.com', __runId: 'run-3' });
    expect(manager.fillField).toHaveBeenCalledWith('#email', 'user@example.com', { runId: 'run-3', tabId: undefined });
    expect(manager.typeText).not.toHaveBeenCalled();
    expect(result).toBe('filled');
  });
});
