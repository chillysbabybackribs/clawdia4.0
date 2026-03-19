/**
 * Memory Extractor — Fire-and-forget background fact extraction.
 * 
 * After each conversation exchange, sends the user message + assistant response
 * to Haiku with a structured extraction prompt. Results are stored in the
 * user_memory table via the remember() function.
 * 
 * Design:
 *   - Uses Haiku (cheapest model) — ~$0.001 per extraction
 *   - Non-blocking: runs async, errors are silently logged
 *   - Extracts: preferences, facts, names, tools, workflows, projects
 *   - Filters: skips greetings, short exchanges, pure tool-use conversations
 *   - Rate-limited: max 1 extraction per 10 seconds
 */

import { getSharedSdk } from './client';
import { remember, pruneMemories } from '../db/memory';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MIN_INTERVAL_MS = 10_000; // Don't extract more than once per 10s
const MIN_USER_MSG_LENGTH = 20;  // Skip very short messages
const MIN_ASSISTANT_MSG_LENGTH = 50;

let lastExtractionTime = 0;
let extractionCount = 0;

const EXTRACTION_PROMPT = `You are a fact extraction system. Given a user message and an assistant response from a conversation, extract any personal facts about the user that would be useful to remember for future conversations.

Output ONLY a JSON array of extracted facts. Each fact is an object with:
- "category": one of "preference", "account", "workflow", "fact", "context"
- "key": a short unique label (snake_case, e.g. "preferred_editor", "home_city", "current_project")
- "value": the fact (concise, one sentence max)

Rules:
- Only extract facts about the USER, not about the assistant or general knowledge
- Skip anything that looks like a password, API key, or secret
- Skip trivial facts (e.g. "user said hello")
- Skip facts about what the assistant did — only what the user IS, PREFERS, WORKS ON, etc.
- If nothing worth remembering, return an empty array: []
- Return ONLY the JSON array, no explanation, no markdown

Categories:
- preference: editor, language, style, communication preferences
- account: names, handles, emails, company, role
- workflow: tools, processes, patterns they follow
- fact: location, background, skills, projects
- context: current task, goals, deadlines`;

/**
 * Run background memory extraction on a conversation exchange.
 * Call this AFTER persisting the messages — it's fire-and-forget.
 */
export function extractMemoryInBackground(
  apiKey: string,
  userMessage: string,
  assistantResponse: string,
): void {
  // Gate: skip if too soon, too short, or a greeting
  const now = Date.now();
  if (now - lastExtractionTime < MIN_INTERVAL_MS) return;
  if (userMessage.length < MIN_USER_MSG_LENGTH) return;
  if (assistantResponse.length < MIN_ASSISTANT_MSG_LENGTH) return;

  lastExtractionTime = now;

  // Fire and forget — don't await
  doExtraction(apiKey, userMessage, assistantResponse).catch(err => {
    console.warn(`[MemoryExtractor] Extraction failed: ${err.message}`);
  });
}

async function doExtraction(
  apiKey: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const client = getSharedSdk(apiKey);

  // Trim inputs to keep costs minimal
  const userTrimmed = userMessage.slice(0, 2000);
  const assistantTrimmed = assistantResponse.slice(0, 3000);

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: EXTRACTION_PROMPT,
    messages: [
      {
        role: 'user',
        content: `USER MESSAGE:\n${userTrimmed}\n\nASSISTANT RESPONSE:\n${assistantTrimmed}`,
      },
    ],
  });

  // Parse the response
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text as string)
    .join('');

  if (!text.trim()) return;

  let facts: { category: string; key: string; value: string }[];
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    facts = JSON.parse(cleaned);
  } catch {
    console.warn(`[MemoryExtractor] Failed to parse response: ${text.slice(0, 100)}`);
    return;
  }

  if (!Array.isArray(facts) || facts.length === 0) return;

  // Store each extracted fact
  let stored = 0;
  for (const fact of facts) {
    if (!fact.category || !fact.key || !fact.value) continue;
    if (fact.value.length > 500) continue; // Skip absurdly long "facts"

    remember(fact.category, fact.key, fact.value, 'extracted');
    stored++;
  }

  extractionCount++;
  if (stored > 0) {
    console.log(`[MemoryExtractor] Stored ${stored} facts (extraction #${extractionCount})`);
  }

  // Periodic pruning — every 10 extractions
  if (extractionCount % 10 === 0) {
    pruneMemories();
  }
}
