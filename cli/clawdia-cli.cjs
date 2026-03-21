#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var readline = __toESM(require("readline"));
var import_crypto = require("crypto");
const NO_COLOR = process.argv.includes("--no-color") || !process.stdout.isTTY;
const c = {
  reset: NO_COLOR ? "" : "\x1B[0m",
  bold: NO_COLOR ? "" : "\x1B[1m",
  dim: NO_COLOR ? "" : "\x1B[2m",
  cyan: NO_COLOR ? "" : "\x1B[36m",
  green: NO_COLOR ? "" : "\x1B[32m",
  yellow: NO_COLOR ? "" : "\x1B[33m",
  red: NO_COLOR ? "" : "\x1B[31m",
  magenta: NO_COLOR ? "" : "\x1B[35m",
  blue: NO_COLOR ? "" : "\x1B[34m",
  gray: NO_COLOR ? "" : "\x1B[90m",
  white: NO_COLOR ? "" : "\x1B[97m"
};
function parseArgs(argv) {
  const args = {
    message: null,
    provider: null,
    model: null,
    profile: null,
    unrestricted: false,
    noColor: false,
    conversationId: null,
    newConversation: false,
    quiet: false,
    jsonMode: false,
    help: false
  };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--provider" || arg === "-p") {
      args.provider = argv[++i] || null;
    } else if (arg === "--model" || arg === "-m") {
      args.model = argv[++i] || null;
    } else if (arg === "--profile") {
      args.profile = argv[++i] || null;
    } else if (arg === "--unrestricted") {
      args.unrestricted = true;
    } else if (arg === "--no-color") {
      args.noColor = true;
    } else if (arg === "--conversation" || arg === "-c") {
      args.conversationId = argv[++i] || null;
    } else if (arg === "--new" || arg === "-n") {
      args.newConversation = true;
    } else if (arg === "--quiet" || arg === "-q") {
      args.quiet = true;
    } else if (arg === "--json" || arg === "-j") {
      args.jsonMode = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  if (positional.length > 0) args.message = positional.join(" ");
  return args;
}
function printHelp() {
  console.log(`
${c.bold}${c.cyan}Clawdia CLI${c.reset} ${c.gray}v4.0.0${c.reset}
${c.gray}Your desktop AI agent \u2014 now in your terminal.${c.reset}

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
function emitJson(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
function printBanner() {
  console.log(`
${c.bold}${c.cyan}  \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557      \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557    \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 ${c.reset}
${c.bold}${c.cyan} \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551    \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557${c.reset}
${c.bold}${c.cyan} \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551 \u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551${c.reset}
${c.bold}${c.cyan} \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551${c.reset}
${c.bold}${c.cyan} \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2554\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551${c.reset}
${c.bold}${c.cyan}  \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D \u255A\u2550\u2550\u255D\u255A\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D${c.reset}
${c.gray}  Desktop AI Agent \u2014 CLI  ${c.dim}v4.0.0${c.reset}
`);
}
class Spinner {
  frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  idx = 0;
  timer = null;
  text = "";
  start(text) {
    if (NO_COLOR || !process.stdout.isTTY) return;
    this.text = text;
    this.timer = setInterval(() => {
      process.stdout.write(`\r${c.cyan}${this.frames[this.idx % this.frames.length]}${c.reset} ${c.gray}${this.text}${c.reset}  `);
      this.idx++;
    }, 80);
  }
  update(text) {
    this.text = text;
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stdout.isTTY) process.stdout.write("\r\x1B[K");
  }
}
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.unrestricted) process.env.CLAWDIA_UNRESTRICTED = "1";
  const storeModule = require("../dist/main/store");
  const loopModule = require("../dist/main/agent/loop");
  const conversationsModule = require("../dist/main/db/conversations");
  const databaseModule = require("../dist/main/db/database");
  const policiesModule = require("../dist/main/db/policies");
  const spawnModule = require("../dist/main/agent/agent-spawn-executor");
  const { getApiKey, getSelectedProvider, getSelectedModel } = storeModule;
  const { runAgentLoop } = loopModule;
  const {
    createConversation,
    listConversations,
    getConversation,
    addMessage,
    getAnthropicHistory,
    getRendererMessages
  } = conversationsModule;
  const { getDb } = databaseModule;
  const { seedPolicyProfiles } = policiesModule;
  const { initAgentSpawnExecutor } = spawnModule;
  getDb();
  try {
    seedPolicyProfiles();
  } catch {
  }
  initAgentSpawnExecutor(null);
  const provider = args.provider || process.env.CLAWDIA_PROVIDER || getSelectedProvider();
  const envKeyMap = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY"
  };
  const apiKey = process.env[envKeyMap[provider] || ""] || getApiKey(provider);
  if (!apiKey) {
    console.error(`
${c.red}\u2717 No API key for provider "${provider}".${c.reset}`);
    console.error(`  Set ${c.yellow}${envKeyMap[provider]}${c.reset} in your environment, or configure a key in the Clawdia app.
`);
    process.exit(1);
  }
  const model = args.model || process.env.CLAWDIA_MODEL || getSelectedModel(provider) || void 0;
  let conversationId;
  if (args.conversationId && !args.newConversation) {
    const existing = getConversation(args.conversationId);
    if (!existing) {
      console.error(`${c.red}\u2717 Conversation "${args.conversationId}" not found.${c.reset}`);
      process.exit(1);
    }
    conversationId = args.conversationId;
    if (!args.jsonMode) console.log(`${c.gray}Resuming: ${c.cyan}${conversationId}${c.reset}`);
  } else {
    const title = args.message ? args.message.slice(0, 60) + (args.message.length > 60 ? "\u2026" : "") : "CLI Session";
    const conv = createConversation(title);
    conversationId = conv.id;
    if (args.jsonMode) emitJson({ type: "conversation_id", id: conversationId });
  }
  const taskCtx = { provider, apiKey, model, args, runAgentLoop, addMessage, getAnthropicHistory };
  if (args.message) {
    await runTask(args.message, conversationId, taskCtx);
  } else {
    if (!args.jsonMode) {
      printBanner();
      console.log(`${c.bold}Provider:${c.reset} ${c.cyan}${provider}${c.reset}  ${c.bold}Model:${c.reset} ${c.cyan}${model || "auto"}${c.reset}`);
      if (args.profile) console.log(`${c.bold}Profile:${c.reset} ${c.cyan}${args.profile}${c.reset}`);
      console.log(`${c.gray}Conversation: ${conversationId}${c.reset}`);
      console.log(`${c.dim}Commands: /quit  /clear  /history  /conversations  /id  /help${c.reset}
`);
    }
    await startRepl(conversationId, {
      ...taskCtx,
      getRendererMessages,
      createConversation,
      listConversations
    });
  }
}
async function runTask(message, conversationId, ctx) {
  const { provider, apiKey, model, args, runAgentLoop, addMessage, getAnthropicHistory } = ctx;
  addMessage(conversationId, "user", message);
  const history = getAnthropicHistory(conversationId);
  const spinner = new Spinner();
  let streamBuffer = "";
  let toolCount = 0;
  if (!args.jsonMode && !args.quiet) spinner.start("Thinking\u2026");
  try {
    const result = await runAgentLoop(message, history, {
      provider,
      apiKey,
      model: model || void 0,
      forcedAgentProfile: args.profile || void 0,
      runId: (0, import_crypto.randomUUID)(),
      onStreamText: (text) => {
        if (args.jsonMode) {
          emitJson({ type: "text", text });
          return;
        }
        spinner.stop();
        process.stdout.write(`${c.white}${text}${c.reset}`);
        streamBuffer += text;
      },
      onThinking: (thought) => {
        if (args.jsonMode) {
          emitJson({ type: "thinking", thought });
          return;
        }
        if (!args.quiet) {
          spinner.stop();
          console.log(`${c.dim}${c.magenta}\u{1F4AD} ${thought.slice(0, 120)}\u2026${c.reset}`);
          spinner.start("Thinking\u2026");
        }
      },
      onToolActivity: (activity) => {
        if (args.jsonMode) {
          emitJson({
            type: activity.status === "running" ? "tool_start" : "tool_end",
            name: activity.name,
            status: activity.status,
            detail: activity.detail
          });
          return;
        }
        if (args.quiet) return;
        if (activity.status === "running") {
          toolCount++;
          spinner.stop();
          const detail = activity.detail ? `  ${c.gray}${activity.detail.slice(0, 80)}${c.reset}` : "";
          console.log(`${c.yellow}\u25B6${c.reset} ${c.bold}${activity.name}${c.reset}${detail}`);
          spinner.start(`Running ${activity.name}\u2026`);
        } else if (activity.status === "success") {
          spinner.stop();
          const detail = activity.detail ? `  ${c.gray}${activity.detail.slice(0, 60)}${c.reset}` : "";
          console.log(`${c.green}\u2713${c.reset} ${activity.name}${detail}`);
          spinner.start("Thinking\u2026");
        } else if (activity.status === "error") {
          spinner.stop();
          const detail = activity.detail ? `  ${c.red}${activity.detail.slice(0, 80)}${c.reset}` : "";
          console.log(`${c.red}\u2717${c.reset} ${activity.name}${detail}`);
          spinner.start("Thinking\u2026");
        }
      },
      onStreamEnd: () => {
        spinner.stop();
        if (args.jsonMode) {
          emitJson({ type: "stream_end" });
          return;
        }
        if (streamBuffer && !streamBuffer.endsWith("\n")) process.stdout.write("\n");
      },
      onProgress: (text) => {
        if (!args.jsonMode && !args.quiet) spinner.update(text.slice(0, 60));
      }
    });
    spinner.stop();
    if (result?.response) addMessage(conversationId, "assistant", result.response);
    if (!args.jsonMode) {
      if (!streamBuffer && result?.response) {
        console.log(`
${c.white}${result.response}${c.reset}`);
      }
      if (toolCount > 0 && !args.quiet) {
        console.log(`
${c.dim}\u21B3 ${toolCount} tool call${toolCount !== 1 ? "s" : ""}${c.reset}`);
      }
    }
  } catch (err) {
    spinner.stop();
    if (args.jsonMode) {
      emitJson({ type: "error", message: err?.message || String(err) });
    } else console.error(`
${c.red}\u2717 ${err?.message || err}${c.reset}`);
    throw err;
  }
}
async function startRepl(conversationId, ctx) {
  const { args, getRendererMessages, createConversation, listConversations } = ctx;
  let currentConvId = conversationId;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: `
${c.cyan}${c.bold}you${c.reset}${c.gray} \u203A${c.reset} `
  });
  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "/quit" || input === "/exit" || input === "/q") {
      console.log(`${c.gray}Goodbye.${c.reset}`);
      rl.close();
      process.exit(0);
    }
    if (input === "/id") {
      console.log(`${c.gray}Conversation: ${c.cyan}${currentConvId}${c.reset}`);
      rl.prompt();
      return;
    }
    if (input === "/clear") {
      const conv = createConversation("CLI Session");
      currentConvId = conv.id;
      console.log(`${c.gray}New conversation: ${c.cyan}${currentConvId}${c.reset}`);
      rl.prompt();
      return;
    }
    if (input === "/history") {
      const msgs = getRendererMessages(currentConvId);
      if (!msgs?.length) {
        console.log(`${c.gray}No messages yet.${c.reset}`);
      } else {
        for (const msg of msgs) {
          const role = msg.role === "user" ? `${c.cyan}${c.bold}you${c.reset}` : `${c.magenta}${c.bold}clawdia${c.reset}`;
          const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          console.log(`
${role}: ${c.gray}${content.slice(0, 300)}${content.length > 300 ? "\u2026" : ""}${c.reset}`);
        }
      }
      rl.prompt();
      return;
    }
    if (input === "/conversations") {
      const convs = listConversations();
      if (!convs?.length) {
        console.log(`${c.gray}No conversations.${c.reset}`);
      } else {
        for (const conv of convs.slice(0, 10)) {
          const marker = conv.id === currentConvId ? `${c.cyan}\u25B6 ${c.reset}` : "  ";
          console.log(`${marker}${c.gray}${conv.id.slice(0, 8)}\u2026${c.reset}  ${conv.title || "Untitled"}`);
        }
      }
      rl.prompt();
      return;
    }
    if (input.startsWith("/switch ")) {
      currentConvId = input.slice(8).trim();
      console.log(`${c.gray}Switched to: ${c.cyan}${currentConvId}${c.reset}`);
      rl.prompt();
      return;
    }
    if (input === "/help") {
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
      rl.prompt();
      return;
    }
    rl.pause();
    console.log();
    try {
      await runTask(input, currentConvId, ctx);
    } catch {
    }
    console.log();
    rl.resume();
    rl.prompt();
  });
  rl.on("close", () => {
    console.log(`
${c.gray}Session ended.${c.reset}`);
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log(`
${c.gray}Interrupted. /quit to exit.${c.reset}`);
    rl.prompt();
  });
}
main().catch((err) => {
  console.error(`${c.red}Fatal: ${err?.message || err}${c.reset}`);
  process.exit(1);
});
