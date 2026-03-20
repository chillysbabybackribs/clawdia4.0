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

interface GeminiPart {
  text?: string;
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, any>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response?: Record<string, any>;
  };
}

interface GeminiResponseChunk {
  candidates?: Array<{
    content?: {
      role?: 'user' | 'model';
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
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
      console.warn('[Gemini] Image content in tool result degraded to placeholder — Gemini does not support image tool results. Visual reasoning is unavailable for this provider.');
      return `[image:${block.source.media_type}]`;
    }
    return '';
  }).join('\n');
}

export function maybeJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return { result: value };
  }
}

export function buildToolNameIndex(messages: NormalizedMessage[]): Map<string, string> {
  const out = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        out.set(block.id, block.name);
      }
    }
  }

  return out;
}

export function toGeminiContents(messages: NormalizedMessage[]): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
  const out: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  const toolNameIndex = buildToolNameIndex(messages);

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = msg.content.map((block) => {
        if (block.type === 'text') return { text: block.text };
        if (block.type === 'tool_use') {
          return {
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input || {},
            },
          };
        }
        return {
          text: stringifyToolResultContent(block.content),
        };
      });
      out.push({ role: 'model', parts });
      continue;
    }

    const toolResults = msg.content.filter((block): block is Extract<NormalizedMessageContentBlock, { type: 'tool_result' }> => block.type === 'tool_result');
    if (toolResults.length > 0) {
      out.push({
        role: 'user',
        parts: toolResults.map((block) => ({
          functionResponse: {
            name: toolNameIndex.get(block.tool_use_id) || block.tool_use_id,
            id: block.tool_use_id,
            response: maybeJson(stringifyToolResultContent(block.content)),
          },
        })),
      });
      continue;
    }

    const parts = msg.content
      .filter((block): block is Extract<NormalizedMessageContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => ({ text: block.text }));
    out.push({ role: 'user', parts });
  }

  return out;
}

export function toGeminiTools(tools: NormalizedToolDefinition[]): any[] {
  const normalizeSchema = (schema: any): any => {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(normalizeSchema);

    const out: Record<string, any> = { ...schema };
    // Gemini does not support additionalProperties — remove it
    delete out.additionalProperties;
    if (out.type === 'array' && out.items === undefined) {
      out.items = { type: 'string' };
    }
    if (out.properties && typeof out.properties === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(out.properties).map(([key, value]) => [key, normalizeSchema(value)]),
      );
    }
    if (out.items) out.items = normalizeSchema(out.items);
    return out;
  };

  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: normalizeSchema(tool.input_schema),
    })),
  }];
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
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
        buffer = buffer.slice(boundary + separator.length);
        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        yield dataLines.join('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class GeminiProviderClient implements ProviderClient {
  readonly provider = 'gemini' as const;
  readonly supportsHarnessGeneration = false as const;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-2.5-flash') {
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
      contents: toGeminiContents(messages),
      ...(instructions ? { systemInstruction: { parts: [{ text: instructions }] } } : {}),
      ...(tools.length > 0 ? { tools: toGeminiTools(tools) } : {}),
    };

    if (options?.maxTokens) {
      body.generationConfig = { maxOutputTokens: options.maxTokens };
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as GeminiResponseChunk;
      throw new Error(data.error?.message || `Gemini request failed (${response.status})`);
    }
    if (!response.body) throw new Error('Gemini streaming response had no body.');

    let text = '';
    let stopReason = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    let responseModel = this.model;
    // Use an ordered array keyed by a monotonically-increasing call counter that
    // spans ALL streaming chunks. Gemini resets part.index per-chunk, so using the
    // chunk-local forEach index as a Map key causes tool calls in separate chunks
    // to overwrite each other. The callCount below never resets within a response.
    const toolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];
    let callCount = 0;

    for await (const dataLine of readSseData(response.body)) {
      if (!dataLine) continue;
      const chunk = JSON.parse(dataLine) as GeminiResponseChunk;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      if (chunk.modelVersion) responseModel = chunk.modelVersion;
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount || inputTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount || outputTokens;
      }

      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) stopReason = candidate.finishReason.toLowerCase();

      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          text += part.text;
          onText?.(part.text);
        }
        if (part.functionCall) {
          // Prefer provider-supplied ID. If absent, generate a stable synthetic key
          // using callCount, which is stable across all chunks in this response.
          const stableId = part.functionCall.id || `call:${callCount}`;
          toolCalls.push({
            id: stableId,
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          });
          callCount++;
        }
      }
    }

    const content: NormalizedAssistantContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    for (const toolCall of toolCalls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.args,
      });
    }

    return {
      content,
      stopReason,
      model: responseModel,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
    };
  }
}
