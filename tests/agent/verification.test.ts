import { describe, it, expect } from 'vitest';
import { verify, resolveVerificationRule } from '../../src/main/agent/verification';

describe('verify() — basic pass/fail', () => {
  it('passes exit_code_success when result has no [Error prefix', () => {
    const rule = resolveVerificationRule('shell_exec', { command: 'ls' })!;
    const result = verify(rule, 'file1.txt\nfile2.txt');
    expect(result.passed).toBe(true);
    expect(result.retried).toBe(false);
  });

  it('fails exit_code_success when result starts with [Error]', () => {
    const rule = resolveVerificationRule('shell_exec', { command: 'badcmd' })!;
    const result = verify(rule, '[Error] command not found');
    expect(result.passed).toBe(false);
  });

  it('passes file_exists for file_write when result is not an error', () => {
    const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
    const result = verify(rule, 'Written 42 bytes to /tmp/test.txt');
    expect(result.passed).toBe(true);
  });

  it('passes url_changed when domain matches and page has content', () => {
    const rule = resolveVerificationRule('browser_navigate', { url: 'https://github.com/foo' })!;
    const fakeResult = 'Title: GitHub\nURL: https://github.com/foo/bar\n\nsome page content here to satisfy length check\n\n--- Interactive Elements ---\n[1] link: Home';
    const result = verify(rule, fakeResult);
    expect(result.passed).toBe(true);
  });

  it('fails url_changed when page has no content', () => {
    const rule = resolveVerificationRule('browser_navigate', { url: 'https://github.com' })!;
    const fakeResult = 'Title: \nURL: https://github.com\n\n';
    const result = verify(rule, fakeResult);
    expect(result.passed).toBe(false);
  });

  it('fails url_changed when domain does not match', () => {
    const rule = resolveVerificationRule('browser_navigate', { url: 'https://github.com' })!;
    const fakeResult = 'Title: Google\nURL: https://www.google.com\n\nsome content here on the page\n\n--- Interactive Elements ---\n[1] link: Search';
    const result = verify(rule, fakeResult);
    expect(result.passed).toBe(false);
  });

  it('fails url_changed on navigation error signals', () => {
    const rule = resolveVerificationRule('browser_navigate', { url: 'https://unreachable.example' })!;
    const result = verify(rule, '[Error: browser_navigate] net::ERR_NAME_NOT_RESOLVED');
    expect(result.passed).toBe(false);
  });
});

describe('verify() — retry behaviour', () => {
  it('retryPolicy: none — does not retry on failure', () => {
    const rule = resolveVerificationRule('shell_exec', { command: 'ls' })!;
    // shell_exec returns RetryPolicy: none
    const result = verify(rule, '[Error] command not found');
    expect(result.retried).toBe(false);
  });

  it('retryPolicy: once — retries once and reports retried:true on failure', () => {
    const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
    // file_write returns RetryPolicy: once
    const result = verify(rule, '[Error] permission denied');
    expect(result.retried).toBe(true);
    expect(result.retryPassed).toBe(false);
  });

  it('retryPolicy: once — retryPassed is false if result still fails', () => {
    const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
    const result = verify(rule, '[Error] permission denied');
    expect(result.passed).toBe(false);
    expect(result.retried).toBe(true);
    expect(result.retryPassed).toBe(false);
  });

  it('does not retry when first check passes', () => {
    const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
    const result = verify(rule, 'Written OK');
    expect(result.passed).toBe(true);
    expect(result.retried).toBe(false);
  });
});

describe('resolveVerificationRule()', () => {
  it('returns null for tools that do not warrant verification', () => {
    expect(resolveVerificationRule('memory_store', {})).toBeNull();
    expect(resolveVerificationRule('recall_context', {})).toBeNull();
    expect(resolveVerificationRule('unknown_tool', {})).toBeNull();
  });

  it('returns a rule for browser_navigate', () => {
    const rule = resolveVerificationRule('browser_navigate', { url: 'https://example.com' });
    expect(rule).not.toBeNull();
    expect(rule!.surface).toBe('browser');
    expect(rule!.type).toBe('url_changed');
  });

  it('returns refocus_then_retry for gui_interact focus action', () => {
    const rule = resolveVerificationRule('gui_interact', { action: 'focus', window: 'GIMP' });
    expect(rule).not.toBeNull();
    expect(rule!.retryPolicy).toBe('refocus_then_retry');
  });
});
