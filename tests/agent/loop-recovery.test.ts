import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn() };
});

import { verifyFileOutcomes } from '../../src/main/agent/loop-recovery';

describe('verifyFileOutcomes()', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns null when no file tools were called', () => {
    const result = verifyFileOutcomes('Task complete.', [
      { name: 'shell_exec', status: 'success' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when written file exists and is non-empty', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 1234 } as any);
    const result = verifyFileOutcomes('Done.', [
      { name: 'file_write', status: 'success', input: { path: '/tmp/output.txt' } },
    ]);
    expect(result).toBeNull();
  });

  it('returns error string when written file does not exist', () => {
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = verifyFileOutcomes('Done.', [
      { name: 'file_write', status: 'success', input: { path: '/tmp/output.txt' } },
    ]);
    expect(result).toContain('does not exist');
    expect(result).toContain('/tmp/output.txt');
  });

  it('returns error string when written file is empty', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any);
    const result = verifyFileOutcomes('Done.', [
      { name: 'file_write', status: 'success', input: { path: '/tmp/output.txt' } },
    ]);
    expect(result).toContain('empty');
  });

  it('skips failed tool calls', () => {
    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const result = verifyFileOutcomes('Done.', [
      { name: 'file_write', status: 'error', input: { path: '/tmp/output.txt' } },
    ]);
    expect(result).toBeNull();
  });

  it('checks file paths mentioned in the response text', () => {
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      if (String(p).includes('report.pdf')) throw new Error('ENOENT');
      return { size: 100 } as any;
    });
    const result = verifyFileOutcomes(
      'I saved the report to ~/Documents/report.pdf',
      [],
    );
    expect(result).toContain('report.pdf');
  });
});
