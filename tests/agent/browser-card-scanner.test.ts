import { describe, expect, it, vi } from 'vitest';

const fsExistsSyncMock = vi.fn();
const fsCopyFileSyncMock = vi.fn();
const fsUnlinkSyncMock = vi.fn();

let capturedSql: string = '';
let allMock = vi.fn();
let prepareMock = vi.fn(function(sql: string) {
  capturedSql = sql;
  return { all: allMock };
});

vi.mock('fs', () => ({
  existsSync: fsExistsSyncMock,
  copyFileSync: fsCopyFileSyncMock,
  unlinkSync: fsUnlinkSyncMock,
}));

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn(function() {
      return {
        prepare: prepareMock,
        close: vi.fn(),
      };
    }),
  };
});

describe('browser-card-scanner', () => {
  it('returns empty array when Chrome profile not found', async () => {
    vi.clearAllMocks();
    fsExistsSyncMock.mockReturnValue(false);
    const { scanBrowserCards } = await import('../../src/main/agent/browser-card-scanner');
    const cards = await scanBrowserCards();
    expect(cards).toEqual([]);
  });

  it('returns empty array when Web Data file read fails (locked)', async () => {
    vi.clearAllMocks();
    fsExistsSyncMock.mockReturnValue(true);
    fsCopyFileSyncMock.mockImplementation(() => { throw new Error('locked'); });
    const { scanBrowserCards } = await import('../../src/main/agent/browser-card-scanner');
    const cards = await scanBrowserCards();
    expect(cards).toEqual([]);
  });

  it('returns mapped candidates from Chrome when cards found', async () => {
    vi.clearAllMocks();
    capturedSql = '';
    fsExistsSyncMock.mockReturnValue(true);
    fsCopyFileSyncMock.mockImplementation(() => {});
    fsUnlinkSyncMock.mockImplementation(() => {});
    allMock.mockReturnValue([{
      name_on_card: 'Visa Card',
      last_four: '4242',
      expiration_month: 12,
      expiration_year: 2027,
    }]);

    const { scanBrowserCards } = await import('../../src/main/agent/browser-card-scanner');
    const cards = await scanBrowserCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].lastFour).toBe('4242');
    expect(cards[0].cardType).toBe('visa');
    expect(cards[0].browserSource).toBe('chrome');
    expect(cards[0].source).toBe('browser_autofill');
  });

  it('does not read card_number_encrypted column', async () => {
    vi.clearAllMocks();
    capturedSql = '';
    fsExistsSyncMock.mockReturnValue(true);
    fsCopyFileSyncMock.mockImplementation(() => {});
    fsUnlinkSyncMock.mockImplementation(() => {});
    allMock.mockReturnValue([]);

    const { scanBrowserCards } = await import('../../src/main/agent/browser-card-scanner');
    await scanBrowserCards();

    // Verify the SQL used does NOT contain card_number_encrypted
    expect(capturedSql).not.toContain('card_number_encrypted');
    expect(capturedSql).toContain('name_on_card');
    expect(capturedSql).toContain('last_four');
  });
});
