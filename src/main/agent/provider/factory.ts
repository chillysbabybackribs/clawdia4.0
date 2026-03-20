import type { ProviderClient } from './base';
import type { ProviderId } from './types';
import { DEFAULT_MODEL_BY_PROVIDER, getModelById, getModelsForProvider } from '../../../shared/model-registry';
import { AnthropicProviderClient, resolveAnthropicModelId } from './anthropic-adapter';
import { OpenAIProviderClient } from './openai-adapter';
import { GeminiProviderClient } from './gemini-adapter';

function resolveTier(provider: ProviderId, tier: 'fast' | 'balanced' | 'deep'): string {
  return getModelsForProvider(provider).find((model) => model.tier === tier)?.id || DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function resolveModelForProvider(provider: ProviderId, modelOrTier: string): string {
  if (provider === 'anthropic') {
    if (modelOrTier === 'haiku') return resolveAnthropicModelId('haiku');
    if (modelOrTier === 'sonnet') return resolveAnthropicModelId('sonnet');
    if (modelOrTier === 'opus') return resolveAnthropicModelId('opus');
    return resolveAnthropicModelId(modelOrTier);
  }

  const explicit = getModelById(modelOrTier);
  if (explicit?.provider === provider) return explicit.id;

  if (modelOrTier === 'haiku') return resolveTier(provider, 'fast');
  if (modelOrTier === 'sonnet') return resolveTier(provider, 'balanced');
  if (modelOrTier === 'opus') return resolveTier(provider, 'deep');

  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function createProviderClient(provider: ProviderId, apiKey: string, model: string): ProviderClient {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProviderClient(apiKey, model);
    case 'openai':
      return new OpenAIProviderClient(apiKey, model);
    case 'gemini':
      return new GeminiProviderClient(apiKey, model);
  }
}
