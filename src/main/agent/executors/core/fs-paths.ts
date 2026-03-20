import * as os from 'os';
import * as path from 'path';

const SHELL_START_CWD = path.join(os.homedir(), 'Desktop');

export function normalizeFsPath(inputPath: unknown): string {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';

  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(SHELL_START_CWD, raw);
}

export function getShellStartCwd(): string {
  return SHELL_START_CWD;
}
