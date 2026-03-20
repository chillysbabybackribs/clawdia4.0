/**
 * Settings Store — electron-store for API keys and preferences.
 */

import Store from 'electron-store';
import * as os from 'os';
import * as crypto from 'crypto';
import type { PerformanceStance, ProviderId } from '../shared/types';
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER } from '../shared/model-registry';

// Generate a machine-specific encryption key from hostname + username.
// Not bulletproof security, but prevents trivial key extraction from source.
const machineId = `${os.hostname()}-${os.userInfo().username}-clawdia4`;
const encryptionKey = crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32);

interface StoreSchema {
  providerKeys: Record<ProviderId, string>;
  selectedProvider: ProviderId;
  selectedModelByProvider: Record<ProviderId, string>;
  hasCompletedSetup: boolean;
  unrestrictedMode: boolean;
  selectedPolicyProfile: string;
  selectedPerformanceStance: PerformanceStance;
}

export const store = new Store<StoreSchema>({
  name: 'clawdia-settings',
  defaults: {
    providerKeys: {
      anthropic: '',
      openai: '',
      gemini: '',
    },
    selectedProvider: DEFAULT_PROVIDER,
    selectedModelByProvider: { ...DEFAULT_MODEL_BY_PROVIDER },
    hasCompletedSetup: false,
    unrestrictedMode: false,
    selectedPolicyProfile: 'standard',
    selectedPerformanceStance: 'standard',
  },
  encryptionKey,
});

function normalizeProvider(provider?: ProviderId): ProviderId {
  return provider || store.get('selectedProvider', DEFAULT_PROVIDER);
}

export function getProviderKeys(): Record<ProviderId, string> {
  const keys = store.get('providerKeys', {
    anthropic: '',
    openai: '',
    gemini: '',
  });
  const legacyAnthropicKey = (store as any).get('anthropicApiKey', '');
  if (!keys.anthropic && legacyAnthropicKey) {
    const migrated = { ...keys, anthropic: legacyAnthropicKey };
    store.set('providerKeys', migrated);
    return migrated;
  }
  return keys;
}

export function getApiKey(provider?: ProviderId): string {
  const resolved = normalizeProvider(provider);
  return getProviderKeys()[resolved] || '';
}

export function setApiKey(provider: ProviderId, key: string): void {
  const keys = { ...getProviderKeys(), [provider]: key };
  store.set('providerKeys', keys);
  if (key) store.set('hasCompletedSetup', true);
}

export function hasAnyApiKey(): boolean {
  return Object.values(getProviderKeys()).some(Boolean);
}

export function getSelectedProvider(): ProviderId {
  return store.get('selectedProvider', DEFAULT_PROVIDER);
}

export function setSelectedProvider(provider: ProviderId): void {
  store.set('selectedProvider', provider || DEFAULT_PROVIDER);
}

export function getSelectedModel(provider?: ProviderId): string {
  const resolved = normalizeProvider(provider);
  const models = store.get('selectedModelByProvider', { ...DEFAULT_MODEL_BY_PROVIDER });
  const legacyAnthropicModel = (store as any).get('selectedModel', '');
  if (!models.anthropic && legacyAnthropicModel) {
    const migrated = { ...models, anthropic: legacyAnthropicModel };
    store.set('selectedModelByProvider', migrated);
    return migrated[resolved] || DEFAULT_MODEL_BY_PROVIDER[resolved];
  }
  return models[resolved] || DEFAULT_MODEL_BY_PROVIDER[resolved];
}

export function setSelectedModel(provider: ProviderId, model: string): void {
  const resolved = normalizeProvider(provider);
  const models = {
    ...store.get('selectedModelByProvider', { ...DEFAULT_MODEL_BY_PROVIDER }),
    [resolved]: model,
  };
  store.set('selectedModelByProvider', models);
}

export function getUnrestrictedMode(): boolean {
  return store.get('unrestrictedMode', false);
}

export function setUnrestrictedMode(enabled: boolean): void {
  store.set('unrestrictedMode', enabled);
}

export function getSelectedPolicyProfile(): string {
  return store.get('selectedPolicyProfile', 'standard');
}

export function setSelectedPolicyProfile(profileId: string): void {
  store.set('selectedPolicyProfile', profileId || 'standard');
}

export function getSelectedPerformanceStance(): PerformanceStance {
  return store.get('selectedPerformanceStance', 'standard');
}

export function setSelectedPerformanceStance(stance: PerformanceStance): void {
  store.set('selectedPerformanceStance', stance || 'standard');
}
