import { describe, expect, it } from 'vitest';
import { getExecutorBinding, listExecutorBindings, resolveExecutorForCapabilities } from '../../src/main/agent/executor-registry';

describe('executor-registry', () => {
  it('registers browser_cdp with isolated browser tab scope', () => {
    const binding = getExecutorBinding('browser_cdp');
    expect(binding.toolScope).toContain('browser_extract_product_details');
    expect(binding.contextScope.browserScope?.isolation).toBe('isolated_tab');
  });

  it('registers app_cli_anything with gui fallback', () => {
    const binding = getExecutorBinding('app_cli_anything');
    expect(binding.preferredSurface).toBe('cli_anything');
    expect(binding.fallbackExecutors).toContain('desktop_gui');
  });

  it('resolves executors by capability set', () => {
    expect(resolveExecutorForCapabilities(['navigate', 'structured_extract'])).toBe('browser_cdp');
    expect(resolveExecutorForCapabilities(['app_control', 'export'])).toBe('app_cli_anything');
  });

  it('lists all baseline executor bindings', () => {
    expect(listExecutorBindings().map((binding) => binding.kind)).toEqual(
      expect.arrayContaining(['llm_general', 'browser_cdp', 'app_cli_anything', 'runtime_verifier']),
    );
  });
});
