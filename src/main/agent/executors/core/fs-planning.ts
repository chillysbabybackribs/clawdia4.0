import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { normalizeFsPath } from './fs-paths';

const FS_QUOTE_IGNORE = new Set(['node_modules', '.git', '.next', 'dist', '__pycache__', '.cache']);

export async function executeFsFolderSummary(input: Record<string, any>): Promise<string> {
  const dirPath = normalizeFsPath(input.path || input.rootPath);
  const maxDepth = Math.min(Math.max(Number(input.depth) || 2, 1), 6);
  const maxEntries = Math.min(Math.max(Number(input.maxEntries) || 500, 50), 5000);

  if (!dirPath) return '[Error] path is required';
  if (!path.isAbsolute(dirPath)) return '[Error] path must be an absolute path';

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(dirPath);
  } catch (err: any) {
    return `[Error] Cannot access ${dirPath}: ${err.message}`;
  }
  if (!rootStat.isDirectory()) return `[Error] path must be a directory: ${dirPath}`;

  const extensionCounts = new Map<string, number>();
  const topFiles: Array<{ path: string; size: number }> = [];
  const largeDirectories: Array<{ path: string; fileCount: number }> = [];
  const recentFiles: Array<{ path: string; mtimeMs: number }> = [];
  const notes = new Set<string>();

  let totalEntries = 0;
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;

  function pushTopFile(filePath: string, size: number): void {
    topFiles.push({ path: filePath, size });
    topFiles.sort((a, b) => b.size - a.size);
    if (topFiles.length > 8) topFiles.length = 8;
  }

  function pushRecentFile(filePath: string, mtimeMs: number): void {
    recentFiles.push({ path: filePath, mtimeMs });
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (recentFiles.length > 8) recentFiles.length = 8;
  }

  function walk(currentPath: string, depth: number): number {
    if (totalEntries >= maxEntries) return 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err: any) {
      notes.add(`permission denied: ${currentPath}`);
      return 0;
    }

    let localFiles = 0;
    for (const entry of entries) {
      if (totalEntries >= maxEntries) break;
      if (entry.name.startsWith('.')) continue;
      if (FS_QUOTE_IGNORE.has(entry.name)) continue;

      totalEntries += 1;
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        totalDirs += 1;
        if (depth < maxDepth) {
          localFiles += walk(fullPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      totalFiles += 1;
      localFiles += 1;
      try {
        const stat = fs.statSync(fullPath);
        totalBytes += stat.size;
        pushTopFile(fullPath, stat.size);
        pushRecentFile(fullPath, stat.mtimeMs);
        const ext = path.extname(entry.name).toLowerCase() || '[no extension]';
        extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
      } catch (err: any) {
        notes.add(`unreadable file: ${fullPath}`);
      }
    }

    if (currentPath !== dirPath && localFiles > 0) {
      largeDirectories.push({ path: currentPath, fileCount: localFiles });
      largeDirectories.sort((a, b) => b.fileCount - a.fileCount);
      if (largeDirectories.length > 6) largeDirectories.length = 6;
    }

    return localFiles;
  }

  walk(dirPath, 0);

  const topExtensions = [...extensionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  const lines = [
    `[fs_folder_summary] path=${dirPath}`,
    `Scanned ${totalEntries} entries (files=${totalFiles}, directories=${totalDirs}, depth<=${maxDepth}).`,
    `Total file bytes: ${totalBytes}.`,
  ];

  if (totalEntries >= maxEntries) {
    lines.push(`Traversal capped at ${maxEntries} entries.`);
  }

  if (topExtensions.length > 0) {
    lines.push('Top file types:');
    topExtensions.forEach(([ext, count], index) => {
      lines.push(`${index + 1}. ${ext} — ${count} file${count === 1 ? '' : 's'}`);
    });
  }

  if (largeDirectories.length > 0) {
    lines.push('Largest subdirectories by file count:');
    largeDirectories.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.path} — ${item.fileCount} file${item.fileCount === 1 ? '' : 's'}`);
    });
  }

  if (topFiles.length > 0) {
    lines.push('Largest files:');
    topFiles.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.path} — ${item.size} bytes`);
    });
  }

  if (recentFiles.length > 0) {
    lines.push('Most recent files:');
    recentFiles.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.path} — ${new Date(item.mtimeMs).toISOString()}`);
    });
  }

  if (notes.size > 0) {
    lines.push(`Notes: ${[...notes].slice(0, 4).join('; ')}`);
  }

  return lines.join('\n');
}

const FS_REORG_CATEGORY_RULES: Array<{
  bucket: string;
  exts: Set<string>;
  nameHints?: RegExp;
}> = [
  { bucket: 'Images', exts: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.heic']), nameHints: /\b(screenshot|photo|image|img|scan)\b/i },
  { bucket: 'Video', exts: new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']) },
  { bucket: 'Audio', exts: new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']) },
  { bucket: 'Archives', exts: new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']) },
  { bucket: 'PDFs', exts: new Set(['.pdf']) },
  { bucket: 'Notes', exts: new Set(['.md', '.markdown', '.txt']), nameHints: /\b(notes?|readme|summary|outline|draft)\b/i },
  { bucket: 'Data', exts: new Set(['.csv', '.tsv', '.xlsx', '.xls', '.json']) },
  { bucket: 'Code', exts: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.css', '.scss', '.html']) },
  { bucket: 'Documents', exts: new Set(['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.key', '.pages']) },
];

const FS_DOC_STRUCTURE_FOLDERS = new Set([
  'docs', 'doc', 'documentation', 'specs', 'plans', 'guides', 'guide', 'audits', 'audit',
  'summaries', 'summary', 'notes', 'note', 'references', 'reference', 'design', 'designs',
]);

const FS_DOC_ROOT_BUCKET_RULES: Array<{ bucket: string; pattern: RegExp }> = [
  { bucket: 'audits', pattern: /\b(audit|validation|check)\b/i },
  { bucket: 'specs', pattern: /\b(spec|design|architecture|governance)\b/i },
  { bucket: 'plans', pattern: /\b(plan|roadmap|timeline)\b/i },
  { bucket: 'summaries', pattern: /\b(summary|integration|expansion|overview)\b/i },
  { bucket: 'notes', pattern: /\b(note|notes|memo|draft|readme)\b/i },
];

const FS_PROJECT_MARKER_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'vite.config.ts',
  'vite.config.js', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile',
  'README.md', 'README.txt', '.gitignore',
]);

function classifyReorgBucket(filePath: string): { bucket: string; reason: string } | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  for (const rule of FS_REORG_CATEGORY_RULES) {
    if (rule.exts.has(ext)) {
      return { bucket: rule.bucket, reason: `extension ${ext || '[none]'}` };
    }
    if (rule.nameHints?.test(base)) {
      return { bucket: rule.bucket, reason: `filename hint "${base}"` };
    }
  }
  return null;
}

function looksLikeProjectRoot(rootPath: string, files: string[]): boolean {
  const basename = path.basename(rootPath).toLowerCase();
  if (basename === 'src' || basename === 'app' || basename === 'project') return true;

  let markerCount = 0;
  for (const filePath of files) {
    if (path.dirname(filePath) !== rootPath) continue;
    if (FS_PROJECT_MARKER_FILES.has(path.basename(filePath))) markerCount += 1;
  }

  const hasCodeFiles = files.some((filePath) => {
    if (path.dirname(filePath) !== rootPath) return false;
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.html', '.css'].includes(ext);
  });

  return markerCount >= 2 || (markerCount >= 1 && hasCodeFiles);
}

function classifyProjectRootBucket(filePath: string): { bucket: string; reason: string } | null {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (
    base === 'README.md' ||
    base === 'README.txt' ||
    base === 'requirements.txt' ||
    base === 'package.json' ||
    base === 'package-lock.json' ||
    base === 'pnpm-lock.yaml' ||
    base === 'yarn.lock' ||
    base === 'tsconfig.json' ||
    base === 'vite.config.ts' ||
    base === 'vite.config.js' ||
    base === 'pyproject.toml' ||
    base === 'Cargo.toml' ||
    base === 'go.mod' ||
    base === '.gitignore' ||
    ext === '.env'
  ) {
    return { bucket: 'Code', reason: `project marker "${base}"` };
  }

  if (base === 'config.json' || /^config\./i.test(base)) {
    return { bucket: 'Code', reason: `project config "${base}"` };
  }

  return classifyReorgBucket(filePath);
}

function isDocLikeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.md' || ext === '.markdown' || ext === '.txt';
}

function isDocumentationRoot(rootPath: string, files: string[]): boolean {
  const base = path.basename(rootPath).toLowerCase();
  if (FS_DOC_STRUCTURE_FOLDERS.has(base)) return true;

  const docLikeFiles = files.filter(isDocLikeFile).length;
  if (docLikeFiles === 0) return false;

  let structuredDocSubtrees = 0;
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && FS_DOC_STRUCTURE_FOLDERS.has(entry.name.toLowerCase())) {
        structuredDocSubtrees += 1;
      }
    }
  } catch {
    return false;
  }

  return structuredDocSubtrees >= 1;
}

function findProtectedDocumentationSubtree(rootPath: string, filePath: string): string | null {
  const relative = path.relative(rootPath, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length < 2) return null;

  for (let i = 0; i < segments.length - 1; i++) {
    if (!FS_DOC_STRUCTURE_FOLDERS.has(segments[i].toLowerCase())) continue;

    const subtreeSegments = segments.slice(0, i + 1);
    const subtreePath = path.join(rootPath, ...subtreeSegments);
    if (subtreePath !== rootPath) return subtreePath;
  }

  return null;
}

function classifyDocumentationRootBucket(filePath: string): { bucket: string; reason: string } {
  const base = path.basename(filePath);
  for (const rule of FS_DOC_ROOT_BUCKET_RULES) {
    if (rule.pattern.test(base)) {
      return { bucket: rule.bucket, reason: `doc filename hint "${base}"` };
    }
  }
  return { bucket: 'notes', reason: `doc default bucket for "${base}"` };
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function choosePlannedDestination(
  rootPath: string,
  bucket: string,
  sourcePath: string,
  occupied: Set<string>,
): { destination: string; note?: string } {
  const parsed = path.parse(sourcePath);
  let destination = path.join(rootPath, bucket, `${parsed.name}${parsed.ext}`);
  if (!occupied.has(destination)) {
    occupied.add(destination);
    return { destination };
  }

  const parentHint = sanitizeSegment(path.basename(path.dirname(sourcePath)));
  destination = path.join(rootPath, bucket, `${parsed.name}-${parentHint}${parsed.ext}`);
  if (!occupied.has(destination)) {
    occupied.add(destination);
    return { destination, note: 'destination name collision avoided with parent-folder suffix' };
  }

  let counter = 2;
  while (occupied.has(destination)) {
    destination = path.join(rootPath, bucket, `${parsed.name}-${parentHint}-${counter}${parsed.ext}`);
    counter += 1;
  }
  occupied.add(destination);
  return { destination, note: 'destination name collision avoided with numeric suffix' };
}

export async function executeFsReorgPlan(input: Record<string, any>): Promise<string> {
  const rootPath = normalizeFsPath(input.path || input.rootPath);
  const maxDepth = Math.min(Math.max(Number(input.depth) || 3, 1), 6);
  const maxEntries = Math.min(Math.max(Number(input.maxEntries) || 1000, 50), 10000);
  const maxMoves = Math.min(Math.max(Number(input.maxMoves) || 40, 5), 200);

  if (!rootPath) return '[Error] path is required';
  if (!path.isAbsolute(rootPath)) return '[Error] path must be an absolute path';

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootPath);
  } catch (err: any) {
    return `[Error] Cannot access ${rootPath}: ${err.message}`;
  }
  if (!rootStat.isDirectory()) return `[Error] path must be a directory: ${rootPath}`;

  const files: string[] = [];
  const notes = new Set<string>();
  let scannedEntries = 0;
  let truncated = false;

  function walk(currentPath: string, depth: number): void {
    if (truncated || scannedEntries >= maxEntries) {
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      notes.add(`permission denied: ${currentPath}`);
      return;
    }

    for (const entry of entries) {
      if (scannedEntries >= maxEntries) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue;
      if (FS_QUOTE_IGNORE.has(entry.name)) continue;

      scannedEntries += 1;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(fullPath, depth + 1);
        continue;
      }
      if (entry.isFile()) files.push(fullPath);
    }
  }

  walk(rootPath, 0);

  const documentationAware = isDocumentationRoot(rootPath, files);
  const projectAware = !documentationAware && looksLikeProjectRoot(rootPath, files);

  const occupied = new Set<string>();
  for (const filePath of files) occupied.add(filePath);

  const proposedFolders = new Set<string>();
  const plannedMoves: Array<{ source: string; destination: string; bucket: string; reason: string; note?: string }> = [];
  let alreadyAligned = 0;
  let unclassified = 0;
  let preservedStructuredDocs = 0;
  const preservedSubtrees = new Set<string>();

  for (const filePath of files) {
    if (plannedMoves.length >= maxMoves) break;

    if (documentationAware && isDocLikeFile(filePath)) {
      const protectedSubtree = findProtectedDocumentationSubtree(rootPath, filePath);
      if (protectedSubtree) {
        preservedSubtrees.add(protectedSubtree);
        preservedStructuredDocs += 1;
        alreadyAligned += 1;
        continue;
      }
    }

    const classification = documentationAware && isDocLikeFile(filePath)
      ? classifyDocumentationRootBucket(filePath)
      : projectAware
        ? classifyProjectRootBucket(filePath)
        : classifyReorgBucket(filePath);
    if (!classification) {
      unclassified += 1;
      continue;
    }

    const relative = path.relative(rootPath, filePath);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments[0] === classification.bucket) {
      alreadyAligned += 1;
      continue;
    }

    const planned = choosePlannedDestination(rootPath, classification.bucket, filePath, occupied);
    proposedFolders.add(path.join(rootPath, classification.bucket));
    plannedMoves.push({
      source: filePath,
      destination: planned.destination,
      bucket: classification.bucket,
      reason: classification.reason,
      note: planned.note,
    });
  }

  const bucketCounts = new Map<string, number>();
  for (const move of plannedMoves) {
    bucketCounts.set(move.bucket, (bucketCounts.get(move.bucket) || 0) + 1);
  }

  const lines = [
    `[fs_reorg_plan] path=${rootPath}`,
    `Scanned ${scannedEntries} entries and analyzed ${files.length} files (depth<=${maxDepth}).`,
    `Planning only. No files were moved.`,
  ];

  if (documentationAware) {
    lines.push('Mode: documentation-aware; existing semantic subfolders will be preserved.');
  } else if (projectAware) {
    lines.push('Mode: project-aware; project docs and config files stay close to code.');
  }

  if (truncated) lines.push(`Traversal capped at ${maxEntries} entries.`);

  if (proposedFolders.size > 0) {
    lines.push('Proposed folders:');
    [...proposedFolders].sort().forEach((folderPath, index) => {
      lines.push(`${index + 1}. ${folderPath}`);
    });
  }

  if (bucketCounts.size > 0) {
    lines.push('Bucket summary:');
    [...bucketCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([bucket, count], index) => {
        lines.push(`${index + 1}. ${bucket} — ${count} planned move${count === 1 ? '' : 's'}`);
      });
  }

  if (plannedMoves.length > 0) {
    lines.push('Planned moves:');
    plannedMoves.forEach((move, index) => {
      const suffix = move.note ? ` (${move.note})` : '';
      lines.push(`${index + 1}. ${move.source} -> ${move.destination} [${move.bucket}; ${move.reason}]${suffix}`);
    });
  } else {
    lines.push('Planned moves: none. The directory already looks reasonably aligned for the current heuristics.');
  }

  lines.push(`Already aligned: ${alreadyAligned} file${alreadyAligned === 1 ? '' : 's'}.`);
  if (documentationAware) {
    lines.push(`Preserved structured docs: ${preservedStructuredDocs} file${preservedStructuredDocs === 1 ? '' : 's'}.`);
    if (preservedSubtrees.size > 0) {
      lines.push('Protected subtrees:');
      [...preservedSubtrees].sort().forEach((subtreePath, index) => {
        lines.push(`${index + 1}. ${subtreePath}`);
      });
    }
  }
  lines.push(`Unclassified: ${unclassified} file${unclassified === 1 ? '' : 's'}.`);

  if (notes.size > 0) {
    lines.push(`Notes: ${[...notes].slice(0, 4).join('; ')}`);
  }

  lines.push('Recommendation: review the planned moves before applying any filesystem changes.');

  return lines.join('\n');
}

export async function executeFsDuplicateScan(input: Record<string, any>): Promise<string> {
  const rootPath = normalizeFsPath(input.path || input.rootPath);
  const maxDepth = Math.min(Math.max(Number(input.depth) || 4, 1), 8);
  const maxEntries = Math.min(Math.max(Number(input.maxEntries) || 2000, 50), 20000);
  const maxGroups = Math.min(Math.max(Number(input.maxGroups) || 20, 1), 100);

  if (!rootPath) return '[Error] path is required';
  if (!path.isAbsolute(rootPath)) return '[Error] path must be an absolute path';

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(rootPath);
  } catch (err: any) {
    return `[Error] Cannot access ${rootPath}: ${err.message}`;
  }
  if (!rootStat.isDirectory()) return `[Error] path must be a directory: ${rootPath}`;

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const notes = new Set<string>();
  let scannedEntries = 0;
  let truncated = false;

  function walk(currentPath: string, depth: number): void {
    if (truncated || scannedEntries >= maxEntries) {
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      notes.add(`permission denied: ${currentPath}`);
      return;
    }

    for (const entry of entries) {
      if (scannedEntries >= maxEntries) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue;
      if (FS_QUOTE_IGNORE.has(entry.name)) continue;

      scannedEntries += 1;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        notes.add(`unreadable file: ${fullPath}`);
      }
    }
  }

  walk(rootPath, 0);

  const bySize = new Map<number, Array<{ path: string; size: number; mtimeMs: number }>>();
  for (const file of files) {
    const bucket = bySize.get(file.size) || [];
    bucket.push(file);
    bySize.set(file.size, bucket);
  }

  const duplicateGroups: Array<{ hash: string; size: number; files: Array<{ path: string; mtimeMs: number }> }> = [];

  for (const [size, bucket] of bySize.entries()) {
    if (bucket.length < 2) continue;

    const byHash = new Map<string, Array<{ path: string; mtimeMs: number }>>();
    for (const file of bucket) {
      try {
        const hash = createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
        const group = byHash.get(hash) || [];
        group.push({ path: file.path, mtimeMs: file.mtimeMs });
        byHash.set(hash, group);
      } catch {
        notes.add(`hash failed: ${file.path}`);
      }
    }

    for (const [hash, hashedFiles] of byHash.entries()) {
      if (hashedFiles.length < 2) continue;
      hashedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
      duplicateGroups.push({ hash, size, files: hashedFiles });
    }
  }

  duplicateGroups.sort((a, b) => {
    const bytesA = a.size * a.files.length;
    const bytesB = b.size * b.files.length;
    return bytesB - bytesA || b.files.length - a.files.length || a.files[0].path.localeCompare(b.files[0].path);
  });

  const totalDuplicateFiles = duplicateGroups.reduce((sum, group) => sum + group.files.length, 0);
  const duplicateBytes = duplicateGroups.reduce((sum, group) => sum + group.size * (group.files.length - 1), 0);
  const lines = [
    `[fs_duplicate_scan] path=${rootPath}`,
    `Scanned ${scannedEntries} entries and analyzed ${files.length} files (depth<=${maxDepth}).`,
    `Found ${duplicateGroups.length} exact duplicate group${duplicateGroups.length === 1 ? '' : 's'} covering ${totalDuplicateFiles} file${totalDuplicateFiles === 1 ? '' : 's'}.`,
    `Potential reclaimable bytes: ${duplicateBytes}.`,
    'Analysis only. No files were deleted or moved.',
  ];

  if (truncated) lines.push(`Traversal capped at ${maxEntries} entries.`);

  if (duplicateGroups.length > 0) {
    lines.push('Duplicate groups:');
    duplicateGroups.slice(0, maxGroups).forEach((group, index) => {
      lines.push(`${index + 1}. size=${group.size} bytes, copies=${group.files.length}, hash=${group.hash.slice(0, 12)}`);
      group.files.forEach((file, fileIndex) => {
        const tag = fileIndex === 0 ? 'keep candidate' : 'duplicate';
        lines.push(`   - ${file.path} [${tag}; ${new Date(file.mtimeMs).toISOString()}]`);
      });
    });
  } else {
    lines.push('Duplicate groups: none.');
  }

  if (notes.size > 0) {
    lines.push(`Notes: ${[...notes].slice(0, 4).join('; ')}`);
  }

  lines.push('Recommendation: review duplicate groups before removing or archiving any copies.');
  return lines.join('\n');
}

function moveFileWithFallback(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

export async function executeFsApplyPlan(input: Record<string, any>): Promise<string> {
  const rawMoves = Array.isArray(input.moves) ? input.moves : [];
  const overwrite = Boolean(input.overwrite);
  const createDirectories = input.createDirectories !== false;

  if (rawMoves.length === 0) return '[Error] moves is required and must contain at least one move';

  const normalizedMoves: Array<{ source: string; destination: string }> = [];
  for (const [index, move] of rawMoves.entries()) {
    const source = String(move?.source || '').trim();
    const destination = String(move?.destination || '').trim();
    if (!source || !destination) {
      return `[Error] move ${index + 1} must include source and destination`;
    }
    if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
      return `[Error] move ${index + 1} must use absolute source and destination paths`;
    }
    normalizedMoves.push({ source, destination });
  }

  const seenDestinations = new Set<string>();
  for (const move of normalizedMoves) {
    if (move.source === move.destination) {
      return `[Error] source and destination are identical: ${move.source}`;
    }
    if (seenDestinations.has(move.destination)) {
      return `[Error] duplicate destination in plan: ${move.destination}`;
    }
    seenDestinations.add(move.destination);
  }

  const results: Array<{ source: string; destination: string; status: 'moved' | 'skipped' | 'error'; detail?: string }> = [];

  for (const move of normalizedMoves) {
    try {
      const sourceStat = fs.statSync(move.source);
      if (!sourceStat.isFile()) {
        results.push({ source: move.source, destination: move.destination, status: 'error', detail: 'source is not a file' });
        continue;
      }

      if (createDirectories) {
        fs.mkdirSync(path.dirname(move.destination), { recursive: true });
      }

      if (fs.existsSync(move.destination)) {
        if (!overwrite) {
          results.push({ source: move.source, destination: move.destination, status: 'skipped', detail: 'destination exists' });
          continue;
        }
        const destStat = fs.statSync(move.destination);
        if (!destStat.isFile()) {
          results.push({ source: move.source, destination: move.destination, status: 'error', detail: 'destination exists and is not a file' });
          continue;
        }
        fs.unlinkSync(move.destination);
      }

      moveFileWithFallback(move.source, move.destination);
      results.push({ source: move.source, destination: move.destination, status: 'moved' });
    } catch (err: any) {
      results.push({ source: move.source, destination: move.destination, status: 'error', detail: err.message });
    }
  }

  const movedCount = results.filter(r => r.status === 'moved').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;
  const errorCount = results.filter(r => r.status === 'error').length;

  const lines = [
    `[fs_apply_plan] moves=${normalizedMoves.length}`,
    `Applied ${movedCount} move${movedCount === 1 ? '' : 's'} (skipped=${skippedCount}, errors=${errorCount}).`,
  ];

  results.forEach((result, index) => {
    const suffix = result.detail ? ` (${result.detail})` : '';
    lines.push(`${index + 1}. [${result.status}] ${result.source} -> ${result.destination}${suffix}`);
  });

  if (errorCount > 0) {
    lines.push('Recommendation: review errors and rerun with corrected destinations or overwrite settings.');
  }

  return lines.join('\n');
}
