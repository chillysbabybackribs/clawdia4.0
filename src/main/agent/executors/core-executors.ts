/**
 * Core Tool Executors — shell_exec, file_read, file_write, file_edit, directory_tree
 *
 * shell_exec uses a PERSISTENT bash process that stays alive across calls.
 * This means `cd`, `export`, aliases, and shell state carry over between
 * tool calls — exactly as the tool description promises the LLM.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import {
  getFilesystemExtraction,
  pruneFilesystemExtractions,
  searchFilesystemExtractions,
  upsertFilesystemExtraction,
} from '../../db/filesystem-extractions';

// ═══════════════════════════════════
// Persistent Shell Process
// ═══════════════════════════════════

let shellProcess: ChildProcess | null = null;
let shellAlive = false;

/** Generate a unique sentinel string to delimit command output. */
function makeSentinel(): string {
  return `__CLAWDIA_DONE_${randomBytes(6).toString('hex')}__`;
}

/** Spawn (or respawn) the persistent bash process. */
function ensureShell(): ChildProcess {
  if (shellProcess && shellAlive) return shellProcess;

  const shellCwd = path.join(os.homedir(), 'Desktop');
  console.log(`[Shell] Spawning persistent bash process (cwd: ${shellCwd})`);
  shellProcess = spawn('bash', ['--norc', '--noprofile', '-i'], {
    cwd: shellCwd,
    env: {
      ...process.env,
      // Disable prompt to avoid PS1 noise in output
      PS1: '',
      PS2: '',
      PROMPT_COMMAND: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  shellAlive = true;

  shellProcess.on('exit', (code) => {
    console.log(`[Shell] Persistent bash exited (code ${code}), will respawn on next call`);
    shellAlive = false;
    shellProcess = null;
  });

  shellProcess.on('error', (err) => {
    console.warn(`[Shell] Persistent bash error: ${err.message}`);
    shellAlive = false;
    shellProcess = null;
  });

  return shellProcess;
}

/** Kill the persistent shell (call on app quit). */
export function destroyShell(): void {
  if (shellProcess) {
    shellProcess.kill('SIGTERM');
    shellProcess = null;
    shellAlive = false;
    console.log('[Shell] Persistent bash destroyed');
  }
}

/**
 * Known GUI app binaries. If a command ends with "&" and starts with one
 * of these, we auto-wrap with setsid + stream redirect so shell_exec returns
 * instantly instead of hanging waiting for the GUI's stderr.
 */
const GUI_APP_BINARIES = new Set([
  'gimp', 'blender', 'inkscape', 'libreoffice', 'soffice', 'audacity', 'obs',
  'kdenlive', 'shotcut', 'vlc', 'spotify', 'firefox', 'chrome', 'chromium',
  'google-chrome', 'thunderbird', 'nautilus', 'thunar', 'dolphin', 'krita',
  'darktable', 'rawtherapee', 'openshot', 'pitivi', 'handbrake', 'steam',
  'telegram-desktop', 'signal-desktop', 'zoom', 'code', 'gedit', 'evince',
  'eog', 'totem', 'rhythmbox', 'transmission-gtk', 'qbittorrent',
]);

function autoDetachGuiCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed.endsWith('&')) return command;
  if (trimmed.includes('setsid') || trimmed.includes('nohup') || trimmed.includes('>/dev/null')) return command;
  const binary = trimmed.replace(/\s*&\s*$/, '').split(/\s+/)[0].toLowerCase();
  if (GUI_APP_BINARIES.has(binary)) {
    const withoutAmp = trimmed.replace(/\s*&\s*$/, '');
    const detached = `setsid ${withoutAmp} >/dev/null 2>&1 &`;
    console.log(`[Shell] Auto-detached GUI launch: "${binary}" → "${detached}"`);
    return detached;
  }
  return command;
}

/**
 * Execute a command in the persistent bash shell.
 *
 * CWD, exports, and aliases persist between calls. The command's stdout
 * and stderr are captured via unique sentinels written after the command
 * completes. This means `cd /project` in one call actually changes the
 * working directory for the next call.
 */
export async function executeShellExec(
  input: Record<string, any>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const { command, timeout = 30 } = input;
  const timeoutMs = Math.min(Number(timeout) || 30, 300) * 1000;

  const finalCommand = autoDetachGuiCommand(command);
  const sentinel = makeSentinel();

  const shell = ensureShell();
  if (!shell.stdin || !shell.stdout || !shell.stderr) {
    return '[Error] Shell process has no stdio';
  }

  return new Promise<string>((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let done = false;
    let exitCode = '0';

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      shell.stdout!.removeListener('data', onStdout);
      shell.stderr!.removeListener('data', onStderr);
    };

    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      // Send Ctrl+C to interrupt the running command, don't kill the shell
      shell.stdin!.write('\x03\n');
      const partial = stdoutChunks.join('').trim() || stderrChunks.join('').trim() || '';
      resolve(`[Timed out after ${timeout}s]\n${partial}`.trim());
    }, timeoutMs);

    const onStdout = (buf: Buffer) => {
      if (done) return;
      const text = buf.toString();

      // Check if this chunk contains our sentinel
      const sentinelIdx = text.indexOf(sentinel);
      if (sentinelIdx !== -1) {
        // Grab any output before the sentinel
        const before = text.slice(0, sentinelIdx);
        if (before) stdoutChunks.push(before);

        // Extract exit code from the line after sentinel: "SENTINEL:CODE"
        const afterSentinel = text.slice(sentinelIdx + sentinel.length);
        const codeMatch = afterSentinel.match(/:(\d+)/);
        if (codeMatch) exitCode = codeMatch[1];

        cleanup();

        const stdout = stdoutChunks.join('').trim();
        const stderr = stderrChunks.join('').trim();
        const code = parseInt(exitCode, 10);

        if (code !== 0 && !stdout && !stderr) {
          resolve(`[Exit ${code}]`);
          return;
        }

        let result = '';
        if (stdout) result += stdout;
        if (stderr) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr;
        if (code !== 0) result = `[Exit ${code}] ${result}`.trimEnd();
        resolve(result || '[No output]');
        return;
      }

      stdoutChunks.push(text);
      if (onChunk) onChunk(text);
    };

    const onStderr = (buf: Buffer) => {
      if (done) return;
      const text = buf.toString();
      stderrChunks.push(text);
      if (onChunk) onChunk(`[stderr] ${text}`);
    };

    shell.stdout!.on('data', onStdout);
    shell.stderr!.on('data', onStderr);

    // Write the command followed by a sentinel echo that includes the exit code.
    // The sentinel on stdout tells us the command is done and what its exit code was.
    shell.stdin!.write(`${finalCommand}\necho "${sentinel}:$?"\n`);
  });
}

export async function executeFileRead(input: Record<string, any>): Promise<string> {
  const { path: filePath, startLine, endLine } = input;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (startLine || endLine) {
      const lines = content.split('\n');
      const start = Math.max(1, startLine || 1) - 1;
      const end = Math.min(lines.length, endLine || lines.length);
      return lines.slice(start, end).join('\n');
    }
    if (content.length > 100_000) {
      return content.slice(0, 100_000) + `\n\n[Truncated — file is ${content.length} bytes. Use startLine/endLine.]`;
    }
    return content;
  } catch (err: any) {
    return `[Error reading ${filePath}]: ${err.message}`;
  }
}

export async function executeFileWrite(input: Record<string, any>): Promise<string> {
  const { path: filePath, content } = input;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `[Written ${content.length} bytes to ${filePath}]`;
  } catch (err: any) {
    return `[Error writing ${filePath}]: ${err.message}`;
  }
}

export async function executeFileEdit(input: Record<string, any>): Promise<string> {
  const { path: filePath, old_str, new_str } = input;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const occurrences = content.split(old_str).length - 1;
    if (occurrences === 0) return `[Error] old_str not found in ${filePath}. Read the file first.`;
    if (occurrences > 1) return `[Error] old_str appears ${occurrences} times. Must appear exactly once.`;
    fs.writeFileSync(filePath, content.replace(old_str, new_str), 'utf-8');
    return `[Edited ${filePath}]`;
  } catch (err: any) {
    return `[Error editing ${filePath}]: ${err.message}`;
  }
}

export async function executeDirectoryTree(input: Record<string, any>): Promise<string> {
  const { path: dirPath, depth = 3 } = input;
  const maxDepth = Math.min(Number(depth) || 3, 10);
  const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', '__pycache__', '.cache']);

  function walk(dir: string, currentDepth: number, prefix: string): string[] {
    if (currentDepth > maxDepth) return [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return [`${prefix}[permission denied]`]; }

    entries = entries
      .filter(e => !e.name.startsWith('.') && !IGNORE.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        lines.push(...walk(path.join(dir, entry.name), currentDepth + 1, prefix + childPrefix));
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
    return lines;
  }

  try {
    return `${dirPath}/\n${walk(dirPath, 0, '').join('\n')}`;
  } catch (err: any) {
    return `[Error listing ${dirPath}]: ${err.message}`;
  }
}

export async function executeFsFolderSummary(input: Record<string, any>): Promise<string> {
  const dirPath = String(input.path || input.rootPath || '').trim();
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
  const rootPath = String(input.path || input.rootPath || '').trim();
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
  const rootPath = String(input.path || input.rootPath || '').trim();
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
  const rootPath = String(input.rootPath || input.path || '').trim();
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
