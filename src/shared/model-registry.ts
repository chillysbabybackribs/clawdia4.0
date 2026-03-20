export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export interface ModelOption {
  id: string;
  provider: ProviderId;
  label: string;
  family: string;
  tier: 'fast' | 'balanced' | 'deep';
  description: string;
}

export const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
];

export const MODEL_REGISTRY: ModelOption[] = [
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    label: 'Claude Opus 4.6',
    family: 'Claude',
    tier: 'deep',
    description: 'Most capable for architecture, review, and deep reasoning.',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    family: 'Claude',
    tier: 'balanced',
    description: 'Balanced default for day-to-day coding and execution.',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    family: 'Claude',
    tier: 'fast',
    description: 'Fastest Claude option for lightweight work.',
  },
  {
    id: 'gpt-5.4',
    provider: 'openai',
    label: 'GPT-5.4',
    family: 'GPT',
    tier: 'deep',
    description: 'Latest OpenAI flagship for agentic, coding, and professional workflows.',
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    label: 'GPT-5.4 Mini',
    family: 'GPT',
    tier: 'balanced',
    description: 'Strongest mini model for coding, computer use, and subagents.',
  },
  {
    id: 'gpt-5.4-nano',
    provider: 'openai',
    label: 'GPT-5.4 Nano',
    family: 'GPT',
    tier: 'fast',
    description: 'Fastest, cheapest GPT-5.4-class model for simple high-volume tasks.',
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    label: 'GPT-5',
    family: 'GPT',
    tier: 'deep',
    description: 'Previous-generation OpenAI flagship (Aug 2025 snapshot).',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    label: 'GPT-5 Mini',
    family: 'GPT',
    tier: 'balanced',
    description: 'Previous-generation OpenAI balanced model.',
  },
  {
    id: 'gpt-5-nano',
    provider: 'openai',
    label: 'GPT-5 Nano',
    family: 'GPT',
    tier: 'fast',
    description: 'Previous-generation OpenAI fast model.',
  },
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    label: 'Gemini 2.5 Pro',
    family: 'Gemini',
    tier: 'deep',
    description: 'Top Gemini model for complex reasoning and coding.',
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    label: 'Gemini 2.5 Flash',
    family: 'Gemini',
    tier: 'balanced',
    description: 'Balanced Gemini default with strong tool use support.',
  },
  {
    id: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    label: 'Gemini 2.5 Flash-Lite',
    family: 'Gemini',
    tier: 'fast',
    description: 'Fastest Gemini option for lightweight tasks.',
  },
];

export const DEFAULT_PROVIDER: ProviderId = 'anthropic';

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4',
  gemini: 'gemini-2.5-flash',
};

export function getModelsForProvider(provider: ProviderId): ModelOption[] {
  return MODEL_REGISTRY.filter((model) => model.provider === provider);
}

export function getModelById(modelId: string): ModelOption | undefined {
  return MODEL_REGISTRY.find((model) => model.id === modelId);
}
