import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeFsPath } from './fs-paths';
import {
  getFilesystemExtraction,
  pruneFilesystemExtractions,
  searchFilesystemExtractions,
  upsertFilesystemExtraction,
} from '../../../db/filesystem-extractions';

const FS_QUOTE_IGNORE = new Set(['node_modules', '.git', '.next', 'dist', '__pycache__', '.cache']);
const FS_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.log', '.html', '.htm', '.xml', '.css', '.scss', '.sql', '.sh',
  '.bash', '.zsh', '.env', '.pdf',
]);
const FS_QUOTE_PARALLELISM = 8;
const extractedTextCache = new Map<string, { text: string | null; extraction: 'text' | 'pdf' | 'unsupported'; note?: string }>();
let extractionWritesSincePrune = 0;

let pdftotextAvailable: boolean | null = null;

function isTextLikeFile(filePath: string): boolean {
  return FS_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildSnippet(text: string, idx: number, length: number): string {
  const start = Math.max(0, idx - 120);
  const end = Math.min(text.length, idx + length + 120);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function collectSearchableFiles(rootPath: string, limit: number): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    if (files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      if (FS_QUOTE_IGNORE.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && isTextLikeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootPath);
  return files;
}

function ensurePdftotext(): boolean {
  if (pdftotextAvailable !== null) return pdftotextAvailable;
  try {
    const check = spawnSync('pdftotext', ['-v'], { encoding: 'utf-8' });
    pdftotextAvailable = !check.error;
  } catch {
    pdftotextAvailable = false;
  }
  return pdftotextAvailable;
}

function extractPdfText(filePath: string): Promise<{ text: string | null; extraction: 'pdf' | 'unsupported'; note?: string }> {
  return new Promise((resolve) => {
    const child = spawn('pdftotext', ['-layout', filePath, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr?.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => resolve({ text: null, extraction: 'unsupported', note: err.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ text: null, extraction: 'unsupported', note: stderr.trim() || `pdftotext exit ${code}` });
        return;
      }
      const text = stdout.trim();
      resolve(text ? { text, extraction: 'pdf' } : { text: null, extraction: 'pdf', note: 'empty pdf text' });
    });
  });
}

async function readSearchableText(filePath: string): Promise<{ text: string | null; extraction: 'text' | 'pdf' | 'unsupported'; note?: string }> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err: any) {
    return { text: null, extraction: 'text', note: err.message };
  }

  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = extractedTextCache.get(cacheKey);
  if (cached) return cached;

  const persisted = getFilesystemExtraction(filePath, stat.size, stat.mtimeMs);
  if (persisted) {
    const result = {
      text: persisted.text,
      extraction: persisted.extractionType,
      note: persisted.note,
    } as const;
    extractedTextCache.set(cacheKey, result);
    return result;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    if (!ensurePdftotext()) {
      return { text: null, extraction: 'unsupported', note: 'pdftotext unavailable' };
    }
    const result = await extractPdfText(filePath);
    extractedTextCache.set(cacheKey, result);
    persistExtraction(filePath, stat, result);
    return result;
  }

  try {
    if (stat.size > 2 * 1024 * 1024) {
      const result = { text: null, extraction: 'text' as const, note: 'file too large' };
      persistExtraction(filePath, stat, result);
      return result;
    }
    const text = await fs.promises.readFile(filePath, 'utf-8');
    const result = { text, extraction: 'text' as const };
    extractedTextCache.set(cacheKey, result);
    persistExtraction(filePath, stat, result);
    return result;
  } catch (err: any) {
    const result = { text: null, extraction: 'text' as const, note: err.message };
    persistExtraction(filePath, stat, result);
    return result;
  }
}

function persistExtraction(
  filePath: string,
  stat: fs.Stats,
  result: { text: string | null; extraction: 'text' | 'pdf' | 'unsupported'; note?: string },
): void {
  try {
    upsertFilesystemExtraction({
      path: filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      extractionType: result.extraction,
      text: result.text,
      note: result.note,
    });
    extractionWritesSincePrune += 1;
    if (extractionWritesSincePrune >= 50) {
      pruneFilesystemExtractions(5000);
      extractionWritesSincePrune = 0;
    }
  } catch {
    // Non-fatal: in-memory cache still provides value for the current session.
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

interface QuoteMatch {
  path: string;
  score: number;
  matchType: 'exact' | 'fuzzy' | 'semantic';
  extraction: 'text' | 'pdf';
  snippet: string;
}

function scoreMatch(query: string, text: string): Omit<QuoteMatch, 'path' | 'extraction'> | null {
  const normalizedQuery = normalizeForSearch(query);
  const normalizedText = normalizeForSearch(text);
  if (!normalizedQuery || !normalizedText) return null;

  const exactIdx = normalizedText.indexOf(normalizedQuery);
  if (exactIdx !== -1) {
    return {
      score: 1,
      matchType: 'exact',
      snippet: buildSnippet(text, Math.min(exactIdx, text.length - 1), query.length),
    };
  }

  const terms = normalizedQuery.split(' ').filter(term => term.length >= 3);
  if (terms.length === 0) return null;

  const matchedTerms = terms.filter(term => normalizedText.includes(term));
  if (matchedTerms.length === 0) return null;

  const ratio = matchedTerms.length / terms.length;
  if (ratio < 0.5) return null;

  const firstTermIdx = normalizedText.indexOf(matchedTerms[0]);
  const snippetIdx = firstTermIdx === -1 ? 0 : firstTermIdx;
  return {
    score: Math.min(0.92, 0.45 + ratio * 0.45),
    matchType: 'fuzzy',
    snippet: buildSnippet(text, Math.min(snippetIdx, text.length - 1), matchedTerms[0].length),
  };
}

const SEMANTIC_STOP_WORDS = new Set([
  'the', 'and', 'that', 'with', 'from', 'this', 'both', 'into', 'their', 'there', 'they',
  'have', 'about', 'would', 'could', 'should', 'where', 'when', 'which', 'while', 'what',
  'your', 'serves', 'serve', 'file', 'files', 'line', 'exact', 'contains', 'containing',
  'show', 'find', 'built',
]);

function tokenizeSemantic(value: string): string[] {
  return normalizeForSearch(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 4 && !SEMANTIC_STOP_WORDS.has(token));
}

function toBigramSet(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function chunkTextForSemanticSearch(text: string): string[] {
  const parts = text
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (parts.length <= 1) return parts.length ? parts : [text];

  const windows: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    windows.push(parts[i]);
    if (i < parts.length - 1) {
      windows.push(`${parts[i]} ${parts[i + 1]}`);
    }
  }
  return windows;
}

function scoreSemanticMatch(query: string, text: string): Omit<QuoteMatch, 'path' | 'extraction'> | null {
  const queryTokens = tokenizeSemantic(query);
  if (queryTokens.length < 2) return null;

  const queryTokenSet = new Set(queryTokens);
  const queryBigramSet = toBigramSet(queryTokens);
  let best: Omit<QuoteMatch, 'path' | 'extraction'> | null = null;

  for (const chunk of chunkTextForSemanticSearch(text)) {
    const chunkTokens = tokenizeSemantic(chunk);
    if (chunkTokens.length === 0) continue;

    const chunkTokenSet = new Set(chunkTokens);
    const matchedTokens = queryTokens.filter(token => chunkTokenSet.has(token));
    const tokenRatio = matchedTokens.length / queryTokenSet.size;
    if (tokenRatio < 0.34) continue;

    const chunkBigramSet = toBigramSet(chunkTokens);
    const matchedBigrams = [...queryBigramSet].filter(bigram => chunkBigramSet.has(bigram)).length;
    const bigramRatio = queryBigramSet.size > 0 ? matchedBigrams / queryBigramSet.size : 0;

    const candidateScore = 0.42 + tokenRatio * 0.34 + bigramRatio * 0.18 + Math.min(0.06, matchedTokens.length * 0.01);
    if (candidateScore < 0.62) continue;

    const snippetAnchor = matchedTokens[0] || queryTokens[0];
    const normalizedChunk = normalizeForSearch(chunk);
    const anchorIdx = normalizedChunk.indexOf(snippetAnchor);
    const snippet = buildSnippet(chunk, Math.max(0, anchorIdx), snippetAnchor.length);
    const candidate: Omit<QuoteMatch, 'path' | 'extraction'> = {
      score: Math.min(0.86, candidateScore),
      matchType: 'semantic',
      snippet,
    };

    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

export async function executeFsQuoteLookup(input: Record<string, any>): Promise<string> {
  const query = String(input.query || '').trim();
  const rootPath = normalizeFsPath(input.rootPath || input.path);
  const maxResults = Math.min(Math.max(Number(input.maxResults) || 5, 1), 10);
  const maxFiles = Math.min(Math.max(Number(input.maxFiles) || 300, 25), 1500);

  if (!query) return '[Error] query is required';
  if (!rootPath) return '[Error] rootPath is required';
  if (!path.isAbsolute(rootPath)) return '[Error] rootPath must be an absolute path';

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootPath);
  } catch (err: any) {
    return `[Error] Cannot access ${rootPath}: ${err.message}`;
  }
  if (!rootStat.isDirectory()) return `[Error] rootPath must be a directory: ${rootPath}`;

  const candidates = collectSearchableFiles(rootPath, maxFiles);
  const notes = new Set<string>();
  let semanticFallbackUsed = false;
  let semanticFallbackCount = 0;
  const indexedMatches = searchFilesystemExtractions(rootPath, query, Math.min(maxResults * 4, 20));
  const indexedMatchMap = new Map<string, QuoteMatch>();

  for (const hit of indexedMatches) {
    const text = hit.text;
    if (!text) continue;
    const scored = scoreMatch(query, text);
    if (!scored) continue;
    indexedMatchMap.set(hit.path, {
      path: hit.path,
      extraction: hit.extractionType === 'unsupported' ? 'text' : hit.extractionType,
      ...scored,
    });
  }

  const exactIndexed = [...indexedMatchMap.values()].filter(match => match.matchType === 'exact');
  if (exactIndexed.length >= maxResults) {
    exactIndexed.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return formatQuoteLookupResult({
      query,
      rootPath,
      scannedCount: 0,
      indexedCount: indexedMatches.length,
      matches: exactIndexed.slice(0, maxResults),
      notes: [],
      semanticFallbackUsed: false,
      semanticFallbackCount: 0,
    });
  }

  const remainingCandidates = candidates.filter(filePath => !indexedMatchMap.has(filePath));
  const processed = await mapWithConcurrency(remainingCandidates, FS_QUOTE_PARALLELISM, async (filePath) => {
    const { text, extraction, note } = await readSearchableText(filePath);
    if (note) return { note, match: null as QuoteMatch | null };
    if (!text || extraction === 'unsupported') return { note: undefined, match: null as QuoteMatch | null };

    const scored = scoreMatch(query, text);
    if (!scored) return { note: undefined, match: null as QuoteMatch | null };

    return {
      note: undefined,
      match: {
        path: filePath,
        extraction,
        ...scored,
      },
    };
  });

  const matches = processed.flatMap((item) => {
    if (item.note) notes.add(item.note);
    return item.match ? [item.match] : [];
  });
  const dedupedMatches = new Map<string, QuoteMatch>();
  for (const match of [...indexedMatchMap.values(), ...matches]) {
    const existing = dedupedMatches.get(match.path);
    if (!existing || match.score > existing.score) {
      dedupedMatches.set(match.path, match);
    }
  }

  let rankedMatches = [...dedupedMatches.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const topScore = rankedMatches[0]?.score || 0;
  const hasExactMatch = rankedMatches.some(match => match.matchType === 'exact');
  if (!hasExactMatch && (rankedMatches.length === 0 || topScore < 0.88)) {
    semanticFallbackUsed = true;
    const semanticMatches = await mapWithConcurrency(candidates, FS_QUOTE_PARALLELISM, async (filePath) => {
      const { text, extraction, note } = await readSearchableText(filePath);
      if (note) return { note, match: null as QuoteMatch | null };
      if (!text || extraction === 'unsupported') return { note: undefined, match: null as QuoteMatch | null };

      const scored = scoreSemanticMatch(query, text);
      if (!scored) return { note: undefined, match: null as QuoteMatch | null };

      return {
        note: undefined,
        match: {
          path: filePath,
          extraction,
          ...scored,
        },
      };
    });

    for (const item of semanticMatches) {
      if (item.note) notes.add(item.note);
      if (!item.match) continue;
      semanticFallbackCount += 1;
      const existing = dedupedMatches.get(item.match.path);
      if (!existing || item.match.score > existing.score) {
        dedupedMatches.set(item.match.path, item.match);
      }
    }

    rankedMatches = [...dedupedMatches.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  return formatQuoteLookupResult({
    query,
    rootPath,
    scannedCount: remainingCandidates.length,
    indexedCount: indexedMatches.length,
    matches: rankedMatches.slice(0, maxResults),
    notes: [...notes],
    semanticFallbackUsed,
    semanticFallbackCount,
  });
}

function formatQuoteLookupResult(input: {
  query: string;
  rootPath: string;
  scannedCount: number;
  indexedCount: number;
  matches: QuoteMatch[];
  notes: string[];
  semanticFallbackUsed: boolean;
  semanticFallbackCount: number;
}): string {
  const lines: string[] = [
    `[fs_quote_lookup] query="${input.query}" root=${input.rootPath}`,
    `Indexed hits: ${input.indexedCount}. Scanned ${input.scannedCount} candidate files with concurrency ${Math.min(FS_QUOTE_PARALLELISM, Math.max(1, input.scannedCount || 1))}.`,
  ];
  if (input.semanticFallbackUsed) {
    lines.push(`Semantic fallback: ${input.semanticFallbackCount} ranked candidate${input.semanticFallbackCount === 1 ? '' : 's'}.`);
  }

  if (input.matches.length === 0) {
    if (input.notes.length > 0) lines.push(`Notes: ${input.notes.slice(0, 3).join('; ')}`);
    lines.push('No matching files found.');
    return lines.join('\n');
  }

  const bestMatch = input.matches[0];
  const bestConfidence = bestMatch.score.toFixed(2);
  lines.push(
    `BEST MATCH: ${bestMatch.path}`,
    `BEST MATCH TYPE: ${bestMatch.matchType}`,
    `BEST MATCH CONFIDENCE: ${bestConfidence}`,
  );
  if (bestMatch.score >= 0.9) {
    lines.push('RECOMMENDATION: Strong winner. If the user only asked to find the file, return this path directly without extra lookup.');
  } else if (bestMatch.score >= 0.8) {
    lines.push('RECOMMENDATION: Good winner. Return this path unless the user explicitly asked for validation or surrounding context.');
  } else {
    lines.push('RECOMMENDATION: Candidate match. If the user needs certainty, verify with one targeted follow-up lookup or read.');
  }

  lines.push(`Found ${input.matches.length} ranked match${input.matches.length === 1 ? '' : 'es'}:`);
  input.matches.forEach((match, index) => {
    lines.push(
      `${index + 1}. ${match.path}`,
      `   type=${match.matchType} extraction=${match.extraction} confidence=${match.score.toFixed(2)}`,
      `   snippet: ${match.snippet.slice(0, 320)}`,
    );
  });

  if (input.notes.length > 0) {
    lines.push(`Notes: ${input.notes.slice(0, 3).join('; ')}`);
  }

  return lines.join('\n');
}
