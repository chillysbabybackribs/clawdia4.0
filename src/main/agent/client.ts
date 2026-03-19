/**
 * Anthropic Client — Streaming with 3-breakpoint prompt caching.
 *
 * Cache breakpoints (max 4 allowed by API, we use 3):
 *   1. System prompt (static block) — ephemeral
 *   2. Last tool definition — ephemeral  
 *   3. Last tool_result message — ephemeral
 */

import Anthropic from '@anthropic-ai/sdk';

// ═══════════════════════════════════
// Singleton SDK instance pool — reuse HTTP connections
// ═══════════════════════════════════
const sdkPool: Map<string, Anthropic> = new Map();

/** Get or create a shared Anthropic SDK instance for the given API key. */
export function getSharedSdk(apiKey: string): Anthropic {
  let sdk = sdkPool.get(apiKey);
  if (!sdk) {
    sdk = new Anthropic({ apiKey, timeout: 300_000 });
    sdkPool.set(apiKey, sdk);
    console.log(`[Client] Created shared Anthropic SDK instance (pool size: ${sdkPool.size})`);
  }
  return sdk;
}

export interface LLMResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}

export interface ChatOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

/** Model max output tokens — request the model's actual ceiling */
const MODEL_MAX_OUTPUT: Record<string, number> = {
  'claude-haiku-4-5-20251001': 8192,
  'claude-sonnet-4-6': 64000,
  'claude-opus-4-6': 32000,
};

export function resolveModelId(tier: string): string {
  return MODEL_MAP[tier] || tier;
}

export class AnthropicClient {
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
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    staticPrompt: string,
    dynamicPrompt: string,
    onText?: (text: string) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    // ── System blocks: breakpoint 1 of 3 ──
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

    // ── Tools: breakpoint 2 of 3 ──
    let toolsForApi: any[] = [];
    if (tools.length > 0) {
      toolsForApi = tools.map((t, i) => {
        if (i === tools.length - 1) {
          return { ...t, cache_control: { type: 'ephemeral' } };
        }
        return { ...t };
      });
    }

    // ── Messages: breakpoint 3 of 3 ──
    this.stripMessageCacheControls(messages);
    this.addMessageCacheBreakpoint(messages);

    // Use model-aware max tokens — never truncate unnecessarily
    const defaultMax = MODEL_MAX_OUTPUT[this.model] || 32000;
    const maxTokens = options?.maxTokens ?? defaultMax;

    const createParams: any = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages,
      stream: true,
    };

    if (toolsForApi.length > 0) {
      createParams.tools = toolsForApi;
    }

    const response = await (this.client.messages.create as any)(createParams, {
      signal: options?.signal,
    }) as AsyncIterable<any>;

    const contentBlocks: Anthropic.ContentBlock[] = [];
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
            contentBlocks.push(currentTextBlock as any);
            currentTextBlock = null;
          } else if (currentToolUse) {
            if (currentToolJson) {
              try { currentToolUse.input = JSON.parse(currentToolJson); } catch { currentToolUse.input = {}; }
            }
            contentBlocks.push(currentToolUse as any);
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

  private stripMessageCacheControls(messages: Anthropic.MessageParam[]): void {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block && typeof block === 'object' && 'cache_control' in block) {
          delete block.cache_control;
        }
      }
    }
  }

  private addMessageCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      const content = msg.content as any[];
      const hasToolResult = content.some(b => b?.type === 'tool_result');
      if (!hasToolResult) continue;
      const lastBlock = content[content.length - 1];
      if (lastBlock && typeof lastBlock === 'object') {
        lastBlock.cache_control = { type: 'ephemeral' };
      }
      break;
    }
  }
}
