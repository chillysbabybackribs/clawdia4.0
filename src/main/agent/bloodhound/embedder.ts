/**
 * Bloodhound Embedder — embeds goal text using the best available provider.
 *
 * Tries OpenAI text-embedding-3-small (1536-dim) first, falls back to
 * Gemini text-embedding-004 (768-dim). Throws if neither key is available.
 *
 * Callers must catch and ignore errors — embedding is best-effort.
 */

import { getApiKey } from '../../store';

export async function embedGoal(goal: string): Promise<Float32Array> {
  const openaiKey = getApiKey('openai');
  if (openaiKey) {
    return embedWithOpenAI(goal, openaiKey);
  }

  const geminiKey = getApiKey('gemini');
  if (geminiKey) {
    return embedWithGemini(goal, geminiKey);
  }

  throw new Error('[Bloodhound] No embedding provider available (need OpenAI or Gemini key)');
}

async function embedWithOpenAI(text: string, apiKey: string): Promise<Float32Array> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embedding error ${response.status}: ${err}`);
  }

  const json = await response.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(json.data[0].embedding);
}

async function embedWithGemini(text: string, apiKey: string): Promise<Float32Array> {
  const model = 'text-embedding-004';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini embedding error ${response.status}: ${err}`);
  }

  const json = await response.json() as { embedding: { values: number[] } };
  return new Float32Array(json.embedding.values);
}
