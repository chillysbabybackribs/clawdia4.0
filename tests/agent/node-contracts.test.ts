import { describe, expect, it } from 'vitest';
import {
  APP_TASK_OUTPUT_CONTRACT,
  BROWSER_RESEARCH_OUTPUT_CONTRACT,
  PLANNER_OUTPUT_CONTRACT,
  PRODUCT_COMPARE_OUTPUT_CONTRACT,
  VERIFICATION_OUTPUT_CONTRACT,
  validateContractPayload,
} from '../../src/main/agent/node-contracts';

describe('node contracts', () => {
  it('defines a planner output contract with graph payload', () => {
    expect(PLANNER_OUTPUT_CONTRACT.schemaName).toBe('PlannerOutput');
    expect(PLANNER_OUTPUT_CONTRACT.required).toContain('graph');
  });

  it('defines browser and comparison worker contracts', () => {
    expect(BROWSER_RESEARCH_OUTPUT_CONTRACT.schemaName).toBe('BrowserResearchOutput');
    expect(PRODUCT_COMPARE_OUTPUT_CONTRACT.schemaName).toBe('ProductCompareOutput');
  });

  it('defines app and verification contracts', () => {
    expect(APP_TASK_OUTPUT_CONTRACT.required).toContain('artifacts');
    expect(VERIFICATION_OUTPUT_CONTRACT.required).toContain('retryRecommended');
  });

  it('validates payloads against the contract schema', () => {
    const valid = validateContractPayload(BROWSER_RESEARCH_OUTPUT_CONTRACT, {
      findings: [{ title: 'A', url: 'https://example.com', facts: ['x'], confidence: 0.9 }],
    });
    expect(valid.valid).toBe(true);

    const invalid = validateContractPayload(PRODUCT_COMPARE_OUTPUT_CONTRACT, {
      winner: 'A',
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes('$.products missing'))).toBe(true);
  });
});
