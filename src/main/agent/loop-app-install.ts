/**
 * App Installer — install system apps before harness generation.
 *
 * Strategy (no bare sudo — blocks on stdin in Electron main process):
 *   1. flatpak install --user  (no auth, user-space)
 *   2. pkexec apt install      (GUI PolicyKit dialog)
 *   3. pkexec snap install     (GUI PolicyKit dialog)
 *
 * All PM calls have 120s timeouts. Failures are non-fatal.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const INSTALL_TIMEOUT = 120_000;

// One-time availability check cache
const pmCache: Record<string, boolean> = {};

async function hasBin(cmd: string): Promise<boolean> {
  if (cmd in pmCache) return pmCache[cmd];
  try {
    await execAsync(`which ${cmd} 2>/dev/null`, { timeout: 3000 });
    pmCache[cmd] = true;
  } catch {
    pmCache[cmd] = false;
  }
  return pmCache[cmd];
}

async function binaryOnPath(appId: string): Promise<boolean> {
  try {
    await execAsync(`which ${appId} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function installApp(
  appId: string,
  onProgress: (text: string) => void,
): Promise<boolean> {
  // Already installed — fast path
  if (await binaryOnPath(appId)) return true;

  // 1. Try flatpak --user (no auth needed)
  if (await hasBin('flatpak')) {
    onProgress(`Installing ${appId} via flatpak (user install, no password needed)...`);
    try {
      await execAsync(
        `flatpak install --user -y flathub ${appId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      // Flatpak binaries may not be on PATH directly — check both
      if (await binaryOnPath(appId) || await binaryOnPath(`flatpak`)) {
        onProgress(`✓ Installed ${appId} via flatpak.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] flatpak failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // 2. Try pkexec apt (GUI password dialog)
  if (await hasBin('pkexec') && await hasBin('apt')) {
    onProgress(`Installing ${appId} via apt (a password dialog will appear)...`);
    try {
      await execAsync(
        `pkexec apt install -y ${appId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      if (await binaryOnPath(appId)) {
        onProgress(`✓ Installed ${appId} via apt.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] pkexec apt failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // 3. Try pkexec snap (GUI password dialog)
  if (await hasBin('pkexec') && await hasBin('snap')) {
    onProgress(`Installing ${appId} via snap (a password dialog will appear)...`);
    try {
      await execAsync(
        `pkexec snap install ${appId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      if (await binaryOnPath(appId)) {
        onProgress(`✓ Installed ${appId} via snap.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] pkexec snap failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // All methods failed
  onProgress(
    `Could not install ${appId} automatically. Please run one of:\n` +
    `  sudo apt install ${appId}\n` +
    `  sudo snap install ${appId}\n` +
    `  flatpak install flathub ${appId}\n` +
    `Then try your request again.`,
  );
  return false;
}
