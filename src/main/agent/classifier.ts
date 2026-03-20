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
const BLOODHOUND_RE = /\bbloodhound\b|executor designer|build (?:an |a )?executor|design (?:an |a )?executor|automate (?:this|that|the)\b|figure out how to automate|learn (?:this|that|the) (?:site|app|workflow)|create (?:an |a )?(?:playbook|workflow automation)/i;

const BROWSER_RE = /https?:\/\/|search\b|look\s?up|google|browse|find online|navigate to|go to .*(site|page|url)|open.*website|check.*site|what.*price|how much.*cost|latest news|github|gitlab|linkedin|reddit|pull requests?|notifications?|inbox|messages?|saved posts?|review requests?/i;

const RESEARCH_RE = /compare|vs\b|best\b|recommend|analyze|report|pricing/i;

const CODING_RE = /(read|write|edit|create|delete|save).*file|src\/|\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|md|txt|json|yaml|yml|toml|sh|cfg|conf)\b|package\.json|Cargo\.toml|refactor|debug\b|implement|fix.*bug|build\b|compile|npm |pip |cargo |git |\bls |\bcd |\bcat |\bgrep |\bmkdir |\brm |\bchmod |\bsudo /i;
const FILESYSTEM_AGENT_RE = /(?:organize|sort|clean up|tidy|declutter|dedup(?:licate)?|de-dup(?:licate)?|rename|move|copy|archive|scan|audit|summarize|find|locate)\s+(?:my\s+)?(?:files?|folders?|directories|downloads|desktop|documents|pdfs?|images|photos|videos|contracts|invoices|receipts|screenshots)|organize .*?(?:in|into)\s+(?:\/|~\/|desktop|documents|downloads)|rename\s+(?:these|my)?\s*files|clean up\s+(?:my\s+)?(?:desktop|downloads|documents|screenshots)|(?:downloads|desktop|documents|pictures|photos)\s+folder|disk usage|largest files|duplicate files|find .*?(?:pdf|invoice|contract|receipt|screenshot|photo|image|video)|find .*?(?:line|sentence|quote|phrase|string).*?(?:file|source)|(?:which|what) file .*?(?:contains|has|includes)|(?:contains|include|includes).*?(?:line|sentence|quote|phrase).*?(?:file|source)|(?:exact|right|correct)\s+file|(?:move|rename|copy)\s+.*\s+to\s+(?:\/|~\/|desktop|documents|downloads)|(?:folder|directory)\s+structure/i;

const DOCUMENT_RE = /(?:create|generate|make|write|draft|prepare|export).*(?:document|report|spreadsheet|pdf\b|docx|xlsx|csv\b|slides|presentation|memo|letter)|(?:document|report|spreadsheet|slides|presentation).*(?:for|about)/i;

// Expanded to cover: open-source creative apps, proprietary apps, media control,
// GUI interaction phrases, and common desktop actions
const DESKTOP_APP_RE = /gimp|blender|inkscape|libreoffice|audacity|obs\b|kdenlive|shotcut|vlc|firefox|chrome|spotify|discord|slack|steam|figma|zoom|thunderbird|nautilus|thunar|dolphin|terminal|vscode|vs code|visual studio code|sublime|atom|krita|darktable|rawtherapee|openshot|pitivi|handbrake|transmission|qbittorrent|telegram|signal|teams|skype|(launch|open|start|run|control|close|quit|interact).*app|play.*music|pause.*music|next.*track|prev.*track|volume\b|take.*screenshot|click.*button|type.*into|press.*key|dbus\b|xdotool|wmctrl|gui\b.*interact|desktop.*control|window.*manage|list.*windows/i;

const SELF_RE = /clawdia|your (code|source|memory|data|settings|config)|this app|clear (my|your|all) (data|history|memory)|reset/i;

const OPUS_RE = /\bassess\b|evaluate|deep analysis|think carefully|plan.*approach/i;

export function classify(message: string): TaskProfile {
  const trimmed = message.trim();
  const modules = new Set<PromptModule>();

  // Rule 0: Greetings
  if (GREETING_RE.test(trimmed)) {
    return { agentProfile: 'general', toolGroup: 'core', promptModules: modules, model: 'haiku', isGreeting: true };
  }

  // Collect all matching modules
  const matchesBrowser = BROWSER_RE.test(trimmed);
  const matchesBloodhound = BLOODHOUND_RE.test(trimmed);
  const matchesCoding = CODING_RE.test(trimmed);
  const matchesFilesystemAgent = FILESYSTEM_AGENT_RE.test(trimmed);
  const matchesDocument = DOCUMENT_RE.test(trimmed);
  const matchesDesktopApp = DESKTOP_APP_RE.test(trimmed);
  const matchesSelf = SELF_RE.test(trimmed);
  const matchesResearch = RESEARCH_RE.test(trimmed);

  if (matchesBrowser) modules.add('browser');
  if (matchesBloodhound) modules.add('bloodhound');
  if (matchesResearch) modules.add('research');
  if (matchesCoding) modules.add('coding');
  if (matchesFilesystemAgent) modules.add('filesystem');
  if (matchesDocument) modules.add('document');
  if (matchesDesktopApp) modules.add('desktop_apps');
  if (matchesSelf) modules.add('self_knowledge');

  const agentProfile: AgentProfile = matchesBloodhound
    ? 'bloodhound'
    : matchesFilesystemAgent && !matchesDesktopApp
      ? 'filesystem'
      : 'general';

  // Count domain matches for multi-domain detection
  const domainMatches = [matchesBrowser, matchesCoding || matchesFilesystemAgent, matchesDocument, matchesDesktopApp, matchesSelf]
    .filter(Boolean).length;

  // Rule 6: Multi-domain → full
  // Two+ domain signals = cross-domain task, regardless of message length
  if (domainMatches >= 2) {
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  if (matchesBloodhound && !matchesCoding && !matchesFilesystemAgent && !matchesDocument && !matchesDesktopApp) {
    modules.add('browser');
    return { agentProfile: 'bloodhound', toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 1: Browser
  if (matchesBrowser && !matchesCoding && !matchesFilesystemAgent && !matchesDocument && !matchesDesktopApp) {
    return { agentProfile, toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 2: Coding or filesystem
  if ((matchesCoding || matchesFilesystemAgent) && !matchesBrowser && !matchesDocument && !matchesDesktopApp) {
    return { agentProfile, toolGroup: 'core', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 3: Document creation
  if (matchesDocument) {
    if (matchesResearch) modules.add('research');
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 4: Desktop app
  if (matchesDesktopApp) {
    return { agentProfile, toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 5: Self-reference
  if (matchesSelf) {
    return { agentProfile, toolGroup: 'core', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Model override: opus for deep analysis
  let model: ModelTier = 'sonnet';
  if (OPUS_RE.test(trimmed)) model = 'opus';
  // Simple factual → haiku
  if (trimmed.length < 50 && trimmed.includes('?') && !matchesBrowser && !matchesCoding && !matchesFilesystemAgent) {
    model = 'haiku';
  }

  // Rule 7: Default → full
  return { agentProfile, toolGroup: 'full', promptModules: modules, model, isGreeting: false };
}
