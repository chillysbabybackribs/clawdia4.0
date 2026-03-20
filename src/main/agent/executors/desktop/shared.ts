import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

export const execAsync = promisify(exec);
export const TIMEOUT = 30_000;

export async function run(command: string, timeout = TIMEOUT): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      cwd: os.homedir(),
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      maxBuffer: 1024 * 1024 * 2,
    });
    let result = stdout.trim();
    if (stderr.trim()) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr.trim();
    return result || '[No output]';
  } catch (err: any) {
    const out = err.stdout?.trim() || '';
    const se = err.stderr?.trim() || '';
    return `[Error] ${se || out || err.message}`;
  }
}

const toolCache: Record<string, boolean> = {};
export async function cmdExists(cmd: string): Promise<boolean> {
  if (cmd in toolCache) return toolCache[cmd];
  try { await execAsync(`which ${cmd} 2>/dev/null`); toolCache[cmd] = true; }
  catch { toolCache[cmd] = false; }
  return toolCache[cmd];
}

export function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
