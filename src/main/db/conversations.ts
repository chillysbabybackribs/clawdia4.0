/**
 * Conversations — CRUD operations backed by SQLite.
 */

import { randomUUID } from 'crypto';
import { getDb } from './database';
import type { MessageAttachment } from '../../shared/types';
import type { NormalizedImageBlock, NormalizedMessage, NormalizedMessageContentBlock } from '../agent/provider/types';

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
  attachments_json: string | null;
  created_at: string;
}

export function createConversation(title?: string): ConversationRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title || 'New Chat', now, now);
  return { id, title: title || 'New Chat', created_at: now, updated_at: now };
}

export function listConversations(): ConversationRow[] {
  return getDb().prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC').all() as ConversationRow[];
}

export function getConversation(id: string): ConversationRow | null {
  return (getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow) || null;
}

export function updateConversationTitle(id: string, title: string): void {
  getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, new Date().toISOString(), id);
}

export function deleteConversation(id: string): void {
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: any[],
  attachments?: MessageAttachment[],
): MessageRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const toolCallsJson = toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null;
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;

  db.prepare('INSERT INTO messages (id, conversation_id, role, content, tool_calls, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, conversationId, role, content, toolCallsJson, attachmentsJson, now);

  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  if (role === 'user') {
    const conv = getConversation(conversationId);
    if (conv && (conv.title === 'New Chat' || !conv.title)) {
      const titleSource = content.trim() || attachments?.map((attachment) => attachment.name).join(', ') || 'New Chat';
      updateConversationTitle(conversationId, titleSource.slice(0, 60) + (titleSource.length > 60 ? '...' : ''));
    }
  }

  return { id, conversation_id: conversationId, role, content, tool_calls: toolCallsJson, attachments_json: attachmentsJson, created_at: now };
}

export function getMessages(conversationId: string): MessageRow[] {
  return getDb().prepare('SELECT id, conversation_id, role, content, tool_calls, attachments_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as MessageRow[];
}

/**
 * Get messages formatted for the Anthropic API.
 * Return type uses literal union so it's assignable to Anthropic.MessageParam[].
 */
function parseAttachments(row: Pick<MessageRow, 'attachments_json'>): MessageAttachment[] | undefined {
  if (!row.attachments_json) return undefined;
  try {
    const parsed = JSON.parse(row.attachments_json);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toImageBlock(attachment: MessageAttachment): NormalizedImageBlock | null {
  if (attachment.kind !== 'image' || !attachment.dataUrl) return null;
  const match = attachment.dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1] as NormalizedImageBlock['source']['media_type'],
      data: match[2],
    },
  };
}

export function buildUserMessageContent(content: string, attachments?: MessageAttachment[]): string | NormalizedMessageContentBlock[] {
  if (!attachments || attachments.length === 0) return content;

  const blocks: NormalizedMessageContentBlock[] = [];
  const trimmed = content.trim();
  if (trimmed) {
    blocks.push({ type: 'text', text: trimmed });
  }

  const nonImageSummaries: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const imageBlock = toImageBlock(attachment);
      if (imageBlock) blocks.push(imageBlock);
      else nonImageSummaries.push(`Attached image: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`);
      continue;
    }

    let summary = `Attached file: ${attachment.name} (${attachment.mimeType || 'application/octet-stream'}, ${attachment.size} bytes)`;
    if (attachment.textContent) {
      summary += `\nFile contents:\n${attachment.textContent}`;
    }
    nonImageSummaries.push(summary);
  }

  if (nonImageSummaries.length > 0) {
    blocks.push({ type: 'text', text: nonImageSummaries.join('\n\n') });
  }

  if (blocks.length === 0) return content;
  return blocks;
}

export function getAnthropicHistory(conversationId: string): NormalizedMessage[] {
  return getMessages(conversationId).map((r) => {
    const attachments = parseAttachments(r);
    return {
      role: r.role as 'user' | 'assistant',
      content: r.role === 'user' ? buildUserMessageContent(r.content, attachments) : r.content,
    };
  });
}

export function getRendererMessages(conversationId: string): {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  toolCalls?: any[];
}[] {
  return getMessages(conversationId).map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    timestamp: new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    attachments: parseAttachments(r),
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
  }));
}

export function getMessageCount(conversationId: string): number {
  return (getDb().prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(conversationId) as any)?.cnt || 0;
}
