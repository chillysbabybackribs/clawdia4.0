import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/store', () => ({
  getApiKey: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('embedGoal()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fetchMock.mockReset();
  });

  it('uses OpenAI when openai key is available', async () => {
    const { getApiKey } = await import('../../../src/main/store');
    vi.mocked(getApiKey).mockImplementation((p) => p === 'openai' ? 'sk-test' : '');

    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ data: [{ embedding: fakeEmbedding }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const { embedGoal } = await import('../../../src/main/agent/bloodhound/embedder');
    const result = await embedGoal('check github notifications');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('openai.com');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1536);
  });

  it('falls back to Gemini when no OpenAI key', async () => {
    const { getApiKey } = await import('../../../src/main/store');
    vi.mocked(getApiKey).mockImplementation((p) => p === 'gemini' ? 'gemini-key' : '');

    const fakeEmbedding = Array.from({ length: 768 }, () => 0.2);
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ embedding: { values: fakeEmbedding } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const { embedGoal } = await import('../../../src/main/agent/bloodhound/embedder');
    const result = await embedGoal('check github notifications');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('googleapis.com');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });

  it('throws when neither OpenAI nor Gemini key is available', async () => {
    const { getApiKey } = await import('../../../src/main/store');
    vi.mocked(getApiKey).mockReturnValue('');

    const { embedGoal } = await import('../../../src/main/agent/bloodhound/embedder');
    await expect(embedGoal('test')).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
