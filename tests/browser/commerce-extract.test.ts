import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildComparisonResult,
  buildComparisonRow,
  extractCommerceFixtureData,
  isCommerceInstruction,
  pickExtractionKind,
} from '../../src/main/browser/commerce-extract';

describe('commerce extraction helpers', () => {
  it('detects commerce-oriented extraction prompts', () => {
    expect(isCommerceInstruction('extract product details with price and seller')).toBe(true);
    expect(isCommerceInstruction('extract page headings')).toBe(false);
  });

  it('chooses typed extraction kinds from the instruction intent', () => {
    expect(pickExtractionKind('extract reviews summary')).toBe('reviews_summary');
    expect(pickExtractionKind('extract listing results')).toBe('listings');
    expect(pickExtractionKind('extract seller and delivery details')).toBe('product_details');
    expect(pickExtractionKind('extract the About this item bullet points and feature list')).toBe('product_details');
  });

  it('builds structured comparison output', () => {
    const row = buildComparisonRow({
      details: {
        title: 'Widget',
        url: 'https://example.com/widget',
        price: '$19.99',
        rating: '4.6 out of 5 stars',
        reviewCount: '120 ratings',
        deliveryInfo: 'Tomorrow',
        seller: 'Example Seller',
        shipsFrom: 'Amazon',
        bullets: ['Fast', 'Compact', 'Quiet'],
        selectedProductLinks: [],
      },
      reviews: {
        title: 'Widget',
        url: 'https://example.com/widget',
        rating: '4.6 out of 5 stars',
        reviewCount: '120 ratings',
        highlights: ['Comfortable fit', 'Battery lasts long'],
        histogram: [{ label: '5 stars', value: '72%' }],
      },
    });
    expect(row.highlights).toEqual(['Fast', 'Compact', 'Quiet']);
    expect(row.bullets).toEqual(['Fast', 'Compact', 'Quiet']);
    expect(row.reviewHighlights).toEqual(['Comfortable fit', 'Battery lasts long']);

    const comparison = buildComparisonResult([{
      title: 'Widget',
      url: 'https://example.com/widget',
      bullets: ['Fast'],
      selectedProductLinks: [],
    }]);
    expect(comparison.rows).toHaveLength(1);
    expect(comparison.rows[0]?.bullets).toEqual(['Fast']);
  });

  it('extracts listings and product details from captured Amazon-like HTML fixtures', () => {
    const searchHtml = readFileSync(join(process.cwd(), 'tests/browser/fixtures/amazon-search.html'), 'utf8');
    const productHtml = readFileSync(join(process.cwd(), 'tests/browser/fixtures/amazon-product.html'), 'utf8');

    const listings = extractCommerceFixtureData(searchHtml, {
      kind: 'listings',
      url: 'https://www.amazon.com/s?k=quiet+mechanical+keyboard',
      title: 'Amazon search results',
    });
    expect(listings.kind).toBe('listings');
    expect(listings.data).toHaveLength(2);
    expect(listings.data[0]?.title).toContain('QuietKeys');
    expect(listings.data[0]?.price).toBe('$79.99');
    expect(listings.data[0]?.asin).toBe('B0AAA111');

    const product = extractCommerceFixtureData(productHtml, {
      kind: 'product_details',
      url: 'https://www.amazon.com/dp/B0AAA111',
      title: 'QuietKeys Wireless Mechanical Keyboard',
    });
    expect(product.kind).toBe('product_details');
    expect(product.data.title).toContain('QuietKeys');
    expect(product.data.price).toBe('$79.99');
    expect(product.data.seller).toContain('QuietKeys Direct');
    expect(product.data.shipsFrom).toContain('Amazon');
    expect(product.data.bullets).toContain('Hot-swappable PCB');
    expect(product.data.bullets.some((bullet) => /asin/i.test(bullet))).toBe(false);
    expect(product.data.selectedProductLinks).toHaveLength(2);
  });
});
