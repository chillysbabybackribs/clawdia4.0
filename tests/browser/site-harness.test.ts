import { beforeEach, describe, expect, it, vi } from 'vitest';

const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    exec: vi.fn(),
    prepare: () => ({
      get: vi.fn(),
      all: allMock,
      run: vi.fn(),
    }),
  }),
}));

describe('findHarnessByUrl()', () => {
  beforeEach(() => {
    allMock.mockReset();
  });

  it('matches URL patterns with placeholders', async () => {
    allMock.mockReturnValue([
      {
        id: 1,
        domain: 'example.com',
        action_name: 'checkout',
        url_pattern: 'https://example.com/products/{productId}/checkout',
        fields_json: '[]',
        submit_json: '{}',
        verify_json: '{}',
        success_count: 0,
        fail_count: 0,
        last_used: null,
        created_at: '2026-03-24T00:00:00.000Z',
      },
    ]);

    const { findHarnessByUrl } = await import('../../src/main/browser/site-harness');
    const harness = findHarnessByUrl('https://example.com/products/sku-123/checkout');
    expect(harness?.actionName).toBe('checkout');
  });

  it('does not match a different path shape', async () => {
    allMock.mockReturnValue([
      {
        id: 1,
        domain: 'example.com',
        action_name: 'checkout',
        url_pattern: 'https://example.com/products/{productId}/checkout',
        fields_json: '[]',
        submit_json: '{}',
        verify_json: '{}',
        success_count: 0,
        fail_count: 0,
        last_used: null,
        created_at: '2026-03-24T00:00:00.000Z',
      },
    ]);

    const { findHarnessByUrl } = await import('../../src/main/browser/site-harness');
    const harness = findHarnessByUrl('https://example.com/products/sku-123/reviews');
    expect(harness).toBeNull();
  });
});
