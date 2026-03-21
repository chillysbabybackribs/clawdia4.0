import { describe, expect, it, vi } from 'vitest';
import { executeBrowserBatchSteps } from '../../src/main/browser/batch';

describe('browser batch', () => {
  it('executes steps sequentially and stops on failure', async () => {
    const handlers = {
      navigate: vi.fn().mockResolvedValue('navigated'),
      click: vi.fn().mockResolvedValue('[Error clicking]: failed'),
      type: vi.fn(),
      extract: vi.fn(),
      extractListings: vi.fn(),
      extractProductDetails: vi.fn(),
      extractReviewsSummary: vi.fn(),
      readPage: vi.fn(),
      scroll: vi.fn(),
      wait: vi.fn(),
    };
    const result = await executeBrowserBatchSteps([
      { tool: 'navigate', input: { url: 'https://example.com' } },
      { tool: 'click', input: { target: 'Buy now' } },
      { tool: 'extract_product_details' },
    ], handlers);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(handlers.extractProductDetails).not.toHaveBeenCalled();
  });
});
