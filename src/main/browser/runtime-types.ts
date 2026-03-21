import type { BrowserNetworkEntry } from './debugger-session';
import type { DomSnapshotResult } from './dom-snapshot';

export type BrowserPageType = 'listing' | 'product' | 'form' | 'article' | 'unknown';

export interface CommerceListing {
  title: string;
  url: string;
  price?: string;
  rating?: string;
  reviewCount?: string;
  deliveryInfo?: string;
  seller?: string;
  asin?: string;
  position: number;
}

export interface ProductDetails {
  title: string;
  url: string;
  price?: string;
  rating?: string;
  reviewCount?: string;
  deliveryInfo?: string;
  seller?: string;
  shipsFrom?: string;
  bullets: string[];
  selectedProductLinks: Array<{ title: string; url: string }>;
}

export interface ReviewsSummary {
  title: string;
  url: string;
  rating?: string;
  reviewCount?: string;
  highlights: string[];
  histogram: Array<{ label: string; value: string }>;
}

export interface StructuredExtractionEnvelope<T> {
  kind: 'listings' | 'product_details' | 'reviews_summary' | 'generic';
  pageType: BrowserPageType;
  url: string;
  title: string;
  count?: number;
  data: T;
}

export interface EvalErrorEnvelope {
  type: 'runtime' | 'timeout' | 'serialization' | 'unknown';
  message: string;
  stack?: string;
  diagnostic?: string;
}

export interface EvalResultEnvelope {
  ok: boolean;
  url: string;
  type: string;
  truncated: boolean;
  value: any;
  error?: EvalErrorEnvelope;
}

export interface BrowserPageStateSnapshot {
  url: string;
  title: string;
  pageType: BrowserPageType;
  visibleInteractiveElements: Array<Record<string, any>>;
  extractedEntities: Record<string, any>;
  recentExtractionResults: Array<{ kind: string; recordedAt: string; summary: string; data: any }>;
  lastActionResult?: { action: string; recordedAt: string; summary: string; ok: boolean };
  recentNetworkActivity: BrowserNetworkEntry[];
  version: number;
  updatedAt: string;
  domSnapshot?: Pick<DomSnapshotResult, 'frames' | 'selectedFrameId' | 'selectedFrameUrl'>;
}

export interface BrowserBatchStep {
  tool:
    | 'navigate'
    | 'click'
    | 'type'
    | 'extract'
    | 'extract_listings'
    | 'extract_product_details'
    | 'extract_reviews_summary'
    | 'read_page'
    | 'scroll'
    | 'wait';
  input?: Record<string, any>;
}

export interface BrowserBatchStepResult {
  tool: BrowserBatchStep['tool'];
  ok: boolean;
  summary: string;
  result: any;
}

export interface BrowserBatchResult {
  ok: boolean;
  steps: BrowserBatchStepResult[];
  failedAt?: number;
}

export interface ProductComparisonRow {
  title: string;
  url: string;
  price?: string;
  rating?: string;
  reviewCount?: string;
  deliveryInfo?: string;
  seller?: string;
  shipsFrom?: string;
  highlights: string[];
  bullets: string[];
  reviewHighlights: string[];
  reviewHistogram: Array<{ label: string; value: string }>;
}

export interface ProductComparisonResult {
  rows: ProductComparisonRow[];
  comparedAt: string;
}
