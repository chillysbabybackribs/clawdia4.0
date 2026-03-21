import { describe, expect, it, vi } from 'vitest';

const fromPartition = vi.fn(() => ({ tag: 'browser-session' }));

vi.mock('electron', () => ({
  session: {
    fromPartition,
  },
}));

describe('browser/session', () => {
  it('uses the dedicated browser partition', async () => {
    const mod = await import('../../src/main/browser/session');
    expect(mod.BROWSER_PARTITION).toBe('persist:browser');
    expect(mod.getBrowserSession()).toEqual({ tag: 'browser-session' });
    expect(fromPartition).toHaveBeenCalledWith('persist:browser');
  });
});
