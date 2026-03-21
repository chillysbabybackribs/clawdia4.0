export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export interface ChatOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface NormalizedToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
}

export interface NormalizedTextBlock {
  type: 'text';
  text: string;
}

export interface NormalizedImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface NormalizedToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface NormalizedToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<NormalizedTextBlock | NormalizedImageBlock>;
  is_error?: boolean;
}

export type NormalizedAssistantContentBlock =
  | NormalizedTextBlock
  | NormalizedToolUseBlock;

export type NormalizedMessageContentBlock =
  | NormalizedTextBlock
  | NormalizedImageBlock
  | NormalizedToolUseBlock
  | NormalizedToolResultBlock;

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string | NormalizedMessageContentBlock[];
}

export interface LLMResponse {
  content: NormalizedAssistantContentBlock[];
  stopReason: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}
