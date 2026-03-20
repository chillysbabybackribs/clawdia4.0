import { EXTRACTOR_SENTINEL_RE, parseExtractorSentinels } from '../../src/main/agent/loop-ytdlp';

describe('loop-ytdlp helpers', () => {
  test('EXTRACTOR_SENTINEL_RE matches valid sentinel', () => {
    const re = new RegExp(EXTRACTOR_SENTINEL_RE.source, 'g');
    const m = re.exec('[EXTRACTOR_SUCCESS:/home/dp/Desktop/my video.mp4]');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('/home/dp/Desktop/my video.mp4');
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
