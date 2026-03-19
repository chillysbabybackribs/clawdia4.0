/**
 * Conversation Recall — Semantic cross-conversation memory.
 *
 * Unlike the auto-injected memory system, recall is demand-driven:
 *   1. Triggered when the user's message has semantic overlap with past conversations
 *   2. Triggered explicitly by user signals ("we discussed", "remember when", "like before")
 *   3. Available as a tool the LLM can call proactively
 *
 * The recall returns CONTEXT, not cached answers — the LLM uses prior
 * knowledge to inform a better new response, not to repeat itself.
 *
 * Design:
 *   - FTS5 on user messages (migration v6) for fast keyword search
 *   - Returns conversation snippets (user Q + assistant A), not full transcripts
 *   - Deduped against current conversation ID (don't recall yourself)
 *   - Capped at ~800 tokens of context to avoid prompt bloat
 *   - Only surfaces when relevance score crosses a threshold
 */

import { getDb } from './database';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface RecalledExchange {
  conversationId: string;
  conversationTitle: string;
  userMessage: string;
  assistantResponse: string;
  relevanceScore: number;
  timestamp: string;
}

export interface RecallResult {
  triggered: boolean;
  reason: 'semantic' | 'explicit' | 'tool' | 'none';
  exchanges: RecalledExchange[];
  promptBlock: string;  // Ready-to-inject context for the dynamic prompt
}

// ═══════════════════════════════════
// Explicit recall signals — user is referencing past conversations
// ═══════════════════════════════════

const EXPLICIT_RECALL_RE = /\b(?:we (?:discussed|talked about|went over|covered)|you (?:told|showed|helped|suggested|recommended|mentioned)|remember (?:when|that|the)|last time|before (?:when|you)|as (?:I|we) (?:said|mentioned|discussed)|like (?:before|last time)|(?:previous|earlier|past) (?:conversation|chat|session|discussion)|you (?:already )?know (?:my|about|that)|didn'?t (?:we|you) (?:already|just))\b/i;

// ═══════════════════════════════════
// Keyword extraction for FTS queries
// ═══════════════════════════════════

const RECALL_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'my', 'me', 'i', 'you', 'we',
  'can', 'do', 'not', 'this', 'that', 'what', 'how', 'why', 'where',
  'will', 'just', 'now', 'please', 'help', 'want', 'need', 'use', 'get',
  'about', 'your', 'its', 'has', 'have', 'had', 'was', 'were', 'been',
  'some', 'any', 'all', 'more', 'very', 'also', 'than', 'then', 'like',
  'would', 'could', 'should', 'there', 'here', 'when', 'which', 'who',
  'did', 'does', 'are', 'am', 'been', 'being', 'so', 'if', 'no', 'yes',
  // Recall-specific: don't search for the recall trigger words themselves
  'remember', 'discussed', 'talked', 'before', 'last', 'time', 'previous',
  'earlier', 'past', 'conversation', 'chat', 'session', 'already',
  'told', 'showed', 'helped', 'mentioned', 'said',
]);

function extractRecallKeywords(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !RECALL_STOP_WORDS.has(w))
    .slice(0, 10);
}

// ═══════════════════════════════════
// Core recall functions
// ═══════════════════════════════════

/**
 * Search past conversations for exchanges relevant to the current message.
 * Returns matched user messages + their assistant responses from OTHER conversations.
 */
export function searchPastConversations(
  query: string,
  currentConversationId: string | null,
  limit: number = 5,
): RecalledExchange[] {
  const db = getDb();
  const keywords = extractRecallKeywords(query);
  if (keywords.length === 0) return [];

  const ftsQuery = keywords.join(' OR ');

  try {
    // Search user messages via FTS, then grab the assistant response that followed
    const rows = db.prepare(`
      SELECT
        m.conversation_id,
        m.content AS user_content,
        m.created_at,
        c.title AS conv_title,
        (
          SELECT content FROM messages
          WHERE conversation_id = m.conversation_id
            AND role = 'assistant'
            AND created_at > m.created_at
          ORDER BY created_at ASC
          LIMIT 1
        ) AS assistant_content,
        rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
        AND m.role = 'user'
        ${currentConversationId ? 'AND m.conversation_id != ?' : ''}
      ORDER BY rank
      LIMIT ?
    `).all(
      ...(currentConversationId
        ? [ftsQuery, currentConversationId, limit]
        : [ftsQuery, limit]),
    ) as Array<{
      conversation_id: string;
      user_content: string;
      created_at: string;
      conv_title: string;
      assistant_content: string | null;
      rank: number;
    }>;

    return rows
      .filter(r => r.assistant_content) // Only include exchanges with a response
      .map(r => ({
        conversationId: r.conversation_id,
        conversationTitle: r.conv_title || 'Untitled',
        userMessage: r.user_content.slice(0, 300),
        assistantResponse: r.assistant_content!.slice(0, 500),
        relevanceScore: Math.abs(r.rank), // FTS5 rank is negative, lower = better
        timestamp: r.created_at,
      }));
  } catch (err) {
    console.warn(`[Recall] FTS search failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Determine if recall should trigger and build the context block.
 *
 * Returns a RecallResult with:
 *   - triggered: whether recall found relevant context
 *   - reason: what triggered the recall
 *   - exchanges: the matched past exchanges
 *   - promptBlock: formatted text ready for injection into the dynamic prompt
 */
export function checkRecall(
  userMessage: string,
  currentConversationId: string | null,
): RecallResult {
  const noRecall: RecallResult = {
    triggered: false,
    reason: 'none',
    exchanges: [],
    promptBlock: '',
  };

  // Skip very short messages
  if (userMessage.length < 15) return noRecall;

  // Check for explicit recall signals first
  const isExplicit = EXPLICIT_RECALL_RE.test(userMessage);

  // Search past conversations
  const exchanges = searchPastConversations(
    userMessage,
    currentConversationId,
    isExplicit ? 5 : 3, // More results for explicit recall
  );

  if (exchanges.length === 0) return noRecall;

  // For semantic (non-explicit) recall, apply a relevance threshold.
  // FTS5 rank values vary, but we only want high-confidence matches
  // for unprompted recall. Explicit recall always triggers.
  const filtered = isExplicit
    ? exchanges
    : exchanges.filter(e => e.relevanceScore < 15); // Lower rank = better match

  if (filtered.length === 0) return noRecall;

  // Build the prompt block — compact, informative, not overwhelming
  const lines: string[] = ['[Previous conversation context]'];
  lines.push(isExplicit
    ? 'The user is referencing past conversations. Here is relevant context:'
    : 'Related context from past conversations (use to inform your response, do not repeat verbatim):',
  );

  for (const ex of filtered.slice(0, 3)) {
    lines.push('');
    lines.push(`── ${ex.conversationTitle} (${new Date(ex.timestamp).toLocaleDateString()}) ──`);
    lines.push(`User: ${ex.userMessage}`);
    lines.push(`Assistant: ${ex.assistantResponse}`);
  }

  // Hard cap at ~800 tokens (~3200 chars)
  let promptBlock = lines.join('\n');
  if (promptBlock.length > 3200) {
    promptBlock = promptBlock.slice(0, 3200) + '\n...';
  }

  return {
    triggered: true,
    reason: isExplicit ? 'explicit' : 'semantic',
    exchanges: filtered,
    promptBlock,
  };
}
