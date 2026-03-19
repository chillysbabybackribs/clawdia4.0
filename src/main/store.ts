/**
 * Settings Store — electron-store for API keys and preferences.
 */

import Store from 'electron-store';
import * as os from 'os';
import * as crypto from 'crypto';

// Generate a machine-specific encryption key from hostname + username.
// Not bulletproof security, but prevents trivial key extraction from source.
const machineId = `${os.hostname()}-${os.userInfo().username}-clawdia4`;
const encryptionKey = crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32);

interface StoreSchema {
  anthropicApiKey: string;
  selectedModel: string;
  hasCompletedSetup: boolean;
  unrestrictedMode: boolean;
}

export const store = new Store<StoreSchema>({
  name: 'clawdia-settings',
  defaults: {
    anthropicApiKey: '',
    selectedModel: 'claude-sonnet-4-6',
    hasCompletedSetup: false,
    unrestrictedMode: false,
  },
  encryptionKey,
});

export function getApiKey(): string {
  return store.get('anthropicApiKey', '');
}

export function setApiKey(key: string): void {
  store.set('anthropicApiKey', key);
  if (key) store.set('hasCompletedSetup', true);
}

export function getSelectedModel(): string {
  return store.get('selectedModel', 'claude-sonnet-4-6');
}

export function setSelectedModel(model: string): void {
  store.set('selectedModel', model);
}

export function getUnrestrictedMode(): boolean {
  return store.get('unrestrictedMode', false);
}

export function setUnrestrictedMode(enabled: boolean): void {
  store.set('unrestrictedMode', enabled);
}
