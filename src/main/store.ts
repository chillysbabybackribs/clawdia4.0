/**
 * Settings Store — electron-store for API keys and preferences.
 * Conversations and memory will go in SQLite later.
 */

import Store from 'electron-store';

interface StoreSchema {
  anthropicApiKey: string;
  selectedModel: string;
  hasCompletedSetup: boolean;
}

export const store = new Store<StoreSchema>({
  name: 'clawdia-settings',
  defaults: {
    anthropicApiKey: '',
    selectedModel: 'claude-sonnet-4-6',
    hasCompletedSetup: false,
  },
  encryptionKey: 'clawdia4-store-key',
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
