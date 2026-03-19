/**
 * Extra Tool Executors — create_document, memory_search, memory_store
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { searchMemory, remember, type MemoryEntry } from '../../db/memory';

const DOCS_DIR = path.join(homedir(), 'Documents', 'Clawdia');

export async function executeCreateDocument(input: Record<string, any>): Promise<string> {
  const { filename, format, content, structured_data, output_dir } = input;
  const dir = output_dir || DOCS_DIR;

  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);

    if (['md', 'txt', 'html'].includes(format)) {
      fs.writeFileSync(filePath, content || '', 'utf-8');
    } else if (['json'].includes(format)) {
      fs.writeFileSync(filePath, JSON.stringify(structured_data || content || {}, null, 2), 'utf-8');
    } else if (['csv'].includes(format)) {
      const data = structured_data || [];
      if (data.length > 0) {
        const headers = Object.keys(data[0]);
        const rows = [headers.join(','), ...data.map((row: any) => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','))];
        fs.writeFileSync(filePath, rows.join('\n'), 'utf-8');
      } else {
        fs.writeFileSync(filePath, content || '', 'utf-8');
      }
    } else {
      fs.writeFileSync(filePath, content || JSON.stringify(structured_data || {}, null, 2), 'utf-8');
      return `[Created ${filePath}] (Note: ${format} format requires additional libraries for full support. File saved as plain text.)`;
    }

    return `[Created ${filePath}]`;
  } catch (err: any) {
    return `[Error creating document]: ${err.message}`;
  }
}

export async function executeMemorySearch(input: Record<string, any>): Promise<string> {
  const { query, limit = 5 } = input;

  try {
    const results = searchMemory(query, limit);
    if (results.length === 0) {
      return `No memories found matching "${query}".`;
    }

    const lines = results.map((r: MemoryEntry) =>
      `[${r.category}] ${r.key}: ${r.value} (confidence: ${r.confidence})`
    );
    return `Found ${results.length} memories:\n${lines.join('\n')}`;
  } catch (err: any) {
    return `[Error searching memory]: ${err.message}`;
  }
}

export async function executeMemoryStore(input: Record<string, any>): Promise<string> {
  const { category, key, value } = input;

  try {
    remember(category, key, value, 'user');
    return `Remembered: [${category}] ${key} = ${value}`;
  } catch (err: any) {
    return `[Error storing memory]: ${err.message}`;
  }
}
