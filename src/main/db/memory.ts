/**
 * User Memory — Persistent fact storage with FTS5 search.
 * 
 * Categories: preference, account, workflow, fact, context
 * Confidence: increments on re-extraction, user-set memories start at 5
 * Source: 'user' (explicit), 'extracted' (auto), 'flush' (batch)
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

/**
 * Store a memory. Upserts: if category+key exists, updates value and bumps confidence.
 * User-set memories (source='user') are never overwritten by extracted ones.
 */
export function remember(
  category: string,
  key: string,
  value: string,
  source: 'user' | 'extracted' = 'extracted',
): void {
  if (!category || !key || !value) return;

  // Don't store anything that looks like a secret
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

/**
 * Recall a specific memory by category + key.
 */
export function recall(category: string, key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM user_memory WHERE category = ? AND key = ?').get(category, key) as any;
  return row?.value || null;
}

/**
 * Full-text search across memories. Returns ranked by relevance.
 */
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
    // FTS5 match can fail on malformed queries — fall back to LIKE
    return db.prepare(`
      SELECT id, category, key, value, source, confidence, created_at
      FROM user_memory
      WHERE key LIKE ? OR value LIKE ?
      ORDER BY confidence DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as MemoryEntry[];
  }
}

/**
 * Get all memories, ordered by confidence (highest first).
 */
export function listMemories(limit: number = 50): MemoryEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, category, key, value, source, confidence, created_at
    FROM user_memory
    ORDER BY confidence DESC, created_at DESC
    LIMIT ?
  `).all(limit) as MemoryEntry[];
}

/**
 * Delete a specific memory by ID.
 */
export function forgetById(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM user_memory WHERE id = ?').run(id);
}

/**
 * Delete a memory by category + key.
 */
export function forget(category: string, key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM user_memory WHERE category = ? AND key = ?').run(category, key);
}

/**
 * Build the memory context string for injection into the dynamic prompt.
 * Returns the top memories formatted for the LLM, or empty string if none.
 */
export function getPromptContext(maxTokens: number = 800, currentMessage?: string): string {
  const entries: MemoryEntry[] = [];

  // Always include high-confidence memories
  const db = getDb();
  const highConf = db.prepare(`
    SELECT id, category, key, value, source, confidence, created_at
    FROM user_memory
    WHERE confidence >= 3
    ORDER BY confidence DESC
    LIMIT 15
  `).all() as MemoryEntry[];
  entries.push(...highConf);

  // If there's a current message, also include FTS5-relevant memories
  if (currentMessage && currentMessage.length > 5) {
    try {
      const relevant = searchMemory(currentMessage, 5);
      for (const r of relevant) {
        if (!entries.find(e => e.id === r.id)) {
          entries.push(r);
        }
      }
    } catch {
      // Ignore FTS errors
    }
  }

  if (entries.length === 0) return '';

  const lines = entries.map(e => `- ${e.key}: ${e.value}`);
  let context = '[User context]\n' + lines.join('\n');

  // Rough token estimate: ~4 chars per token
  if (context.length > maxTokens * 4) {
    context = context.slice(0, maxTokens * 4) + '\n...';
  }

  return context;
}

/**
 * Prune low-confidence old memories to stay under 200 total.
 */
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
