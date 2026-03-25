import type { BrowserNetworkEntry } from './debugger-session';
import type { DomSnapshotResult } from './dom-snapshot';
import type { BrowserPageStateSnapshot, BrowserPageType } from './runtime-types';

export function classifyPageType(snapshot: Pick<DomSnapshotResult, 'url' | 'title' | 'visibleText' | 'interactiveElements' | 'forms'>): BrowserPageType {
  const url = snapshot.url.toLowerCase();
  const title = snapshot.title.toLowerCase();
  const text = snapshot.visibleText.toLowerCase();
  const formsCount = snapshot.forms?.length || 0;
  const lineCount = (snapshot.visibleText.match(/\n/g)?.length || 0) + 1;
  const authSignals = /\b(sign in|log in|sign up|create account|forgot password|enter your email|enter your password)\b/i;
  const commerceSignals = /\b(add to cart|buy now|ships from|sold by|delivery|checkout)\b/i;
  const articleSignals = /\b(best\b|top \d+|guide\b|review\b|reviews\b|comparison\b|versus\b|vs\.?\b|roundup\b|ranked\b|editor'?s choice|buying guide|how to choose)\b/i;

  const productSignals = [
    /\/dp\/|\/gp\/product\/|\/product\//,
    /\badd to cart\b/,
    /\bbuy now\b/,
    /\bships from\b|\bsold by\b/,
  ];
  if (productSignals.some((re) => re.test(url) || re.test(title) || re.test(text))) return 'product';

  const listingSignals = [
    /[?&](k|q|query|search)=/,
    /\/products?\/|\/shop\/|\/store\/|\/category\/|\/collections?\//,
    /\bresults for\b/,
    /\bsort by\b/,
    /\bfilter\b/,
    /\bshowing \d+ of \d+\b/,
    /\bshop all\b/,
  ];
  const isDiscussionUrl = /\/comments\//.test(url) || /reddit\.com/.test(url);
  if (!isDiscussionUrl && listingSignals.some((re) => re.test(url) || re.test(title) || re.test(text))) return 'listing';

  const repositorySignals = [
    /github\.com/,
    /\/issues\b|\/pulls\b|\/blob\b|\/tree\b|\/releases\b|\/commits\b/,
    /\bstars?\b/,
    /\bforks?\b/,
    /\breadme\b/,
  ];
  const repositoryScore = repositorySignals.reduce((score, re) => score + Number(re.test(url) || re.test(title) || re.test(text)), 0);
  if (/github\.com/.test(url) && repositoryScore >= 2) return 'repository';

  const discussionSignals = [
    /\breddit\b/,
    /\/r\/|\/comments\//,
    /\bupvotes?\b|\bposted by\b|\breply\b|\bthread\b/,
  ];
  const discussionScore = discussionSignals.reduce((score, re) => score + Number(re.test(url) || re.test(title) || re.test(text)), 0)
    + Number(/\bcomments?\b/.test(text) && /\breply\b|\bposted by\b|\bshare\b/.test(text));
  if (discussionScore >= 2 || /\/comments\//.test(url)) return 'discussion';

  const likelyAuthOrCheckoutForm = formsCount > 0 && (
    /\b(password|enter your password|email address|enter your email|checkout|payment|billing|shipping address)\b/i.test(text)
    || commerceSignals.test(text)
  );
  if (likelyAuthOrCheckoutForm) return 'form';

  if (
    articleSignals.test(title + ' ' + text)
    || (lineCount > 8 && /(article|blog|posted|reading time|minutes read)/i.test(text + ' ' + title))
    || (lineCount > 12 && formsCount <= 2 && !likelyAuthOrCheckoutForm)
  ) {
    return 'article';
  }

  return 'unknown';
}

export function summarizeExtraction(kind: string, data: any): string {
  if (Array.isArray(data)) return `${kind}: ${data.length} items`;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data).slice(0, 4);
    return `${kind}: ${keys.join(', ') || 'object'}`;
  }
  return `${kind}: ${String(data).slice(0, 80)}`;
}

export function buildPageStateSnapshot(args: {
  snapshot: DomSnapshotResult;
  extractedEntities?: Record<string, any>;
  recentExtractionResults?: Array<{ kind: string; recordedAt: string; data: any }>;
  lastActionResult?: { action: string; recordedAt: string; summary: string; ok: boolean };
  recentNetworkActivity?: BrowserNetworkEntry[];
  version?: number;
  updatedAt?: string;
}): BrowserPageStateSnapshot {
  const pageType = classifyPageType(args.snapshot);
  return {
    url: args.snapshot.url,
    title: args.snapshot.title,
    pageType,
    visibleInteractiveElements: (args.snapshot.interactiveElements || []).slice(0, 20),
    extractedEntities: args.extractedEntities || {},
    recentExtractionResults: (args.recentExtractionResults || []).slice(-5).map((entry) => ({
      kind: entry.kind,
      recordedAt: entry.recordedAt,
      summary: summarizeExtraction(entry.kind, entry.data),
      data: entry.data,
    })),
    lastActionResult: args.lastActionResult,
    recentNetworkActivity: (args.recentNetworkActivity || []).slice(-10),
    version: args.version ?? 1,
    updatedAt: args.updatedAt || new Date().toISOString(),
    domSnapshot: {
      frames: args.snapshot.frames,
      selectedFrameId: args.snapshot.selectedFrameId,
      selectedFrameUrl: args.snapshot.selectedFrameUrl,
    },
  };
}
