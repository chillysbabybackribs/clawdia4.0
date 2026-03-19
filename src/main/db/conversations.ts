/**
 * Conversations — CRUD operations backed by SQLite.
 * 
 * Each conversation has a list of messages.
 * Messages are stored individually, not as a JSON blob.
 * The agent loop reads/writes the Anthropic-format history from here.
 */

import { randomUUID } from 'crypto';
import { getDb } from './database';

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: string | null;
  created_at: string;
}

// ── Conversations ──

export function createConversation(title?: string): ConversationRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, title || 'New Chat', now, now);

  return { id, title: title || 'New Chat', created_at: now, updated_at: now };
}

export function listConversations(): ConversationRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, title, created_at, updated_at
    FROM conversations
    ORDER BY updated_at DESC
  `).all() as ConversationRow[];
}

export function getConversation(id: string): ConversationRow | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow) || null;
}

export function updateConversationTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, new Date().toISOString(), id);
}

export function deleteConversation(id: string): void {
  const db = getDb();
  // Messages cascade-deleted via FK
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

// ── Messages ──

export function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: any[],
): MessageRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const toolCallsJson = toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null;

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, tool_calls, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, role, content, toolCallsJson, now);

  // Update conversation timestamp
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  // Auto-title: if this is the first user message and title is still default
  if (role === 'user') {
    const conv = getConversation(conversationId);
    if (conv && (conv.title === 'New Chat' || !conv.title)) {
      const autoTitle = content.slice(0, 60) + (content.length > 60 ? '...' : '');
      updateConversationTitle(conversationId, autoTitle);
    }
  }

  return { id, conversation_id: conversationId, role, content, tool_calls: toolCallsJson, created_at: now };
}

export function getMessages(conversationId: string): MessageRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, conversation_id, role, content, tool_calls, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conversationId) as MessageRow[];
}

/**
 * Get messages formatted for the Anthropic API (role + content pairs).
 * This is what gets passed as `history` to the agent loop.
 */
export function getAnthropicHistory(conversationId: string): { role: string; content: string }[] {
  const rows = getMessages(conversationId);
  return rows.map(r => ({
    role: r.role,
    content: r.content,
  }));
}

/**
 * Get messages formatted for the renderer (includes tool_calls, timestamps).
 */
export function getRendererMessages(conversationId: string): {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  toolCalls?: any[];
}[] {
  const rows = getMessages(conversationId);
  return rows.map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    timestamp: new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
  }));
}

/**
 * Get conversation count for display.
 */
export function getMessageCount(conversationId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversationId) as any;
  return row?.cnt || 0;
}
