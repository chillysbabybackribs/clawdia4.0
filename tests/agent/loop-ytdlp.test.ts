import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EXTRACTOR_SENTINEL_RE, parseExtractorSentinels, runYtdlpPipeline, checkYtdlpInstalled } from '../../src/main/agent/loop-ytdlp';

// Mock the factory so we can inject a controlled ProviderClient
vi.mock('../../src/main/agent/provider/factory', () => ({
  resolveModelForProvider: vi.fn(() => 'claude-sonnet-4-5'),
  createProviderClient: vi.fn(),
}));
// Mock tool-builder so tests don't need real tool schemas
vi.mock('../../src/main/agent/tool-builder', () => ({
  getToolsForGroup: vi.fn(() => []),
  executeTool: vi.fn(),
}));

import { createProviderClient } from '../../src/main/agent/provider/factory';

beforeEach(() => vi.resetAllMocks());

describe('loop-ytdlp helpers', () => {
  test('EXTRACTOR_SENTINEL_RE matches valid sentinel', () => {
    const re = new RegExp(EXTRACTOR_SENTINEL_RE.source, 'g');
    const m = re.exec('[EXTRACTOR_SUCCESS:/home/dp/Desktop/my video.mp4]');
    expect(m).not.toBeNull();
    expect(m && m[1]).toBe('/home/dp/Desktop/my video.mp4');
  });

  test('EXTRACTOR_SENTINEL_RE does not match partial text', () => {
    const re = new RegExp(EXTRACTOR_SENTINEL_RE.source, 'g');
    const m = re.exec('EXTRACTOR_SUCCESS:/path');
    expect(m).toBeNull();
  });

  test('parseExtractorSentinels extracts multiple paths', () => {
    const text = 'Done\n[EXTRACTOR_SUCCESS:/a/b.mp4]\n[EXTRACTOR_SUCCESS:/a/c.mp4]';
    expect(parseExtractorSentinels(text)).toEqual(['/a/b.mp4', '/a/c.mp4']);
  });

  test('parseExtractorSentinels returns empty array when none found', () => {
    expect(parseExtractorSentinels('no sentinels here')).toEqual([]);
  });
});

describe('runYtdlpPipeline', () => {
  const fakeClient = { provider: 'anthropic' as const, supportsHarnessGeneration: true, setModel: vi.fn(), getModel: vi.fn(), chat: vi.fn() };

  test('returns success:false with no files when agent responds with no tool calls and no sentinels', async () => {
    vi.mocked(createProviderClient).mockReturnValue({
      ...fakeClient,
      chat: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'I could not find the video.' }], stopReason: 'end_turn', model: 'sonnet', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 } }),
    } as any);

    const result = await runYtdlpPipeline('download a video', {
      client: fakeClient as any,
      apiKey: 'test-key',
      onProgress: vi.fn(),
      onRegisterCancel: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.files).toEqual([]);
  });

  test('returns success:true with files when sentinel is emitted', async () => {
    vi.mocked(createProviderClient).mockReturnValue({
      ...fakeClient,
      chat: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Done! [EXTRACTOR_SUCCESS:/home/dp/Desktop/video.mp4]' }], stopReason: 'end_turn', model: 'sonnet', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 } }),
    } as any);

    const result = await runYtdlpPipeline('download a video', {
      client: fakeClient as any,
      apiKey: 'test-key',
      onProgress: vi.fn(),
      onRegisterCancel: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.files).toEqual(['/home/dp/Desktop/video.mp4']);
  });

  test('returns success:false with reason cancelled when abort fires', async () => {
    let registeredAbort: (() => void) | undefined;
    vi.mocked(createProviderClient).mockReturnValue({
      ...fakeClient,
      chat: vi.fn().mockImplementation(async () => {
        // Trigger abort mid-chat
        registeredAbort?.();
        throw new Error('aborted');
      }),
    } as any);

    const abortController = new AbortController();
    const result = await runYtdlpPipeline('download a video', {
      client: fakeClient as any,
      apiKey: 'test-key',
      onProgress: vi.fn(),
      onRegisterCancel: (fn) => { registeredAbort = fn; },
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('cancelled');
  });
});

describe('checkYtdlpInstalled', () => {
  test('returns false when exec throws', async () => {
    const result = await checkYtdlpInstalled(() => Promise.reject(new Error('not found')));
    expect(result).toBe(false);
  });

  test('returns true when exec resolves', async () => {
    const result = await checkYtdlpInstalled(() => Promise.resolve('/usr/bin/yt-dlp'));
    expect(result).toBe(true);
  });
});
