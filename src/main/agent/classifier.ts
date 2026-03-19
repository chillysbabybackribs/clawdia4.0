/**
 * Classifier — Maps user messages to tool groups + prompt modules.
 * Pure regex, zero LLM cost, zero latency.
 */

export type ToolGroup = 'core' | 'browser' | 'full';
export type PromptModule = 'coding' | 'research' | 'document' | 'desktop_apps' | 'self_knowledge';
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface TaskProfile {
  toolGroup: ToolGroup;
  promptModules: Set<PromptModule>;
  model: ModelTier;
  isGreeting: boolean;
}

const GREETING_RE = /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)[!?.,]?\s*$/i;

const BROWSER_RE = /https?:\/\/|search\b|look\s?up|google|browse|find online|navigate to|go to .*(site|page|url)|open.*website|check.*site|what.*price|how much.*cost|latest news/i;

const RESEARCH_RE = /compare|vs\b|best\b|recommend|analyze|report|pricing/i;

const FILESYSTEM_RE = /(read|write|edit|create|delete|move|copy|rename|save).*file|save.*(to|as|in|on).*(\/|~\/|desktop|documents)|src\/|\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|md|txt|json|yaml|yml|toml|sh|cfg|conf)\b|package\.json|Cargo\.toml|refactor|debug\b|implement|fix.*bug|build\b|compile|npm |pip |cargo |git |\bls |\bcd |\bcat |\bgrep |\bfind |\bmkdir |\brm |\bchmod |\bsudo /i;

const DOCUMENT_RE = /document|report|spreadsheet|pdf\b|docx|xlsx|csv\b|slides|presentation|write.*memo|write.*letter/i;

// Expanded to cover: open-source creative apps, proprietary apps, media control,
// GUI interaction phrases, and common desktop actions
const DESKTOP_APP_RE = /gimp|blender|inkscape|libreoffice|audacity|obs\b|kdenlive|shotcut|vlc|firefox|chrome|spotify|discord|slack|steam|figma|zoom|thunderbird|nautilus|thunar|dolphin|terminal|code\b|vscode|sublime|atom|krita|darktable|rawtherapee|openshot|pitivi|handbrake|transmission|qbittorrent|telegram|signal|teams|skype|(launch|open|start|run|control|close|quit|interact).*app|play.*music|pause.*music|next.*track|prev.*track|volume\b|screenshot|click.*button|type.*into|press.*key|dbus\b|xdotool|wmctrl|gui\b.*interact|desktop.*control|window.*manage|list.*windows/i;

const SELF_RE = /clawdia|your (code|source|memory|data|settings|config)|this app|clear (my|your|all) (data|history|memory)|reset/i;

const OPUS_RE = /\bassess\b|evaluate|deep analysis|think carefully|plan.*approach/i;

export function classify(message: string): TaskProfile {
  const trimmed = message.trim();
  const modules = new Set<PromptModule>();

  // Rule 0: Greetings
  if (GREETING_RE.test(trimmed)) {
    return { toolGroup: 'core', promptModules: modules, model: 'haiku', isGreeting: true };
  }

  // Collect all matching modules
  const matchesBrowser = BROWSER_RE.test(trimmed);
  const matchesFilesystem = FILESYSTEM_RE.test(trimmed);
  const matchesDocument = DOCUMENT_RE.test(trimmed);
  const matchesDesktopApp = DESKTOP_APP_RE.test(trimmed);
  const matchesSelf = SELF_RE.test(trimmed);
  const matchesResearch = RESEARCH_RE.test(trimmed);

  if (matchesResearch) modules.add('research');
  if (matchesFilesystem) modules.add('coding');
  if (matchesDocument) modules.add('document');
  if (matchesDesktopApp) modules.add('desktop_apps');
  if (matchesSelf) modules.add('self_knowledge');

  // Count domain matches for multi-domain detection
  const domainMatches = [matchesBrowser, matchesFilesystem, matchesDocument, matchesDesktopApp, matchesSelf]
    .filter(Boolean).length;

  // Rule 6: Multi-domain → full
  // Two+ domain signals = cross-domain task, regardless of message length
  if (domainMatches >= 2) {
    return { toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 1: Browser
  if (matchesBrowser && !matchesFilesystem && !matchesDocument && !matchesDesktopApp) {
    return { toolGroup: 'browser', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 2: Filesystem/code
  if (matchesFilesystem && !matchesBrowser && !matchesDocument && !matchesDesktopApp) {
    return { toolGroup: 'core', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 3: Document creation
  if (matchesDocument) {
    if (matchesResearch) modules.add('research');
    return { toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 4: Desktop app
  if (matchesDesktopApp) {
    return { toolGroup: 'full', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Rule 5: Self-reference
  if (matchesSelf) {
    return { toolGroup: 'core', promptModules: modules, model: 'sonnet', isGreeting: false };
  }

  // Model override: opus for deep analysis
  let model: ModelTier = 'sonnet';
  if (OPUS_RE.test(trimmed)) model = 'opus';
  // Simple factual → haiku
  if (trimmed.length < 50 && trimmed.includes('?') && !matchesBrowser && !matchesFilesystem) {
    model = 'haiku';
  }

  // Rule 7: Default → full
  return { toolGroup: 'full', promptModules: modules, model, isGreeting: false };
}
