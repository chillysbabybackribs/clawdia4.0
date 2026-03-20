import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execAsync } from './shared';

/** Resolve path to screenshot-analyzer.py (works in dev + packaged builds). */
export function getAnalyzerPath(): string {
  // Packaged: electron-builder copies .py files to resources/gui/ via extraResources
  const resourcePath = path.join(process.resourcesPath, 'gui', 'screenshot-analyzer.py');
  if (fs.existsSync(resourcePath)) return resourcePath;
  // Dev: __dirname is dist/main/agent/executors/desktop — traverse up to project root, then into src
  const projectRoot = path.join(__dirname, '..', '..', '..', '..', '..');
  const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py');
  if (fs.existsSync(srcPath)) return srcPath;
  // Final fallback alongside dist
  return path.join(__dirname, '..', '..', 'gui', 'screenshot-analyzer.py');
}

/** Run the screenshot analyzer and return parsed JSON or null. */
export async function runScreenshotAnalyzer(
  imagePath: string,
  opts: { title?: string; region?: string } = {},
): Promise<{ summary: string; targets: Array<{ label: string; x: number; y: number }> } | null> {
  const analyzerPath = getAnalyzerPath();
  let cmd = `python3 "${analyzerPath}" --file "${imagePath}"`;
  if (opts.title) cmd += ` --title "${opts.title}"`;
  if (opts.region) cmd += ` --region ${opts.region}`;

  // Use execAsync directly instead of run() to keep stdout and stderr separate.
  // The analyzer writes JSON to stdout and diagnostics to stderr.
  // run() merges them, which breaks JSON.parse().
  let stdout: string;
  try {
    const result = await execAsync(cmd, {
      timeout: 15_000,
      cwd: os.homedir(),
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      maxBuffer: 1024 * 1024 * 2,
    });
    stdout = result.stdout.trim();
    if (result.stderr.trim()) {
      console.log(`[Desktop] OCR analyzer: ${result.stderr.trim()}`);
    }
  } catch (err: any) {
    console.warn(`[Desktop] Screenshot analyzer failed: ${err.message}`);
    return null;
  }

  if (!stdout || stdout.startsWith('[Error]')) {
    console.warn(`[Desktop] Screenshot analyzer returned no output`);
    return null;
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed.error) {
      console.warn(`[Desktop] Screenshot analyzer error: ${parsed.error}`);
      return null;
    }

    // Build compact summary from JSON fields
    const lines: string[] = [];
    if (parsed.window) lines.push(`Window: ${parsed.window}`);
    if (parsed.size) lines.push(`Size: ${parsed.size}`);
    if (parsed.menu) lines.push(`Menu: ${parsed.menu}`);
    if (parsed.dialog) {
      const d = parsed.dialog;
      lines.push(`⚠ DIALOG at (${d.region.join(',')})`);
      if (d.text) lines.push(`Dialog text: ${d.text.slice(0, 200)}`);
    }
    if (parsed.targets?.length > 0) {
      lines.push('Click targets:');
      for (const t of parsed.targets) {
        lines.push(`  "${t.label}" at (${t.x}, ${t.y})`);
      }
    }
    if (parsed.text) {
      // Include OCR text but cap it
      const textPreview = parsed.text.split('\n').slice(0, 15).join('\n');
      lines.push(`OCR text:\n${textPreview}`);
    }
    if (parsed.tokens_est) lines.push(`[~${parsed.tokens_est} tokens]`);

    return {
      summary: lines.join('\n'),
      targets: parsed.targets || [],
    };
  } catch (e) {
    console.warn(`[Desktop] Failed to parse analyzer output: ${stdout.slice(0, 200)}`);
    return null;
  }
}
