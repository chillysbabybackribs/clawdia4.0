import type {
  CommerceListing,
  ProductComparisonResult,
  ProductComparisonRow,
  ProductDetails,
  ReviewsSummary,
  StructuredExtractionEnvelope,
} from './runtime-types';

export type CommerceExtractionKind = 'listings' | 'product_details' | 'reviews_summary' | 'auto';

export interface ProductComparisonCandidate {
  details: ProductDetails;
  reviews?: ReviewsSummary;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function matchFirst(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return stripTags(match[1]);
  }
  return undefined;
}

function matchHref(html: string, patterns: RegExp[], baseUrl: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const href = match?.[1];
    if (!href) continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href;
    }
  }
  return undefined;
}

export function isCommerceInstruction(instruction: string): boolean {
  return /\b(product|listing|results|price|rating|review|seller|ships from|delivery|compare|commerce|amazon|about this item|feature list|features?|bullets?)\b/i.test(instruction);
}

export function pickExtractionKind(instruction: string): CommerceExtractionKind {
  const lower = instruction.toLowerCase();
  if (/\breview/.test(lower)) return 'reviews_summary';
  if (/\b(detail|product|seller|ships from|delivery|bullets?|features?|about this item|feature list)\b/.test(lower)) return 'product_details';
  if (/\b(listing|results|candidates?|products?)\b/.test(lower)) return 'listings';
  return 'auto';
}

export function buildCommerceExtractionScript(kind: CommerceExtractionKind): string {
  return `(() => {
    const absoluteUrl = (href) => {
      try { return new URL(href, window.location.href).toString(); } catch { return href || ''; }
    };
    const clean = (value, max = 240) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const firstText = (selectors, root = document, max = 240) => {
      for (const selector of selectors) {
        const el = root.querySelector(selector);
        const text = clean(el && (el.textContent || el.getAttribute('content') || el.getAttribute('aria-label')), max);
        if (text) return text;
      }
      return '';
    };
    const firstHref = (selectors, root = document) => {
      for (const selector of selectors) {
        const el = root.querySelector(selector);
        const href = el && (el.getAttribute('href') || el.href);
        if (href) return absoluteUrl(href);
      }
      return '';
    };
    const extractPrice = (root = document) => {
      const whole = firstText(['.a-price .a-price-whole', '[data-a-price] .a-price-whole'], root, 40);
      const fraction = firstText(['.a-price .a-price-fraction', '[data-a-price] .a-price-fraction'], root, 10);
      if (whole) return '$' + whole.replace(/\\$$/, '') + (fraction ? '.' + fraction : '');
      return firstText([
        '#corePrice_feature_div .a-price .a-offscreen',
        '.a-price .a-offscreen',
        '[itemprop=price]',
        '[class*=price]',
        '[data-price]',
      ], root, 60);
    };
    const extractRating = (root = document) => firstText([
      '#acrPopover [title]',
      '[data-hook=rating-out-of-text]',
      '.a-icon-alt',
      '[aria-label*="out of 5 stars"]',
    ], root, 80);
    const extractReviewCount = (root = document) => firstText([
      '#acrCustomerReviewText',
      '[data-hook=total-review-count]',
      'a[href*="#customerReviews"]',
      '[aria-label*="ratings"]',
    ], root, 80);
    const extractDelivery = (root = document) => firstText([
      '#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE',
      '#deliveryBlockMessage',
      '[data-cy=delivery-recipe]',
      '[class*=delivery]',
      '[class*=shipping]',
    ], root, 140);
    const extractSeller = (root = document) => firstText([
      '#merchantInfo',
      '#sellerProfileTriggerId',
      '[data-feature-name=merchant-info]',
      '[class*=seller]',
      '[class*=merchant]',
    ], root, 140);
    const extractShipsFrom = (root = document) => firstText([
      '#fulfillerInfoFeature_feature_div',
      '#tabular-buybox-truncate-0',
      '[class*=ships-from]',
    ], root, 140);
    const pageType = (() => {
      const url = window.location.href;
      const text = clean(document.body ? document.body.innerText : '', 2000).toLowerCase();
      if (/\\/dp\\/|\\/gp\\/product\\//.test(url) || /add to cart|buy now/.test(text)) return 'product';
      if (document.querySelector('[data-component-type="s-search-result"], .s-result-item, [data-asin]') || /results for|sort by|filter/.test(text)) return 'listing';
      if (document.querySelector('form input, form textarea')) return 'form';
      return 'unknown';
    })();
    const extractListings = () => {
      const seen = new Set();
      const cards = Array.from(document.querySelectorAll('[data-component-type="s-search-result"], .s-result-item, [data-asin], main li, main article'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const listings = [];
      for (const card of cards) {
        if (listings.length >= 10) break;
        const title = firstText(['h2', 'h3', '[data-cy=title-recipe]', '[class*=title]'], card, 180);
        const url = firstHref(['h2 a', 'a[href*="/dp/"]', 'a[href]'], card);
        if (!title || !url || seen.has(url)) continue;
        seen.add(url);
        listings.push({
          title,
          url,
          price: extractPrice(card) || undefined,
          rating: extractRating(card) || undefined,
          reviewCount: extractReviewCount(card) || undefined,
          deliveryInfo: extractDelivery(card) || undefined,
          seller: extractSeller(card) || undefined,
          asin: card.getAttribute('data-asin') || undefined,
          position: listings.length + 1,
        });
      }
      return listings;
    };
    const extractProductDetails = () => {
      const bullets = Array.from(document.querySelectorAll(
        '#feature-bullets li, #feature-bullets .a-list-item, [data-feature-name=featurebullets] li, #productFactsDesktopExpander li, #detailBullets_feature_div li, .a-unordered-list.a-vertical li'
      ))
        .map((el) => clean(el.textContent, 200))
        .filter((text) => text && !/^(?:customer reviews|best sellers rank|asin|manufacturer|date first available)\b/i.test(text))
        .filter((text, index, all) => all.indexOf(text) === index)
        .slice(0, 10);
      const selectedProductLinks = Array.from(document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'))
        .map((el) => ({ title: clean(el.textContent, 120), url: absoluteUrl(el.getAttribute('href') || el.href || '') }))
        .filter((entry) => entry.title && entry.url)
        .slice(0, 8);
      return {
        title: firstText(['#productTitle', 'h1', 'meta[property="og:title"]'], document, 220) || document.title,
        url: window.location.href,
        price: extractPrice(document) || undefined,
        rating: extractRating(document) || undefined,
        reviewCount: extractReviewCount(document) || undefined,
        deliveryInfo: extractDelivery(document) || undefined,
        seller: extractSeller(document) || undefined,
        shipsFrom: extractShipsFrom(document) || undefined,
        bullets,
        selectedProductLinks,
      };
    };
    const extractReviewsSummary = () => {
      const highlights = Array.from(document.querySelectorAll('[data-hook=cr-insights-widget] li, [data-hook=review-star-rating], [data-hook=review-body]'))
        .map((el) => clean(el.textContent, 160))
        .filter(Boolean)
        .slice(0, 5);
      const histogram = Array.from(document.querySelectorAll('[aria-label*="5 stars"], [aria-label*="4 stars"], [aria-label*="3 stars"], [aria-label*="2 stars"], [aria-label*="1 star"], [data-hook=histogram-row]'))
        .map((el) => ({
          label: clean(el.getAttribute('aria-label') || firstText(['a', 'span'], el, 80), 80),
          value: clean(el.textContent, 80),
        }))
        .filter((entry) => entry.label || entry.value)
        .slice(0, 5);
      return {
        title: firstText(['#productTitle', 'h1'], document, 220) || document.title,
        url: window.location.href,
        rating: extractRating(document) || undefined,
        reviewCount: extractReviewCount(document) || undefined,
        highlights,
        histogram,
      };
    };
    const kind = ${JSON.stringify(kind)};
    if (kind === 'listings' || (kind === 'auto' && pageType === 'listing')) {
      const listings = extractListings();
      return { kind: 'listings', pageType, url: window.location.href, title: document.title, count: listings.length, data: listings };
    }
    if (kind === 'reviews_summary') {
      const summary = extractReviewsSummary();
      return { kind: 'reviews_summary', pageType, url: window.location.href, title: document.title, data: summary };
    }
    const details = extractProductDetails();
    return { kind: 'product_details', pageType, url: window.location.href, title: document.title, data: details };
  })()`;
}

export function buildComparisonRow(candidate: ProductComparisonCandidate): ProductComparisonRow {
  const { details, reviews } = candidate;
  return {
    title: details.title,
    url: details.url,
    price: details.price,
    rating: details.rating,
    reviewCount: details.reviewCount,
    deliveryInfo: details.deliveryInfo,
    seller: details.seller,
    shipsFrom: details.shipsFrom,
    highlights: details.bullets.slice(0, 3),
    bullets: details.bullets.slice(0, 5),
    reviewHighlights: reviews?.highlights?.slice(0, 3) || [],
    reviewHistogram: reviews?.histogram?.slice(0, 5) || [],
  };
}

export function buildComparisonResult(products: Array<ProductDetails | ProductComparisonCandidate>): ProductComparisonResult {
  return {
    rows: products.map((product) => buildComparisonRow('details' in product ? product : { details: product })),
    comparedAt: new Date().toISOString(),
  };
}

export function extractCommerceFixtureData(
  html: string,
  options: { kind: 'listings' | 'product_details'; url: string; title?: string },
): ListingsEnvelope | ProductDetailsEnvelope {
  if (options.kind === 'listings') {
    const blocks = html
      .split(/<div[^>]+data-component-type=["']s-search-result["']/i)
      .slice(1)
      .map((chunk) => `<div data-component-type="s-search-result"${chunk.split(/<div[^>]+data-component-type=["']s-search-result["']/i)[0]}`);
    const listings = blocks.slice(0, 10).map((block, index) => {
      const whole = matchFirst(block, [/<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
      const fraction = matchFirst(block, [/<span[^>]+class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]) || '00';
      return {
        title: matchFirst(block, [/<h2[^>]*>([\s\S]*?)<\/h2>/i, /<span[^>]+class=["'][^"']*a-size-medium[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]) || '',
        url: matchHref(block, [/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*a-link-normal/i, /<a[^>]+href=["']([^"']+)["']/i], options.url) || '',
        price: whole ? `$${whole.replace(/\$$/, '')}.${fraction}` : undefined,
        rating: matchFirst(block, [/<span[^>]+class=["'][^"']*a-icon-alt[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]),
        reviewCount: matchFirst(block, [/<span[^>]+class=["'][^"']*a-size-base s-underline-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]),
        deliveryInfo: matchFirst(block, [/<span[^>]+class=["'][^"']*a-color-base a-text-bold[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]),
        seller: undefined,
        asin: (block.match(/data-asin=["']([^"']+)["']/i) || [])[1],
        position: index + 1,
      };
    }).filter((entry) => entry.title && entry.url);
    return {
      kind: 'listings',
      pageType: 'listing',
      url: options.url,
      title: options.title || 'Listings Fixture',
      count: listings.length,
      data: listings,
    };
  }

  const bullets = Array.from(html.matchAll(/<li[^>]*><span[^>]*class=["'][^"']*a-list-item[^"']*["'][^>]*>([\s\S]*?)<\/span><\/li>/gi))
    .map((match) => stripTags(match[1]))
    .filter(Boolean)
    .slice(0, 10);
  const selectedProductLinks = Array.from(html.matchAll(/<a[^>]+href=["']([^"']*\/dp\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
    .map((match) => ({
      url: matchHref(match[0], [/<a[^>]+href=["']([^"']+)["']/i], options.url) || '',
      title: stripTags(match[2]),
    }))
    .filter((entry) => entry.title && entry.url)
    .slice(0, 8);

  return {
    kind: 'product_details',
    pageType: 'product',
    url: options.url,
    title: options.title || 'Product Fixture',
    data: {
      title: matchFirst(html, [/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) || options.title || '',
      url: options.url,
      price: (() => {
        const whole = matchFirst(html, [/<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
        const fraction = matchFirst(html, [/<span[^>]+class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]) || '00';
        return whole ? `$${whole.replace(/\$$/, '')}.${fraction}` : matchFirst(html, [/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
      })(),
      rating: matchFirst(html, [/<span[^>]+class=["'][^"']*a-icon-alt[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]),
      reviewCount: matchFirst(html, [/<span[^>]+id=["']acrCustomerReviewText["'][^>]*>([\s\S]*?)<\/span>/i]),
      deliveryInfo: matchFirst(html, [/<div[^>]+id=["']deliveryBlockMessage["'][^>]*>([\s\S]*?)<\/div>/i]),
      seller: matchFirst(html, [/<div[^>]+id=["']merchantInfo["'][^>]*>([\s\S]*?)<\/div>/i]),
      shipsFrom: matchFirst(html, [/<div[^>]+id=["']fulfillerInfoFeature_feature_div["'][^>]*>([\s\S]*?)<\/div>/i]),
      bullets,
      selectedProductLinks,
    },
  };
}

export type ListingsEnvelope = StructuredExtractionEnvelope<CommerceListing[]>;
export type ProductDetailsEnvelope = StructuredExtractionEnvelope<ProductDetails>;
export type ReviewsSummaryEnvelope = StructuredExtractionEnvelope<ReviewsSummary>;
