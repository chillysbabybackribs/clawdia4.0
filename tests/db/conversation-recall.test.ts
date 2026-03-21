import { beforeEach, describe, expect, it, vi } from 'vitest';

const all = vi.fn(() => []);
const prepare = vi.fn(() => ({ all }));

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare }),
}));

describe('conversation recall FTS query building', () => {
  beforeEach(() => {
    prepare.mockClear();
    all.mockReset();
    all.mockReturnValue([]);
  });

  it('quotes and sanitizes hyphenated keywords so sub-agents does not break MATCH parsing', async () => {
    const { searchPastConversations } = await import('../../src/main/db/conversation-recall');
    searchPastConversations('spawn 2 parallel sub-agents to browse example.com', null, 3);

    expect(all).toHaveBeenCalled();
    const args = all.mock.calls[0];
    expect(args[0]).toContain('"sub"');
    expect(args[0]).toContain('"agents"');
    expect(args[0]).not.toContain('sub-agents');
  });
});
