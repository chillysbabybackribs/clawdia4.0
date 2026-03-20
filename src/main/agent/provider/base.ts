import type {
  ChatOptions,
  LLMResponse,
  NormalizedMessage,
  NormalizedToolDefinition,
  ProviderId,
} from './types';

export interface ProviderClient {
  readonly provider: ProviderId;
  /** True if this provider supports the nested harness generation pipeline. */
  readonly supportsHarnessGeneration: boolean;
  setModel(model: string): void;
  getModel(): string;
  chat(
    messages: NormalizedMessage[],
    tools: NormalizedToolDefinition[],
    staticPrompt: string,
    dynamicPrompt: string,
    onText?: (text: string) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse>;
}
