import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() },
  app: { getPath: () => '/tmp' },
}));
vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare: () => ({ get: () => null, run: () => ({}), all: () => [] }) }),
  closeDb: () => {},
}));

import { extractOtpCode, extractVerificationLink } from '../../src/main/autonomy/email-monitor';
import { extractSmsCode } from '../../src/main/autonomy/phone-verifier';

describe('extractOtpCode', () => {
  it('extracts a 6-digit code from a typical verification email', () => {
    expect(extractOtpCode('Your verification code is 482910. Use it within 10 minutes.')).toBe('482910');
  });

  it('extracts a 4-digit code', () => {
    expect(extractOtpCode('Your PIN is 7842')).toBe('7842');
  });

  it('returns null when no code is present', () => {
    expect(extractOtpCode('Welcome to the service! Click the link below.')).toBeNull();
  });
});

describe('extractVerificationLink', () => {
  it('extracts a verification link containing "verify"', () => {
    const body = 'Click here to verify your email: https://example.com/verify?token=abc123';
    expect(extractVerificationLink(body)).toBe('https://example.com/verify?token=abc123');
  });

  it('extracts a confirmation link', () => {
    const body = 'Confirm your account: https://app.example.com/confirm/xyz789 — link expires in 24h';
    expect(extractVerificationLink(body)).toBe('https://app.example.com/confirm/xyz789');
  });

  it('returns null when no verification link is present', () => {
    expect(extractVerificationLink('Thanks for signing up!')).toBeNull();
  });
});

describe('extractSmsCode', () => {
  it('extracts a 6-digit SMS code', () => {
    expect(extractSmsCode('Your Reddit code is 293847')).toBe('293847');
  });

  it('returns null when no code is present', () => {
    expect(extractSmsCode('No code here')).toBeNull();
  });
});
