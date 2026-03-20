/**
 * Filesystem Extractions — persistent extracted text cache for local retrieval.
 *
 * Keeps document text extraction reusable across app restarts so tools like
 * fs_quote_lookup do not need to re-read or re-extract every file every time.
 */

import { getDb } from './database';

export interface FilesystemExtractionRecord {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  extractionType: 'text' | 'pdf' | 'unsupported';
  text: string | null;
  note?: string;
  updatedAt: string;
}

export interface FilesystemExtractionSearchResult extends FilesystemExtractionRecord {
  snippet: string;
  relevanceScore: number;
}

export function getFilesystemExtraction(
  filePath: string,
  sizeBytes: number,
  mtimeMs: number,
): FilesystemExtractionRecord | null {
  const row = getDb().prepare(`
    SELECT *
    FROM filesystem_extractions
    WHERE path = ? AND size_bytes = ? AND mtime_ms = ?
    LIMIT 1
  `).get(filePath, sizeBytes, mtimeMs) as any;

  if (!row) return null;
  return {
    path: row.path,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    extractionType: row.extraction_type,
    text: row.text_content,
    note: row.note || undefined,
    updatedAt: row.updated_at,
  };
}

export function upsertFilesystemExtraction(input: {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  extractionType: 'text' | 'pdf' | 'unsupported';
  text: string | null;
  note?: string;
}): void {
  getDb().prepare(`
    INSERT INTO filesystem_extractions (
      path, size_bytes, mtime_ms, extraction_type, text_content, note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      extraction_type = excluded.extraction_type,
      text_content = excluded.text_content,
      note = excluded.note,
      updated_at = datetime('now')
  `).run(
    input.path,
    input.sizeBytes,
    input.mtimeMs,
    input.extractionType,
    input.text,
    input.note || null,
  );
}

export function pruneFilesystemExtractions(limit = 5000): void {
  getDb().prepare(`
    DELETE FROM filesystem_extractions
    WHERE path IN (
      SELECT path
      FROM filesystem_extractions
      ORDER BY updated_at DESC
      LIMIT -1 OFFSET ?
    )
  `).run(limit);
}

export function searchFilesystemExtractions(
  rootPath: string,
  query: string,
  limit = 10,
): FilesystemExtractionSearchResult[] {
  const db = getDb();
  const normalizedRoot = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  const phraseQuery = `"${query.replace(/"/g, '""')}"`;
  const keywordQuery = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .slice(0, 8)
    .join(' OR ');

  const runSearch = (ftsQuery: string): FilesystemExtractionSearchResult[] => {
    try {
      return db.prepare(`
        SELECT
          e.path,
          e.size_bytes,
          e.mtime_ms,
          e.extraction_type,
          e.text_content,
          e.note,
          e.updated_at,
          snippet(filesystem_extractions_fts, 1, '', '', ' ... ', 18) AS snippet,
          bm25(filesystem_extractions_fts) AS rank
        FROM filesystem_extractions_fts
        JOIN filesystem_extractions e ON e.rowid = filesystem_extractions_fts.rowid
        WHERE filesystem_extractions_fts MATCH ?
          AND (e.path = ? OR e.path LIKE ?)
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, rootPath, `${normalizedRoot}%`, limit) as FilesystemExtractionSearchResult[];
    } catch {
      return [];
    }
  };

  const results = runSearch(phraseQuery);
  if (results.length > 0 || !keywordQuery) {
    return results.map(row => ({
      path: row.path,
      sizeBytes: (row as any).size_bytes,
      mtimeMs: (row as any).mtime_ms,
      extractionType: (row as any).extraction_type,
      text: (row as any).text_content,
      note: (row as any).note || undefined,
      updatedAt: (row as any).updated_at,
      snippet: (row as any).snippet || '',
      relevanceScore: Math.abs(Number((row as any).rank) || 0),
    }));
  }

  return runSearch(keywordQuery).map(row => ({
    path: row.path,
    sizeBytes: (row as any).size_bytes,
    mtimeMs: (row as any).mtime_ms,
    extractionType: (row as any).extraction_type,
    text: (row as any).text_content,
    note: (row as any).note || undefined,
    updatedAt: (row as any).updated_at,
    snippet: (row as any).snippet || '',
    relevanceScore: Math.abs(Number((row as any).rank) || 0),
  }));
}
