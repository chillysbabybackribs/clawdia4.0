import { describe, expect, it } from 'vitest';
import { buildPageStateSnapshot, classifyPageType } from '../../src/main/browser/page-state';

describe('page-state', () => {
  it('classifies product pages from commerce signals', () => {
    expect(classifyPageType({
      url: 'https://www.amazon.com/dp/B000123',
      title: 'Widget',
      visibleText: 'Add to Cart Buy Now Ships from Amazon',
      interactiveElements: [],
      forms: [],
    })).toBe('product');
  });

  it('builds a bounded page-state snapshot with recent extraction summaries', () => {
    const state = buildPageStateSnapshot({
      snapshot: {
        url: 'https://example.com/search?k=widget',
        title: 'Results for widget',
        visibleText: 'Results for widget',
        interactiveElements: [{ index: 0, tag: 'a' }],
        forms: [],
        frames: [],
      },
      extractedEntities: { listings: [{ title: 'A' }] },
      recentExtractionResults: [{ kind: 'listings', recordedAt: '2026-03-21T00:00:00.000Z', data: [{ title: 'A' }] }],
      lastActionResult: { action: 'extract', recordedAt: '2026-03-21T00:00:00.000Z', summary: 'ok', ok: true },
      recentNetworkActivity: [{ id: '1', url: 'https://example.com/api', method: 'GET', timestamp: 1 }],
      version: 3,
      updatedAt: '2026-03-21T00:00:00.000Z',
    });
    expect(state.pageType).toBe('listing');
    expect(state.recentExtractionResults[0]?.summary).toContain('listings');
    expect(state.version).toBe(3);
  });
});
