#!/usr/bin/env node
/**
 * Clawdia CLI — Run the full Clawdia agent loop from your terminal.
 *
 * Usage:
 *   clawdia-cli [message]             Single-shot: run one task and exit
 *   clawdia-cli                       Interactive REPL
 *   clawdia-cli --help                Show help
 *
 * Options:
 *   --provider <anthropic|openai|gemini>   LLM provider (default: from settings)
 *   --model <model-id>                     Model ID override
 *   --profile <profile>                    Agent profile override
 *   --unrestricted                         Enable unrestricted mode
 *   --no-color                             Disable color output
 *   --conversation <id>                    Continue existing conversation
 *   --new                                  Force a new conversation
 *   --quiet                                Suppress tool activity output
 *   --json                                 Stream structured JSON events to stdout
 *
 * Examples:
 *   clawdia-cli "what files are in ~/Desktop"
 *   clawdia-cli --provider openai --model gpt-5.4 "explain this codebase"
 *   clawdia-cli --profile analyst
 *   clawdia-cli --json "search the web for news" | jq '.type'
 */

// electron shim is pre-loaded via --require electron-loader.cjs
// All imports below are CommonJS compatible (tsconfig.main.json: "module": "commonjs")

import * as path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import type { ProviderId } from '../src/shared/model-registry';
import type { AgentProfile } from '../src/shared/types';

// ─── Colors ───────────────────────────────────────────────────────────────────
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;

const c = {
  reset:   NO_COLOR ? '' : '\x1b[0m',
  bold:    NO_COLOR ? '' : '\x1b[1m',
  dim:     NO_COLOR ? '' : '\x1b[2m',
  cyan:    NO_COLOR ? '' : '\x1b[36m',
  green:   NO_COLOR ? '' : '\x1b[32m',
  yellow:  NO_COLOR ? '' : '\x1b[33m',
  red:     NO_COLOR ? '' : '\x1b[31m',
  magenta: NO_COLOR ? '' : '\x1b[35m',
  blue:    NO_COLOR ? '' : '\x1b[34m',
  gray:    NO_COLOR ? '' : '\x1b[90m',
  white:   NO_COLOR ? '' : '\x1b[97m',
};

// ─── Args Parsing ─────────────────────────────────────────────────────────────
interface CliArgs {
  message: string | null;
  provider: string | null;
  model: string | null;
  profile: string | null;
  unrestricted: boolean;
  noColor: boolean;
  conversationId: string | null;
  newConversation: boolean;
  quiet: boolean;
  jsonMode: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    message: null, provider: null, model: null, profile: null,
    unrestricted: false, noColor: false, conversationId: null,
    newConversation: false, quiet: false, jsonMode: false, help: false,
  };
  const positional: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; }
    else if (arg === '--provider' || arg === '-p') { args.provider = argv[++i] || null; }
    else if (arg === '--model' || arg === '-m') { args.model = argv[++i] || null; }
    else if (arg === '--profile') { args.profile = argv[++i] || null; }
    else if (arg === '--unrestricted') { args.unrestricted = true; }
    else if (arg === '--no-color') { args.noColor = true; }
    else if (arg === '--conversation' || arg === '-c') { args.conversationId = argv[++i] || null; }
    else if (arg === '--new' || arg === '-n') { args.newConversation = true; }
    else if (arg === '--quiet' || arg === '-q') { args.quiet = true; }
    else if (arg === '--json' || arg === '-j') { args.jsonMode = true; }
    else if (!arg.startsWith('--')) { positional.push(arg); }
  }
  if (positional.length > 0) args.message = positional.join(' ');
  return args;
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function printHelp(): void {
  console.log(`
${c.bold}${c.cyan}Clawdia CLI${c.reset} ${c.gray}v4.0.0${c.reset}
${c.gray}Your desktop AI agent — now in your terminal.${c.reset}

${c.bold}USAGE${c.reset}
  ${c.cyan}clawdia${c.reset} [message]                  Single-shot task
  ${c.cyan}clawdia${c.reset}                            Interactive REPL
  ${c.cyan}clawdia${c.reset} --help                     Show this help

${c.bold}OPTIONS${c.reset}
  ${c.yellow}--provider${c.reset} <anthropic|openai|gemini>   LLM provider
  ${c.yellow}--model${c.reset} <id>                           Model ID override
  ${c.yellow}--profile${c.reset} <profile>                    Agent profile
                               general | filesystem | scout | builder
                               analyst | writer | reviewer | data
                               devops | security | synthesizer
  ${c.yellow}--conversation${c.reset} <id>                    Resume conversation by ID
  ${c.yellow}--new${c.reset}                                  Force new conversation
  ${c.yellow}--unrestricted${c.reset}                         Enable unrestricted mode
  ${c.yellow}--quiet${c.reset} / ${c.yellow}-q${c.reset}                          Suppress tool activity
  ${c.yellow}--json${c.reset} / ${c.yellow}-j${c.reset}                           Emit newline-delimited JSON events
  ${c.yellow}--no-color${c.reset}                             Plain text output

${c.bold}EXAMPLES${c.reset}
  ${c.gray}# Single task${c.reset}
  clawdia "what's in ~/Desktop"

  ${c.gray}# Use a specific model${c.reset}
  clawdia --provider anthropic --model claude-opus-4-6 "review this codebase"

  ${c.gray}# Use analyst profile interactively${c.reset}
  clawdia --profile analyst

  ${c.gray}# JSON output (pipe-friendly)${c.reset}
  clawdia --json "find large files" | jq '.text'

  ${c.gray}# Resume a conversation${c.reset}
  clawdia --conversation <id> "follow up on that"

${c.bold}REPL COMMANDS${c.reset}
  /quit              Exit
  /clear             Start a new conversation
  /history           Show message history
  /conversations     List recent conversations
  /switch <id>       Switch to conversation
  /id                Print current conversation ID
  /help              Show this help

${c.bold}ENVIRONMENT${c.reset}
  ${c.yellow}ANTHROPIC_API_KEY${c.reset}    Override stored Anthropic key
  ${c.yellow}OPENAI_API_KEY${c.reset}       Override stored OpenAI key
  ${c.yellow}GEMINI_API_KEY${c.reset}       Override stored Gemini key
  ${c.yellow}CLAWDIA_DB_PATH${c.reset}      Override SQLite database path
  ${c.yellow}CLAWDIA_PROVIDER${c.reset}     Default provider (env override)
  ${c.yellow}CLAWDIA_MODEL${c.reset}        Default model (env override)
`);
}

// ─── JSON Events ──────────────────────────────────────────────────────────────
type JsonEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thought: string }
  | { type: 'tool_start'; name: string; detail?: string }
  | { type: 'tool_end'; name: string; status: string; detail?: string }
  | { type: 'stream_end' }
  | { type: 'error'; message: string }
  | { type: 'conversation_id'; id: string };

function emitJson(event: JsonEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(): void {
  console.log(`
${c.bold}${c.cyan}  ██████╗██╗      █████╗ ██╗    ██╗██████╗ ██╗ █████╗ ${c.reset}
${c.bold}${c.cyan} ██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗██║██╔══██╗${c.reset}
${c.bold}${c.cyan} ██║     ██║     ███████║██║ █╗ ██║██║  ██║██║███████║${c.reset}
${c.bold}${c.cyan} ██║     ██║     ██╔══██║██║███╗██║██║  ██║██║██╔══██║${c.reset}
${c.bold}${c.cyan} ╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝██║██║  ██║${c.reset}
${c.bold}${c.cyan}  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝ ╚═╝╚═╝  ╚═╝${c.reset}
${c.gray}  Desktop AI Agent — CLI  ${c.dim}v4.0.0${c.reset}
`);
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private text = '';

  start(text: string): void {
    if (NO_COLOR || !process.stdout.isTTY) return;
    this.text = text;
    this.timer = setInterval(() => {
      process.stdout.write(`\r${c.cyan}${this.frames[this.idx % this.frames.length]}${c.reset} ${c.gray}${this.text}${c.reset}  `);
      this.idx++;
    }, 80);
  }

  update(text: string): void { this.text = text; }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }
  if (args.unrestricted) process.env.CLAWDIA_UNRESTRICTED = '1';

  // ── Load main-process modules (electron shim already in place via --require) ──
  const storeModule = require('../dist/main/store');
  const loopModule = require('../dist/main/agent/loop');
  const conversationsModule = require('../dist/main/db/conversations');
  const databaseModule = require('../dist/main/db/database');
  const policiesModule = require('../dist/main/db/policies');
  const spawnModule = require('../dist/main/agent/agent-spawn-executor');

  const { getApiKey, getSelectedProvider, getSelectedModel } = storeModule;
  const { runAgentLoop } = loopModule;
  const {
    createConversation, listConversations, getConversation,
    addMessage, getAnthropicHistory, getRendererMessages,
  } = conversationsModule;
  const { getDb } = databaseModule;
  const { seedPolicyProfiles } = policiesModule;
  const { initAgentSpawnExecutor } = spawnModule;

  // ── Bootstrap ──
  getDb();
  try { seedPolicyProfiles(); } catch {}
  initAgentSpawnExecutor(null);

  // ── Resolve provider + key ──
  const provider = (args.provider || process.env.CLAWDIA_PROVIDER || getSelectedProvider()) as ProviderId;

  const envKeyMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
  };

  const apiKey = process.env[envKeyMap[provider] || ''] || getApiKey(provider);

  if (!apiKey) {
    console.error(`\n${c.red}✗ No API key for provider "${provider}".${c.reset}`);
    console.error(`  Set ${c.yellow}${envKeyMap[provider]}${c.reset} in your environment, or configure a key in the Clawdia app.\n`);
    process.exit(1);
  }

  const model: string | undefined = args.model || process.env.CLAWDIA_MODEL || getSelectedModel(provider) || undefined;

  // ── Conversation ──
  let conversationId: string;

  if (args.conversationId && !args.newConversation) {
    const existing = getConversation(args.conversationId);
    if (!existing) {
      console.error(`${c.red}✗ Conversation "${args.conversationId}" not found.${c.reset}`);
      process.exit(1);
    }
    conversationId = args.conversationId;
    if (!args.jsonMode) console.log(`${c.gray}Resuming: ${c.cyan}${conversationId}${c.reset}`);
  } else {
    const title = args.message ? args.message.slice(0, 60) + (args.message.length > 60 ? '…' : '') : 'CLI Session';
    const conv = createConversation(title);
    conversationId = conv.id;
    if (args.jsonMode) emitJson({ type: 'conversation_id', id: conversationId });
  }

  const taskCtx = { provider, apiKey, model, args, runAgentLoop, addMessage, getAnthropicHistory };

  if (args.message) {
    await runTask(args.message, conversationId, taskCtx);
  } else {
    if (!args.jsonMode) {
      printBanner();
      console.log(`${c.bold}Provider:${c.reset} ${c.cyan}${provider}${c.reset}  ${c.bold}Model:${c.reset} ${c.cyan}${model || 'auto'}${c.reset}`);
      if (args.profile) console.log(`${c.bold}Profile:${c.reset} ${c.cyan}${args.profile}${c.reset}`);
      console.log(`${c.gray}Conversation: ${conversationId}${c.reset}`);
      console.log(`${c.dim}Commands: /quit  /clear  /history  /conversations  /id  /help${c.reset}\n`);
    }
    await startRepl(conversationId, {
      ...taskCtx,
      getRendererMessages, createConversation, listConversations,
    });
  }
}

// ─── Run a Single Task ────────────────────────────────────────────────────────
interface TaskCtx {
  provider: string;
  apiKey: string;
  model?: string;
  args: CliArgs;
  runAgentLoop: Function;
  addMessage: Function;
  getAnthropicHistory: Function;
}

async function runTask(message: string, conversationId: string, ctx: TaskCtx): Promise<void> {
  const { provider, apiKey, model, args, runAgentLoop, addMessage, getAnthropicHistory } = ctx;

  addMessage(conversationId, 'user', message);
  const history = getAnthropicHistory(conversationId);

  const spinner = new Spinner();
  let streamBuffer = '';
  let toolCount = 0;

  if (!args.jsonMode && !args.quiet) spinner.start('Thinking…');

  try {
    const result = await runAgentLoop(message, history, {
      provider,
      apiKey,
      model: model || undefined,
      forcedAgentProfile: (args.profile || undefined) as AgentProfile | undefined,
      runId: randomUUID(),

      onStreamText: (text: string) => {
        if (args.jsonMode) { emitJson({ type: 'text', text }); return; }
        spinner.stop();
        process.stdout.write(`${c.white}${text}${c.reset}`);
        streamBuffer += text;
      },

      onThinking: (thought: string) => {
        if (args.jsonMode) { emitJson({ type: 'thinking', thought }); return; }
        if (!args.quiet) {
          spinner.stop();
          console.log(`${c.dim}${c.magenta}💭 ${thought.slice(0, 120)}…${c.reset}`);
          spinner.start('Thinking…');
        }
      },

      onToolActivity: (activity: { name: string; status: string; detail?: string }) => {
        if (args.jsonMode) {
          emitJson({
            type: activity.status === 'running' ? 'tool_start' : 'tool_end',
            name: activity.name,
            status: activity.status,
            detail: activity.detail,
          } as JsonEvent);
          return;
        }
        if (args.quiet) return;

        if (activity.status === 'running') {
          toolCount++;
          spinner.stop();
          const detail = activity.detail ? `  ${c.gray}${activity.detail.slice(0, 80)}${c.reset}` : '';
          console.log(`${c.yellow}▶${c.reset} ${c.bold}${activity.name}${c.reset}${detail}`);
          spinner.start(`Running ${activity.name}…`);
        } else if (activity.status === 'success') {
          spinner.stop();
          const detail = activity.detail ? `  ${c.gray}${activity.detail.slice(0, 60)}${c.reset}` : '';
          console.log(`${c.green}✓${c.reset} ${activity.name}${detail}`);
          spinner.start('Thinking…');
        } else if (activity.status === 'error') {
          spinner.stop();
          const detail = activity.detail ? `  ${c.red}${activity.detail.slice(0, 80)}${c.reset}` : '';
          console.log(`${c.red}✗${c.reset} ${activity.name}${detail}`);
          spinner.start('Thinking…');
        }
      },

      onStreamEnd: () => {
        spinner.stop();
        if (args.jsonMode) { emitJson({ type: 'stream_end' }); return; }
        if (streamBuffer && !streamBuffer.endsWith('\n')) process.stdout.write('\n');
      },

      onProgress: (text: string) => {
        if (!args.jsonMode && !args.quiet) spinner.update(text.slice(0, 60));
      },
    });

    spinner.stop();

    if (result?.response) addMessage(conversationId, 'assistant', result.response);

    if (!args.jsonMode) {
      if (!streamBuffer && result?.response) {
        console.log(`\n${c.white}${result.response}${c.reset}`);
      }
      if (toolCount > 0 && !args.quiet) {
        console.log(`\n${c.dim}↳ ${toolCount} tool call${toolCount !== 1 ? 's' : ''}${c.reset}`);
      }
    }

  } catch (err: any) {
    spinner.stop();
    if (args.jsonMode) { emitJson({ type: 'error', message: err?.message || String(err) }); }
    else console.error(`\n${c.red}✗ ${err?.message || err}${c.reset}`);
    throw err;
  }
}

// ─── Interactive REPL ─────────────────────────────────────────────────────────
interface ReplCtx extends TaskCtx {
  getRendererMessages: Function;
  createConversation: Function;
  listConversations: Function;
}

async function startRepl(conversationId: string, ctx: ReplCtx): Promise<void> {
  const { args, getRendererMessages, createConversation, listConversations } = ctx;
  let currentConvId = conversationId;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: `\n${c.cyan}${c.bold}you${c.reset}${c.gray} ›${c.reset} `,
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── REPL commands ──
    if (input === '/quit' || input === '/exit' || input === '/q') {
      console.log(`${c.gray}Goodbye.${c.reset}`);
      rl.close(); process.exit(0);
    }
    if (input === '/id') {
      console.log(`${c.gray}Conversation: ${c.cyan}${currentConvId}${c.reset}`);
      rl.prompt(); return;
    }
    if (input === '/clear') {
      const conv = createConversation('CLI Session');
      currentConvId = conv.id;
      console.log(`${c.gray}New conversation: ${c.cyan}${currentConvId}${c.reset}`);
      rl.prompt(); return;
    }
    if (input === '/history') {
      const msgs = getRendererMessages(currentConvId);
      if (!msgs?.length) { console.log(`${c.gray}No messages yet.${c.reset}`); }
      else {
        for (const msg of msgs) {
          const role = msg.role === 'user'
            ? `${c.cyan}${c.bold}you${c.reset}`
            : `${c.magenta}${c.bold}clawdia${c.reset}`;
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          console.log(`\n${role}: ${c.gray}${content.slice(0, 300)}${content.length > 300 ? '…' : ''}${c.reset}`);
        }
      }
      rl.prompt(); return;
    }
    if (input === '/conversations') {
      const convs = listConversations();
      if (!convs?.length) { console.log(`${c.gray}No conversations.${c.reset}`); }
      else {
        for (const conv of convs.slice(0, 10)) {
          const marker = conv.id === currentConvId ? `${c.cyan}▶ ${c.reset}` : '  ';
          console.log(`${marker}${c.gray}${conv.id.slice(0, 8)}…${c.reset}  ${conv.title || 'Untitled'}`);
        }
      }
      rl.prompt(); return;
    }
    if (input.startsWith('/switch ')) {
      currentConvId = input.slice(8).trim();
      console.log(`${c.gray}Switched to: ${c.cyan}${currentConvId}${c.reset}`);
      rl.prompt(); return;
    }
    if (input === '/help') {
      console.log(`
${c.bold}REPL Commands:${c.reset}
  ${c.cyan}/quit${c.reset}              Exit
  ${c.cyan}/clear${c.reset}             New conversation
  ${c.cyan}/history${c.reset}           Message history
  ${c.cyan}/conversations${c.reset}     List conversations
  ${c.cyan}/switch <id>${c.reset}       Switch conversation
  ${c.cyan}/id${c.reset}                Current conversation ID
  ${c.cyan}/help${c.reset}              This help
`);
      rl.prompt(); return;
    }

    // ── Run task ──
    rl.pause();
    console.log();
    try {
      await runTask(input, currentConvId, ctx);
    } catch {
      // error already printed
    }
    console.log();
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${c.gray}Session ended.${c.reset}`);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log(`\n${c.gray}Interrupted. /quit to exit.${c.reset}`);
    rl.prompt();
  });
}

// ─── Entry ────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error(`${c.red}Fatal: ${err?.message || err}${c.reset}`);
  process.exit(1);
});
