/**
 * Classifier — Maps user messages to tool groups + prompt modules.
 * Pure regex, zero LLM cost, zero latency.
 */

import type { AgentProfile } from '../../shared/types';

export type ToolGroup = 'core' | 'browser' | 'full';
export type PromptModule = 'coding' | 'filesystem' | 'research' | 'document' | 'desktop_apps' | 'self_knowledge' | 'browser' | 'bloodhound';
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface TaskProfile {
  agentProfile: AgentProfile;
  toolGroup: ToolGroup;
  promptModules: Set<PromptModule>;
  model: ModelTier;
  isGreeting: boolean;
}

const GREETING_RE = /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)[!?.,]?\s*$/i;
const YTDLP_URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d+|twitch\.tv\/[^\s/]+\/clip\/|tiktok\.com\/@[^/\s]+\/video\/\d+|instagram\.com\/(?:reel|p)\/[A-Za-z0-9_-]+)/i;
const YTDLP_ACTION_RE = /\b(?:download|save|grab|rip)\b/i;
const YTDLP_MEDIA_RE = /\b(?:video|clip|audio|mp3|song|youtube|youtu\.be|vimeo|twitch|reel|reels|shorts|stream|podcast)\b/i;
const YTDLP_EXPLICIT_TOOL_RE = /\b(?:yt-?dlp|youtube-dl)\b/i;
const BLOODHOUND_RE = /\bbloodhound\b|executor designer|build (?:an |a )?executor|design (?:an |a )?executor|automate (?:this|that|the)\b|figure out how to automate|learn (?:this|that|the) (?:site|app|workflow)|create (?:an |a )?(?:playbook|workflow automation)/i;

const BROWSER_RE = /https?:\/\/|search\b|look\s?up|google|browse|find online|navigate to|go to .*(site|page|url)|open.*website|check.*site|what.*price|how much.*cost|latest news|github|gitlab|linkedin|reddit|pull requests?|notifications?|inbox|messages?|saved posts?|review requests?|top rated|reputable sources?|customer reviews?|buying guide|best .* under \$?\d+|compare .* options?/i;
const COORDINATION_RE = /\bagent_spawn\b|\bspawn\b.*\b(agent|sub-agent|worker)s?\b|\bsub-agent\b|\bparallel\b|\bworkers?\b|\bcoordinator\b|\bswarm\b|\bworkstreams?\b/i;

const RESEARCH_RE = /compare|vs\b|best\b|recommend|analyze|report|pricing/i;

const CODING_RE = /(read|write|edit|create|delete|save).*file|src\/|\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|json|yaml|yml|toml|sh|cfg|conf)\b|package\.json|Cargo\.toml|refactor|debug\b|implement|fix.*bug|build\b|compile|npm |pip |cargo |git |\bls |\bcd |\bcat |\bgrep |\bmkdir |\brm |\bchmod |\bsudo /i;
const FILESYSTEM_AGENT_RE = /(?:organize|sort|clean up|tidy|declutter|dedup(?:licate)?|de-dup(?:licate)?|rename|move|copy|archive|scan|audit|summarize|find|locate)\s+(?:my\s+)?(?:files?|folders?|directories|downloads|desktop|documents|pdfs?|images|photos|videos|contracts|invoices|receipts|screenshots)|organize .*?(?:in|into)\s+(?:\/|~\/|desktop|documents|downloads)|rename\s+(?:these|my)?\s*files|clean up\s+(?:my\s+)?(?:desktop|downloads|documents|screenshots)|(?:downloads|desktop|documents|pictures|photos)\s+folder|disk usage|largest files|duplicate files|find .*?(?:pdf|invoice|contract|receipt|screenshot|photo|image|video)|find .*?(?:line|sentence|quote|phrase|string).*?(?:file|source)|(?:which|what) file .*?(?:contains|has|includes)|(?:contains|include|includes).*?(?:line|sentence|quote|phrase).*?(?:file|source)|(?:exact|right|correct)\s+file|(?:move|rename|copy)\s+.*\s+to\s+(?:\/|~\/|desktop|documents|downloads)|(?:folder|directory)\s+structure/i;

const DOCUMENT_RE = /(?:create|generate|make|write|draft|prepare|export).*(?:document|report|spreadsheet|pdf\b|docx|xlsx|csv\b|slides|presentation|memo|letter)|(?:document|report|spreadsheet|slides|presentation).*(?:for|about)/i;

// Expanded to cover: open-source creative apps, proprietary apps, media control,
// GUI interaction phrases, and common desktop actions
const DESKTOP_APP_RE = /gimp|blender|inkscape|libreoffice|audacity|obs\b|kdenlive|shotcut|vlc|firefox|chrome|spotify|discord|slack|steam|figma|zoom|thunderbird|nautilus|thunar|dolphin|terminal|vscode|vs code|visual studio code|sublime|atom|krita|darktable|rawtherapee|openshot|pitivi|handbrake|transmission|qbittorrent|telegram|signal|teams|skype|(launch|open|start|run|control|close|quit|interact).*app|play.*music|pause.*music|next.*track|prev.*track|volume\b|take.*screenshot|click.*button|type.*into|press.*key|dbus\b|xdotool|wmctrl|gui\b.*interact|desktop.*control|window.*manage|list.*windows/i;

const SELF_RE = /clawdia|your (code|source|memory|data|settings|config)|this app|clear (my|your|all) (data|history|memory)|reset/i;

const OPUS_RE = /\bassess\b|evaluate|deep analysis|think carefully|plan.*approach/i;

function isExplicitClaudeCodeInvocation(message: string): boolean {
  return /\b(?:use|run|launch|open|start|invoke|ask|have)\s+claude(?:\s+code|-code)\b/i.test(message)
    || /\bclaude(?:\s+code|-code)\s+(?:to|for)\s+(?:review|inspect|analyze|check|fix|edit|write|run)\b/i.test(message);
}

export function hasStrongYtdlpIntent(message: string): boolean {
  const trimmed = message.trim();
  if (YTDLP_EXPLICIT_TOOL_RE.test(trimmed)) return true;
  if (YTDLP_URL_RE.test(trimmed)) return true;
  return YTDLP_ACTION_RE.test(trimmed) && YTDLP_MEDIA_RE.test(trimmed);
}

export function classify(message: string): TaskProfile {
  const trimmed = message.trim();
  const modules = new Set<PromptModule>();

  // Rule 0: Greetings
  if (GREETING_RE.test(trimmed)) {
    return { agentProfile: 'general', toolGroup: 'core', promptModules: modules, model: 'haiku', isGreeting: true };
  }

  // Rule: ytdlp — clear download/video intent
  if (hasStrongYtdlpIntent(trimmed)) {
    modules.add('browser');
    return { agentProfile: 'ytdlp', toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  const matches = {
    browser: BROWSER_RE.test(trimmed),
    coordination: COORDINATION_RE.test(trimmed),
    bloodhound: BLOODHOUND_RE.test(trimmed),
    coding: CODING_RE.test(trimmed),
    filesystem: FILESYSTEM_AGENT_RE.test(trimmed),
    document: DOCUMENT_RE.test(trimmed),
    desktop: DESKTOP_APP_RE.test(trimmed) || isExplicitClaudeCodeInvocation(trimmed),
    self: SELF_RE.test(trimmed),
    compareReport: RESEARCH_RE.test(trimmed),
  };

  if (matches.browser) modules.add('browser');
  if (matches.bloodhound) modules.add('bloodhound');
  if (matches.coding) modules.add('coding');
  if (matches.filesystem) modules.add('filesystem');
  if (matches.document) modules.add('document');
  if (matches.desktop) modules.add('desktop_apps');
  if (matches.self) modules.add('self_knowledge');

  const agentProfile: AgentProfile = matches.bloodhound
    ? 'bloodhound'
    : matches.filesystem && !matches.desktop
      ? 'filesystem'
      : 'general';

  // Count domain matches for multi-domain detection
  const domainMatches = [
    matches.browser || matches.coordination,
    matches.coding || matches.filesystem,
    matches.document,
    matches.desktop,
    matches.self,
  ]
    .filter(Boolean).length;

  if (matches.coordination) {
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 6: Multi-domain → full
  // Two+ domain signals = cross-domain task, regardless of message length
  if (domainMatches >= 2) {
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  if (matches.bloodhound && !matches.coding && !matches.filesystem && !matches.document && !matches.desktop) {
    modules.add('browser');
    return { agentProfile: 'bloodhound', toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 1: Browser
  if (matches.browser && !matches.coding && !matches.filesystem && !matches.document && !matches.desktop) {
    return { agentProfile, toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 2: Coding or filesystem
  if ((matches.coding || matches.filesystem) && !matches.browser && !matches.document && !matches.desktop) {
    return { agentProfile, toolGroup: 'core', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 3: Document creation
  if (matches.document) {
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 4: Desktop app
  if (matches.desktop) {
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 5: Self-reference
  if (matches.self) {
    return { agentProfile, toolGroup: 'core', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Model override: opus for deep analysis
  let model: ModelTier = 'sonnet';
  if (OPUS_RE.test(trimmed)) model = 'opus';
  // Simple factual → haiku
  if (trimmed.length < 50 && trimmed.includes('?') && !matches.browser && !matches.coding && !matches.filesystem) {
    model = 'haiku';
  }

  // Rule 7: Default → full
  return { agentProfile, toolGroup: 'full', promptModules: modules, model, isGreeting: false };
}
