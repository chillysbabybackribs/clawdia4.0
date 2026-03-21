import { describe, expect, it } from 'vitest';
import {
  ensureUrl,
  isLikelyProductUrl,
  isValidProductExtraction,
} from '../../src/main/browser/manager';

describe('browser manager URL normalization', () => {
  it('preserves about:blank for hidden run tabs', () => {
    expect(ensureUrl('about:blank')).toBe('about:blank');
  });

  it('still normalizes bare domains to https', () => {
    expect(ensureUrl('example.com')).toBe('https://example.com');
  });

  it('detects likely product detail URLs', () => {
    expect(isLikelyProductUrl('https://www.amazon.com/dp/B08R8DT7X6')).toBe(true);
    expect(isLikelyProductUrl('https://www.amazon.com/gp/product/B08R8DT7X6')).toBe(true);
  });

  it('rejects listing and search URLs as comparison inputs', () => {
    expect(isLikelyProductUrl('https://www.amazon.com/s?k=wireless+gaming+headset')).toBe(false);
    expect(isLikelyProductUrl('https://www.amazon.com/search?q=headset')).toBe(false);
    expect(isLikelyProductUrl('not-a-url')).toBe(false);
  });
});

describe('browser manager product extraction validation', () => {
  it('accepts a valid product extraction envelope', () => {
    expect(
      isValidProductExtraction({
        kind: 'product_details',
        pageType: 'product',
        url: 'https://www.amazon.com/dp/B08R8DT7X6',
        title: 'Logitech G435 Lightspeed Wireless Gaming Headset',
        data: {
          title: 'Logitech G435 Lightspeed Wireless Gaming Headset',
        },
      } as any),
    ).toBe(true);
  });

  it('rejects not-found and listing-style extractions', () => {
    expect(
      isValidProductExtraction({
        kind: 'product_details',
        pageType: 'product',
        url: 'https://www.amazon.com/dp/B000000000',
        title: 'Page Not Found',
        data: {
          title: 'Page Not Found',
        },
      } as any),
    ).toBe(false);

    expect(
      isValidProductExtraction({
        kind: 'product_details',
        pageType: 'listing',
        url: 'https://www.amazon.com/s?k=wireless+gaming+headset',
        title: 'Amazon.com : wireless gaming headset',
        data: {
          title: '1-16 of 232 results for "wireless gaming headset"',
        },
      } as any),
    ).toBe(false);
  });
});
