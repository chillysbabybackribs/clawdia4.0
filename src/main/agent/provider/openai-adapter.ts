import { retryFetch } from './retry-fetch';
import type { ProviderClient } from './base';
import type {
  ChatOptions,
  LLMResponse,
  NormalizedAssistantContentBlock,
  NormalizedMessage,
  NormalizedMessageContentBlock,
  NormalizedToolDefinition,
  NormalizedToolResultBlock,
} from './types';
import { lookupModelMaxOutput, normalizeStopReason } from './types';

const MODEL_MAX_OUTPUT: Record<string, number> = {
  'gpt-5.4-mini': 16384,
  'gpt-5.4-nano': 8192,
  'gpt-5.4': 32768,
  'gpt-5-mini': 16384,
  'gpt-5-nano': 8192,
  'gpt-5': 32768,
};
const OPENAI_MAX_OUTPUT_FALLBACK = 16384;

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{
    type: 'text';
    text: string;
  } | {
    type: 'image_url';
    image_url: {
      url: string;
    };
  }> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  model?: string;
  error?: {
    message?: string;
  };
}

interface OpenAIStreamingChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  model?: string;
  error?: {
    message?: string;
  };
}

export function stringifyToolResultContent(content: NormalizedToolResultBlock['content'] | string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') {
      console.warn('[OpenAI] Image content in tool result degraded to placeholder — OpenAI does not support image tool results. Visual reasoning is unavailable for this provider.');
      return `[image:${block.source.media_type}]`;
    }
    return '';
  }).join('\n');
}

export function toOpenAIMessages(messages: NormalizedMessage[], instructions: string): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  if (instructions) out.push({ role: 'system', content: instructions });

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((block): block is Extract<NormalizedMessageContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const toolCalls = msg.content
        .filter((block): block is Extract<NormalizedMessageContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        }));

      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const toolResults = msg.content.filter((block): block is Extract<NormalizedMessageContentBlock, { type: 'tool_result' }> => block.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: stringifyToolResultContent(block.content),
        });
      }
      // Also emit any text blocks that accompanied the tool results — do not drop them
      const textBlocks = msg.content.filter(
        (block): block is Extract<NormalizedMessageContentBlock, { type: 'text' }> => block.type === 'text',
      );
      if (textBlocks.length > 0) {
        const text = textBlocks.map((block) => block.text).join('');
        if (text) out.push({ role: 'user', content: text });
      }
      continue;
    }

    const text = msg.content
      .map((block) => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text };
        if (block.type === 'image') {
          return {
            type: 'image_url' as const,
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          };
        }
        return null;
      })
      .filter((block): block is NonNullable<typeof block> => block !== null);

    if (text.length === 1 && text[0].type === 'text') out.push({ role: 'user', content: text[0].text });
    else if (text.length > 0) out.push({ role: 'user', content: text });
  }

  return out;
}

export function toOpenAITools(tools: NormalizedToolDefinition[]): any[] {
  const normalizeSchema = (schema: any): any => {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(normalizeSchema);

    const out: Record<string, any> = { ...schema };
    if (out.type === 'array' && out.items === undefined) {
      out.items = { type: 'object', additionalProperties: true };
    }
    if (out.properties && typeof out.properties === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(out.properties).map(([key, value]) => [key, normalizeSchema(value)]),
      );
    }
    if (out.items) out.items = normalizeSchema(out.items);
    return out;
  };

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeSchema(tool.input_schema),
    },
  }));
}

async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary === -1) break;
        const rawEvent = buffer.slice(0, boundary);
        const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
        const separatorLen = separatorMatch ? separatorMatch[0].length : 2;
        buffer = buffer.slice(boundary + separatorLen);

        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());

        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        if (data === '[DONE]') return;
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenAIProviderClient implements ProviderClient {
  readonly provider = 'openai' as const;
  readonly supportsHarnessGeneration = true as const;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'gpt-5.4') {
    this.apiKey = apiKey;
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
    const instructions = [staticPrompt, dynamicPrompt].filter(Boolean).join('\n\n');
    const body: Record<string, any> = {
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(messages, instructions),
      ...(tools.length > 0 ? { tools: toOpenAITools(tools), tool_choice: 'auto', parallel_tool_calls: true } : {}),
    };

    const maxTokens = options?.maxTokens ?? lookupModelMaxOutput(this.model, MODEL_MAX_OUTPUT, OPENAI_MAX_OUTPUT_FALLBACK);
    body.max_tokens = maxTokens;

    const response = await retryFetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { signal: options?.signal },
    );

    const requestId = response.headers.get('x-request-id');
    if (requestId) console.debug(`[OpenAI] x-request-id: ${requestId}`);

    const contentBlocks: NormalizedAssistantContentBlock[] = [];
    if (!response.ok) {
      const data = await response.json() as OpenAIChatCompletionResponse;
      throw new Error(data.error?.message || `OpenAI request failed (${response.status})`);
    }

    if (!response.body) {
      throw new Error('OpenAI streaming response had no body.');
    }

    let text = '';
    let stopReason = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let reasoningTokens = 0;
    let responseModel = this.model;
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const dataLine of readSseData(response.body)) {
      const chunk = JSON.parse(dataLine) as OpenAIStreamingChunk;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      if (chunk.model) responseModel = chunk.model;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || inputTokens;
        outputTokens = chunk.usage.completion_tokens || outputTokens;
        cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens || cacheReadTokens;
        reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) stopReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onText?.(delta.content);
      }

      for (const toolDelta of delta.tool_calls || []) {
        const index = toolDelta.index ?? 0;
        const existing = toolCalls.get(index) || { id: '', name: '', arguments: '' };
        if (toolDelta.id) existing.id = toolDelta.id;
        if (toolDelta.function?.name) existing.name = toolDelta.function.name;
        if (toolDelta.function?.arguments) existing.arguments += toolDelta.function.arguments;
        toolCalls.set(index, existing);
      }
    }

    if (text) contentBlocks.push({ type: 'text', text });

    for (const [, toolCall] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, any> = {};
      try {
        input = JSON.parse(toolCall.arguments || '{}');
      } catch {
        input = {};
      }
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input,
      });
    }

    const totalInput = inputTokens + cacheReadTokens;
    const cacheHitRate = totalInput > 0 ? ((cacheReadTokens / totalInput) * 100).toFixed(1) : '0.0';
    console.log(`[LLM] ${responseModel} | in=${inputTokens} cache_read=${cacheReadTokens} out=${outputTokens} | cache_hit=${cacheHitRate}% | max_tokens=${maxTokens} | stop=${stopReason}`);

    return {
      content: contentBlocks,
      stopReason: normalizeStopReason(stopReason),
      model: responseModel,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens: 0,
      },
      thinkingText: reasoningTokens > 0 ? `[Reasoning: ~${reasoningTokens} tokens]` : undefined,
    };
  }
}
