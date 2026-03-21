import type { BrowserBatchResult, BrowserBatchStep, BrowserBatchStepResult } from './runtime-types';

export interface BrowserBatchHandlers {
  navigate(input?: Record<string, any>): Promise<any>;
  click(input?: Record<string, any>): Promise<any>;
  type(input?: Record<string, any>): Promise<any>;
  extract(input?: Record<string, any>): Promise<any>;
  extractListings(input?: Record<string, any>): Promise<any>;
  extractProductDetails(input?: Record<string, any>): Promise<any>;
  extractReviewsSummary(input?: Record<string, any>): Promise<any>;
  readPage(input?: Record<string, any>): Promise<any>;
  scroll(input?: Record<string, any>): Promise<any>;
  wait(input?: Record<string, any>): Promise<any>;
}

function summarize(tool: BrowserBatchStep['tool'], result: any): string {
  if (typeof result === 'string') return result.slice(0, 160);
  if (result && typeof result === 'object') {
    if (typeof result.summary === 'string') return result.summary.slice(0, 160);
    if (Array.isArray(result.data)) return `${tool}: ${result.data.length} items`;
    return `${tool}: ok`;
  }
  return `${tool}: ${String(result)}`;
}

export async function executeBrowserBatchSteps(
  steps: BrowserBatchStep[],
  handlers: BrowserBatchHandlers,
  opts: { maxSteps?: number } = {},
): Promise<BrowserBatchResult> {
  const maxSteps = Math.max(1, Math.min(opts.maxSteps ?? 8, 12));
  const boundedSteps = steps.slice(0, maxSteps);
  const results: BrowserBatchStepResult[] = [];

  for (let i = 0; i < boundedSteps.length; i += 1) {
    const step = boundedSteps[i];
    try {
      let result: any;
      switch (step.tool) {
        case 'navigate': result = await handlers.navigate(step.input); break;
        case 'click': result = await handlers.click(step.input); break;
        case 'type': result = await handlers.type(step.input); break;
        case 'extract': result = await handlers.extract(step.input); break;
        case 'extract_listings': result = await handlers.extractListings(step.input); break;
        case 'extract_product_details': result = await handlers.extractProductDetails(step.input); break;
        case 'extract_reviews_summary': result = await handlers.extractReviewsSummary(step.input); break;
        case 'read_page': result = await handlers.readPage(step.input); break;
        case 'scroll': result = await handlers.scroll(step.input); break;
        case 'wait': result = await handlers.wait(step.input); break;
        default: throw new Error(`Unsupported batch tool: ${step.tool}`);
      }
      const ok = !(typeof result === 'string' && result.startsWith('[Error'));
      const summary = summarize(step.tool, result);
      results.push({ tool: step.tool, ok, summary, result });
      if (!ok) return { ok: false, steps: results, failedAt: i };
    } catch (error: any) {
      results.push({
        tool: step.tool,
        ok: false,
        summary: error?.message || String(error),
        result: { error: error?.message || String(error) },
      });
      return { ok: false, steps: results, failedAt: i };
    }
  }

  return { ok: true, steps: results };
}
