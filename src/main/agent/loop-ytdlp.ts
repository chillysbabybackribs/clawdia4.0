/**
 * Extractor (yt-dlp) Pipeline — nested agent loop that downloads videos for the user.
 *
 * Runs a nested agent loop (max 30 iterations, 10 min wall time) that
 * uses browser tools to find video URLs and yt-dlp to download them.
 *
 * Does NOT touch module-level state in loop.ts.
 * Registers its abort fn via onRegisterCancel so cancelLoop() can reach it.
 */

import type { ProviderClient } from './provider/base';
import type {
  NormalizedMessage,
  NormalizedTextBlock,
  NormalizedToolResultBlock,
  NormalizedToolUseBlock,
} from './client';
import { createProviderClient, resolveModelForProvider } from './provider/factory';
import { executeTool, getToolsForGroup } from './tool-builder';

const EXTRACTOR_MAX_ITERATIONS = 30;
const EXTRACTOR_MAX_MS = 10 * 60 * 1000;

/**
 * Regex for parsing EXTRACTOR_SUCCESS sentinels from LLM output.
 * Use `new RegExp(EXTRACTOR_SENTINEL_RE.source, 'g')` when calling exec() in a loop
 * to get a fresh lastIndex each time.
 */
export const EXTRACTOR_SENTINEL_RE = /\[EXTRACTOR_SUCCESS:([^\]]+)\]/g;

/**
 * Parses all [EXTRACTOR_SUCCESS:<path>] sentinels from text.
 * Returns an array of captured paths.
 */
export function parseExtractorSentinels(text: string): string[] {
  const re = new RegExp(EXTRACTOR_SENTINEL_RE.source, 'g');
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    paths.push(m[1]);
  }
  return paths;
}

export interface YtdlpPipelineOptions {
  client: ProviderClient;          // only .provider is read — never mutated
  apiKey: string;
  onProgress: (text: string) => void;
  onRegisterCancel: (fn: () => void) => void;
}

export interface YtdlpResult {
  success: boolean;
  files: string[];
  reason?: string;
}

const EXTRACTOR_SYSTEM_PROMPT = `You are Extractor, a video download agent inside Clawdia.

Your job: use browser tools to find the exact video URL(s) the user wants,
then download them with yt-dlp to ~/Desktop.

Download command: yt-dlp -o "~/Desktop/%(title)s.%(ext)s" <url>

After each download:
1. Read yt-dlp's stdout for the line: [download] Destination: <path>
2. Run: ls "<path>" to confirm the file exists.
3. If confirmed, output exactly: [EXTRACTOR_SUCCESS:<path>]

Rules:
- Never fabricate download results or file paths.
- If yt-dlp fails, read stderr and retry with --format best or a corrected URL.
- If the video requires login, report to the user — do not attempt to fill credentials.
- If geo-blocked, report and suggest the user configure yt-dlp cookies.
- Stop and report clearly if the video is genuinely unavailable.
- When the task is complete, output a plain summary of what was downloaded.`;

const EXTRACTOR_TOOLS = [
  'shell_exec',
  'browser_search', 'browser_navigate', 'browser_read_page',
  'browser_click', 'browser_type', 'browser_extract', 'browser_scroll', 'browser_screenshot',
];

export async function runYtdlpPipeline(
  query: string,
  options: YtdlpPipelineOptions,
): Promise<YtdlpResult> {
  const { client, apiKey, onProgress, onRegisterCancel } = options;

  // Create a fresh client using the same provider — never mutate the passed-in client
  const modelId = resolveModelForProvider(client.provider, 'sonnet');
  const ytdlpClient = createProviderClient(client.provider, apiKey, modelId);

  // Private abort controller — never touches loop.ts module state
  const abortController = new AbortController();
  onRegisterCancel(() => abortController.abort());

  // Build tool schemas by combining core + browser and filtering to EXTRACTOR_TOOLS
  const allTools = [
    ...getToolsForGroup('core'),
    ...getToolsForGroup('browser'),
  ];
  const extractorToolSchemas = allTools.filter(t => EXTRACTOR_TOOLS.includes(t.name));

  const messages: NormalizedMessage[] = [
    {
      role: 'user',
      content: query,
    },
  ];

  const files: string[] = [];
  const startMs = Date.now();

  onProgress('[Extractor] Starting video download pipeline...');

  for (let iteration = 0; iteration < EXTRACTOR_MAX_ITERATIONS; iteration++) {
    if (abortController.signal.aborted) {
      onProgress('[Extractor] Download cancelled.');
      return { success: files.length > 0, files, reason: 'cancelled' };
    }
    if (Date.now() - startMs > EXTRACTOR_MAX_MS) {
      onProgress('[Extractor] Download timed out after 10 minutes.');
      return { success: files.length > 0, files, reason: 'timeout' };
    }

    let response: Awaited<ReturnType<typeof ytdlpClient.chat>>;
    try {
      response = await ytdlpClient.chat(
        messages,
        extractorToolSchemas,
        EXTRACTOR_SYSTEM_PROMPT,
        '',
        (text) => {
          if (text.trim()) onProgress(text);
        },
        { signal: abortController.signal },
      );
    } catch (err: any) {
      if (abortController.signal.aborted) {
        return { success: files.length > 0, files, reason: 'cancelled' };
      }
      console.error(`[Extractor] LLM error at iteration ${iteration}:`, err.message);
      return { success: files.length > 0, files, reason: `LLM error: ${err.message}` };
    }

    const textBlocks = response.content.filter(
      (b): b is NormalizedTextBlock => b.type === 'text',
    );
    const toolUseBlocks = response.content.filter(
      (b): b is NormalizedToolUseBlock => b.type === 'tool_use',
    );
    const responseText = textBlocks.map(b => b.text).join('');

    // Parse any sentinels from text output
    const newFiles = parseExtractorSentinels(responseText);
    for (const f of newFiles) {
      if (!files.includes(f)) {
        files.push(f);
        onProgress(`[Extractor] Downloaded: ${f}`);
      }
    }

    // No tool_use blocks → agent is done
    if (toolUseBlocks.length === 0) {
      const success = files.length > 0;
      if (success) {
        onProgress(`[Extractor] Complete. Downloaded ${files.length} file(s).`);
      } else {
        onProgress(`[Extractor] Agent finished with no files downloaded.`);
      }
      return { success, files };
    }

    // Push assistant content to messages
    messages.push({ role: 'assistant', content: response.content as any });

    // Execute tools sequentially and collect results
    const toolResults: NormalizedToolResultBlock[] = [];
    for (const toolUse of toolUseBlocks) {
      if (!EXTRACTOR_TOOLS.includes(toolUse.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `[Error] Tool "${toolUse.name}" not available in extractor mode.`,
        });
        continue;
      }
      let result: string;
      try {
        const raw = await executeTool(toolUse.name, toolUse.input as any);
        result = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch (err: any) {
        result = `[Error] ${err.message}`;
      }
      console.log(`[Extractor] ${toolUse.name}: ${result.slice(0, 120)}`);

      // Parse sentinels from tool output too (yt-dlp stdout may contain them)
      const toolFiles = parseExtractorSentinels(result);
      for (const f of toolFiles) {
        if (!files.includes(f)) {
          files.push(f);
          onProgress(`[Extractor] Downloaded: ${f}`);
        }
      }

      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    // Push tool results as user message
    messages.push({ role: 'user', content: toolResults as any });
  }

  return { success: false, files, reason: 'iteration limit reached' };
}
