/**
 * User Memory — Persistent fact storage with FTS5 search.
 * 
 * Categories: preference, account, workflow, fact, context
 * Confidence: increments on re-extraction, user-set memories start at 5
 * Source: 'user' (explicit), 'extracted' (auto), 'flush' (batch)
 *
 * Token optimization: getPromptContext only injects memories when FTS5
 * finds actual relevance. High-confidence memories (user-set) are always
 * included but capped at 5. Total injection capped at ~500 tokens.
 */

import { getDb } from './database';

export interface MemoryEntry {
  id: number;
  category: string;
  key: string;
  value: string;
  source: string;
  confidence: number;
  created_at: string;
}

export function remember(
  category: string,
  key: string,
  value: string,
  source: 'user' | 'extracted' = 'extracted',
): void {
  if (!category || !key || !value) return;

  const lower = value.toLowerCase();
  if (lower.includes('password') || lower.includes('api key') || /sk-[a-z0-9]/i.test(value)) return;

  const db = getDb();
  const initialConfidence = source === 'user' ? 5 : 1;

  db.prepare(`
    INSERT INTO user_memory (category, key, value, source, confidence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(category, key) DO UPDATE SET
      value = CASE
        WHEN user_memory.source = 'user' AND excluded.source != 'user'
        THEN user_memory.value
        ELSE excluded.value
      END,
      confidence = user_memory.confidence + 1,
      source = CASE
        WHEN user_memory.source = 'user' AND excluded.source != 'user'
        THEN user_memory.source
        ELSE excluded.source
      END
  `).run(category, key, value, source, initialConfidence);
}

export function recall(category: string, key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM user_memory WHERE category = ? AND key = ?').get(category, key) as any;
  return row?.value || null;
}

export function searchMemory(query: string, limit: number = 5): MemoryEntry[] {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT m.id, m.category, m.key, m.value, m.source, m.confidence, m.created_at
      FROM user_memory_fts fts
      JOIN user_memory m ON m.id = fts.rowid
      WHERE user_memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as MemoryEntry[];
  } catch {
    return db.prepare(`
      SELECT id, category, key, value, source, confidence, created_at
      FROM user_memory
      WHERE key LIKE ? OR value LIKE ?
      ORDER BY confidence DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as MemoryEntry[];
  }
}

export function listMemories(limit: number = 50): MemoryEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, category, key, value, source, confidence, created_at
    FROM user_memory ORDER BY confidence DESC, created_at DESC LIMIT ?
  `).all(limit) as MemoryEntry[];
}

export function forgetById(id: number): void {
  getDb().prepare('DELETE FROM user_memory WHERE id = ?').run(id);
}

export function forget(category: string, key: string): void {
  getDb().prepare('DELETE FROM user_memory WHERE category = ? AND key = ?').run(category, key);
}

/**
 * Build memory context for injection into the dynamic prompt.
 * 
 * Token-optimized strategy:
 *   1. Always include user-set memories (source='user'), capped at 5
 *   2. Only include FTS-matched memories if the query has substantive keywords
 *   3. Skip entirely if nothing matches — zero tokens injected
 *   4. Total output capped at ~500 tokens (~2000 chars)
 */
export function getPromptContext(maxTokens: number = 500, currentMessage?: string): string {
  const db = getDb();
  const entries: MemoryEntry[] = [];

  // 1. Always include user-set memories (explicit "remember this") — these are high-signal
  const userSet = db.prepare(`
    SELECT id, category, key, value, source, confidence, created_at
    FROM user_memory
    WHERE source = 'user'
    ORDER BY confidence DESC
    LIMIT 5
  `).all() as MemoryEntry[];
  entries.push(...userSet);

  // 2. Only do FTS search if the message has enough substance to match
  if (currentMessage && currentMessage.length > 15) {
    // Extract keywords — skip common filler but keep short technical terms
    const STOP_WORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'it', 'my', 'me', 'you', 'we',
      'can', 'do', 'not', 'this', 'that', 'what', 'how', 'why', 'when',
      'will', 'just', 'please', 'help', 'want', 'need', 'use', 'get',
      'about', 'your', 'its', 'has', 'have', 'had', 'was', 'were', 'been',
      'some', 'any', 'all', 'more', 'very', 'also', 'than', 'then',
    ]);
    const keywords = currentMessage
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
      .slice(0, 8); // Max 8 keywords (was 5)

    if (keywords.length > 0) {
      const ftsQuery = keywords.join(' OR ');
      try {
        const relevant = searchMemory(ftsQuery, 3);
        for (const r of relevant) {
          if (!entries.find(e => e.id === r.id)) {
            entries.push(r);
          }
        }
      } catch {
        // FTS errors are non-fatal
      }
    }
  }

  if (entries.length === 0) return '';

  // Format concisely — every char counts
  const lines = entries.map(e => `- ${e.key}: ${e.value}`);
  let context = '[User context]\n' + lines.join('\n');

  // Hard cap at maxTokens * 4 chars (~500 tokens = ~2000 chars)
  const charCap = maxTokens * 4;
  if (context.length > charCap) {
    context = context.slice(0, charCap) + '\n...';
  }

  return context;
}

export function pruneMemories(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM user_memory').get() as any)?.cnt || 0;
  if (count <= 200) return;

  const toDelete = count - 200;
  db.prepare(`
    DELETE FROM user_memory WHERE id IN (
      SELECT id FROM user_memory
      WHERE source != 'user'
      ORDER BY confidence ASC, created_at ASC
      LIMIT ?
    )
  `).run(toDelete);

  console.log(`[Memory] Pruned ${toDelete} low-confidence memories`);
}
