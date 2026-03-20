import { describe, it, expect } from 'vitest';
import { classify } from '../../src/main/agent/classifier';

describe('classifier — ytdlp profile', () => {
  it('detects youtube URL', () => {
    const r = classify('download https://youtube.com/watch?v=abc123');
    expect(r.agentProfile).toBe('ytdlp');
    expect(r.toolGroup).toBe('browser');
  });

  it('detects youtu.be URL', () => {
    const r = classify('grab https://youtu.be/xyz');
    expect(r.agentProfile).toBe('ytdlp');
  });

  it('detects vimeo URL', () => {
    const r = classify('save video from vimeo.com/12345');
    expect(r.agentProfile).toBe('ytdlp');
  });

  it('detects download + video intent', () => {
    const r = classify('download the video from this link');
    expect(r.agentProfile).toBe('ytdlp');
  });

  it('does not match general web search', () => {
    const r = classify('search youtube for piano tutorials');
    expect(r.agentProfile).not.toBe('ytdlp');
  });

  it('does not match greeting', () => {
    const r = classify('hi');
    expect(r.agentProfile).not.toBe('ytdlp');
  });
});
