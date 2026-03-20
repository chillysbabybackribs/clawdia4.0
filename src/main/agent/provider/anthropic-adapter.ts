/**
 * Anthropic adapter — current live provider implementation.
 *
 * This file owns Anthropic-specific SDK types and streaming event parsing.
 * The rest of the app should consume only provider-neutral types.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderClient } from './base';
import type {
  ChatOptions,
  LLMResponse,
  NormalizedAssistantContentBlock,
  NormalizedMessage,
  NormalizedMessageContentBlock,
  NormalizedToolDefinition,
} from './types';

const sdkPool: Map<string, Anthropic> = new Map();

export function getSharedSdk(apiKey: string): Anthropic {
  let sdk = sdkPool.get(apiKey);
  if (!sdk) {
    sdk = new Anthropic({ apiKey, timeout: 300_000 });
    sdkPool.set(apiKey, sdk);
    console.log(`[Client] Created shared Anthropic SDK instance (pool size: ${sdkPool.size})`);
  }
  return sdk;
}

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

const MODEL_MAX_OUTPUT: Record<string, number> = {
  'claude-haiku-4-5-20251001': 8192,
  'claude-sonnet-4-6': 64000,
  'claude-opus-4-6': 32000,
};

export function resolveAnthropicModelId(tier: string): string {
  return MODEL_MAP[tier] || tier;
}

function toAnthropicMessages(messages: NormalizedMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };

    const content = msg.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: typeof block.content === 'string'
          ? block.content
          : block.content.map((contentBlock) => {
            if (contentBlock.type === 'text') {
              return { type: 'text', text: contentBlock.text };
            }
            return {
              type: 'image',
              source: contentBlock.source,
            };
          }),
        is_error: block.is_error,
      };
    });

    return { role: msg.role, content };
  });
}

function toAnthropicTools(tools: NormalizedToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

function stripMessageCacheControls(messages: Anthropic.MessageParam[]): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as any[]) {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        delete block.cache_control;
      }
    }
  }
}

function addMessageCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const content = msg.content as any[];
    const hasToolResult = content.some((b) => b?.type === 'tool_result');
    if (!hasToolResult) continue;
    const lastBlock = content[content.length - 1];
    if (lastBlock && typeof lastBlock === 'object') {
      lastBlock.cache_control = { type: 'ephemeral' };
    }
    break;
  }
}

export class AnthropicProviderClient implements ProviderClient {
  readonly provider = 'anthropic' as const;
  readonly supportsHarnessGeneration = true as const;
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-6') {
    this.client = getSharedSdk(apiKey);
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  async chat(
    messages: NormalizedMessage[],
    tools: NormalizedToolDefinition[],
    staticPrompt: string,
    dynamicPrompt: string,
    onText?: (text: string) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const systemBlocks: any[] = [];
    if (staticPrompt) {
      systemBlocks.push({
        type: 'text',
        text: staticPrompt,
        cache_control: { type: 'ephemeral' },
      });
    }
    if (dynamicPrompt) {
      systemBlocks.push({ type: 'text', text: dynamicPrompt });
    }

    const anthropicMessages = toAnthropicMessages(messages);
    stripMessageCacheControls(anthropicMessages);
    addMessageCacheBreakpoint(anthropicMessages);

    let anthropicTools: any[] = [];
    if (tools.length > 0) {
      anthropicTools = toAnthropicTools(tools).map((tool, i, arr) => (
        i === arr.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
      ));
    }

    const maxTokens = options?.maxTokens ?? MODEL_MAX_OUTPUT[this.model] ?? 32000;
    const createParams: any = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: anthropicMessages,
      stream: true,
    };

    if (anthropicTools.length > 0) createParams.tools = anthropicTools;

    const response = await (this.client.messages.create as any)(createParams, {
      signal: options?.signal,
    }) as AsyncIterable<any>;

    const contentBlocks: NormalizedAssistantContentBlock[] = [];
    let currentTextBlock: { type: 'text'; text: string } | null = null;
    let currentToolUse: { type: 'tool_use'; id: string; name: string; input: any } | null = null;
    let currentToolJson = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    let stopReason = 'end_turn';

    for await (const event of response) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message?.usage?.input_tokens || 0;
          cacheReadTokens = (event.message?.usage as any)?.cache_read_input_tokens || 0;
          cacheCreateTokens = (event.message?.usage as any)?.cache_creation_input_tokens || 0;
          break;
        case 'content_block_start':
          if (event.content_block.type === 'text') {
            currentTextBlock = { type: 'text', text: '' };
          } else if (event.content_block.type === 'tool_use') {
            currentToolUse = {
              type: 'tool_use',
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            };
            currentToolJson = '';
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta' && currentTextBlock) {
            currentTextBlock.text += event.delta.text;
            onText?.(event.delta.text);
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            currentToolJson += event.delta.partial_json || '';
          }
          break;
        case 'content_block_stop':
          if (currentTextBlock) {
            contentBlocks.push(currentTextBlock);
            currentTextBlock = null;
          } else if (currentToolUse) {
            if (currentToolJson) {
              try {
                currentToolUse.input = JSON.parse(currentToolJson);
              } catch {
                currentToolUse.input = {};
              }
            }
            contentBlocks.push(currentToolUse);
            currentToolUse = null;
            currentToolJson = '';
          }
          break;
        case 'message_delta':
          outputTokens = event.usage?.output_tokens || 0;
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          break;
      }
    }

    const totalInput = inputTokens + cacheReadTokens + cacheCreateTokens;
    const cacheHitRate = totalInput > 0 ? ((cacheReadTokens / totalInput) * 100).toFixed(1) : '0.0';
    console.log(`[LLM] ${this.model} | in=${inputTokens} cache_read=${cacheReadTokens} cache_create=${cacheCreateTokens} out=${outputTokens} | cache_hit=${cacheHitRate}% | max_tokens=${maxTokens} | stop=${stopReason}`);

    return {
      content: contentBlocks,
      stopReason,
      model: this.model,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens },
    };
  }
}
