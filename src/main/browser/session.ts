import { session } from 'electron';

export const BROWSER_PARTITION = 'persist:browser';

export function getBrowserSession(): Electron.Session {
  return session.fromPartition(BROWSER_PARTITION);
}

