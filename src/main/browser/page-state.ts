import type { BrowserNetworkEntry } from './debugger-session';
import type { DomSnapshotResult } from './dom-snapshot';
import type { BrowserPageStateSnapshot, BrowserPageType } from './runtime-types';

export function classifyPageType(snapshot: Pick<DomSnapshotResult, 'url' | 'title' | 'visibleText' | 'interactiveElements' | 'forms'>): BrowserPageType {
  const url = snapshot.url.toLowerCase();
  const title = snapshot.title.toLowerCase();
  const text = snapshot.visibleText.toLowerCase();

  const productSignals = [
    /\/dp\/|\/gp\/product\/|\/product\//,
    /\badd to cart\b/,
    /\bbuy now\b/,
    /\bships from\b|\bsold by\b/,
  ];
  if (productSignals.some((re) => re.test(url) || re.test(title) || re.test(text))) return 'product';

  const listingSignals = [
    /[?&](k|q|query|search)=/,
    /\bresults for\b/,
    /\bsort by\b/,
    /\bfilter\b/,
  ];
  if (listingSignals.some((re) => re.test(url) || re.test(title) || re.test(text))) return 'listing';

  if ((snapshot.forms?.length || 0) > 0 && /(sign in|log in|search|checkout|email|password|submit)/i.test(text)) return 'form';
  if ((text.match(/\n/g)?.length || 0) > 8 && /(article|blog|posted|reading time)/i.test(text + ' ' + title)) return 'article';
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
