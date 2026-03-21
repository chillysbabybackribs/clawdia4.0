import { findPlaybookCandidate, normalizeTaskPattern, type PlaybookCandidateMatch } from '../db/browser-playbooks';
export { compileTaskExecutionGraphScaffold } from './task-compiler-planner';
export type { TaskExecutionGraphScaffold } from './task-compiler-planner';

export interface BrowserExecutionSketchStep {
  goal: string;
  mode: 'executor' | 'llm';
  playbookId?: number;
  matchType?: 'exact' | 'fuzzy';
  confidence?: number;
  note?: string;
}

export interface BrowserExecutionSketch {
  mode: 'hybrid' | 'llm_only';
  confidence: number;
  steps: BrowserExecutionSketchStep[];
}

const STRONG_CONNECTOR_RE = /\b(?:and then|then|after that|afterwards|followed by|next)\b/i;
const ACTION_VERB_RE = /\b(?:open|navigate|go|visit|check|read|review|inspect|post|write|send|reply|search|find|look|summarize|extract|click)\b/i;
const SPLIT_AND_ACTION_RE = /\s+and\s+(?=(?:open|navigate|go|visit|check|read|review|inspect|post|write|send|reply|search|find|look|summarize|extract|click)\b)/i;
const SHARED_SITE_RE = /\b(?:reddit|github|gitlab|linkedin|gmail|youtube|x|twitter|facebook|instagram|notion|slack|discord)\b/i;
const COORDINATION_TASK_RE = /\bagent_spawn\b|\bspawn\b.*\b(agent|sub-agent|worker)s?\b|\bsub-agent\b|\bparallel\b|\bworkers?\b|\bcoordinator\b|\bswarm\b/i;

export function compileBrowserExecutionSketch(userMessage: string): BrowserExecutionSketch | null {
  if (COORDINATION_TASK_RE.test(userMessage)) return null;
  const steps = splitIntoBrowserSubgoals(userMessage);
  if (steps.length < 2) return null;

  const sharedSite = extractSharedSiteContext(userMessage);
  const compiledSteps = steps.map((goal, index) => compileStep(goal, index === 0 ? sharedSite : sharedSite));
  const executorSteps = compiledSteps.filter((step) => step.mode === 'executor').length;
  const fuzzyCandidates = compiledSteps.filter((step) => step.matchType === 'fuzzy').length;
  const confidenceBase = executorSteps > 0 ? 0.82 : fuzzyCandidates > 0 ? 0.68 : 0.6;

  return {
    mode: executorSteps > 0 || fuzzyCandidates > 0 ? 'hybrid' : 'llm_only',
    confidence: Math.min(0.95, confidenceBase + Math.min(0.12, executorSteps * 0.08)),
    steps: compiledSteps,
  };
}

export function formatBrowserExecutionSketch(sketch: BrowserExecutionSketch | null): string {
  if (!sketch || sketch.steps.length === 0) return '';

  const lines: string[] = [
    '[BROWSER EXECUTION SKETCH]',
    `Mode: ${sketch.mode}`,
    `Confidence: ${sketch.confidence.toFixed(2)}`,
    'Rules:',
    '- Treat these as ordered subgoals.',
    '- If a step is tagged executor, prefer browser_run_playbook with the listed playbook_id before rediscovering the route.',
    '- If a step only has a candidate playbook note, use it only if the current page state still matches.',
    '- After completing one step, continue to the next unfinished step instead of stopping early.',
    'Steps:',
  ];

  for (let i = 0; i < sketch.steps.length; i++) {
    const step = sketch.steps[i];
    const tags = [
      step.mode,
      step.playbookId ? `playbook_id=${step.playbookId}` : '',
      step.matchType ? `match=${step.matchType}` : '',
      typeof step.confidence === 'number' ? `confidence=${step.confidence.toFixed(2)}` : '',
    ].filter(Boolean).join(', ');
    lines.push(`${i + 1}. ${step.goal}${tags ? ` [${tags}]` : ''}`);
    if (step.note) lines.push(`   Note: ${step.note}`);
  }

  return lines.join('\n');
}

export function buildBrowserStepControllerPrompt(
  sketch: BrowserExecutionSketch | null,
  currentStepIndex: number,
): string {
  if (!sketch || sketch.steps.length === 0) return '';
  const clampedIndex = Math.max(0, Math.min(currentStepIndex, sketch.steps.length - 1));
  const currentStep = sketch.steps[clampedIndex];
  const completed = sketch.steps
    .slice(0, clampedIndex)
    .map((step, index) => `${index + 1}. ${step.goal}`)
    .join('\n');

  // Show ALL steps so the LLM knows the full plan and can mark the right one
  const allSteps = sketch.steps
    .map((step, index) => {
      const done = index < clampedIndex;
      const current = index === clampedIndex;
      return `${done ? '✓' : current ? '→' : ' '} ${index + 1}. ${step.goal}`;
    })
    .join('\n');

  const lines = [
    '[SYSTEM] BROWSER STEP CONTROLLER',
    `Progress: step ${clampedIndex + 1} of ${sketch.steps.length}`,
    `Steps:\n${allSteps}`,
    currentStep.playbookId ? `Preferred playbook_id for current step: ${currentStep.playbookId}` : '',
    currentStep.note ? `Note: ${currentStep.note}` : '',
    `IMPORTANT: When you finish your work, include [STEP_DONE:N] for the HIGHEST step number you completed.`,
    `For example, if you completed steps 1, 2, and 3 in one go, write [STEP_DONE:3] — not [STEP_DONE:1].`,
    `The step number must match the step list above, not your internal count of actions.`,
  ].filter(Boolean);

  return lines.join('\n');
}

export function extractStepDoneMarker(text: string): number | null {
  // Find ALL [STEP_DONE:N] markers and return the highest step number.
  // The LLM often emits multiple markers in one response (e.g., when it
  // completes the final step and summarizes all completed steps).
  const matches = text.matchAll(/\[STEP_DONE:(\d+)\]/gi);
  let highest: number | null = null;
  for (const m of matches) {
    const value = Number(m[1]);
    if (Number.isFinite(value) && (highest === null || value > highest)) {
      highest = value;
    }
  }
  return highest;
}

export function stripStepDoneMarkers(text: string): string {
  return text.replace(/\s*\[STEP_DONE:\d+\]\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function compileStep(goal: string, sharedSite: string): BrowserExecutionSketchStep {
  const query = withSharedSiteContext(goal, sharedSite);
  const candidate = findPlaybookCandidate(query, undefined, { minScore: 0.78 });
  if (!candidate) {
    return {
      goal: query,
      mode: 'llm',
    };
  }

  if (candidate.matchType === 'exact') {
    return {
      goal: query,
      mode: 'executor',
      playbookId: candidate.playbook.id,
      matchType: candidate.matchType,
      confidence: candidate.score,
      note: `Validated Bloodhound executor for "${candidate.playbook.taskPattern}" on ${candidate.playbook.domain}.`,
    };
  }

  return buildFuzzyCandidateStep(query, candidate);
}

function buildFuzzyCandidateStep(goal: string, candidate: PlaybookCandidateMatch): BrowserExecutionSketchStep {
  if (candidate.score >= 0.9) {
    return {
      goal,
      mode: 'executor',
      playbookId: candidate.playbook.id,
      matchType: candidate.matchType,
      confidence: candidate.score,
      note: `High-confidence candidate for "${candidate.playbook.taskPattern}" on ${candidate.playbook.domain}. Verify current page state before relying on it.`,
    };
  }

  return {
    goal,
    mode: 'llm',
    playbookId: candidate.playbook.id,
    matchType: candidate.matchType,
    confidence: candidate.score,
    note: `Candidate playbook "${candidate.playbook.taskPattern}" on ${candidate.playbook.domain} may help, but this step should stay LLM-driven unless the page state clearly matches.`,
  };
}

function splitIntoBrowserSubgoals(userMessage: string): string[] {
  const normalized = userMessage.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];
  const softSplit = normalized
    .replace(STRONG_CONNECTOR_RE, ' || ')
    .replace(SPLIT_AND_ACTION_RE, ' || ');
  const parts = softSplit
    .split('||')
    .map((part) => part.trim().replace(/^[,.;:]+|[,.;:]+$/g, ''))
    .filter(Boolean);
  if (parts.length < 2) return [];
  return parts.filter((part) => ACTION_VERB_RE.test(part));
}

function extractSharedSiteContext(userMessage: string): string {
  const explicitSite = userMessage.match(SHARED_SITE_RE)?.[0]?.toLowerCase() || '';
  if (explicitSite) return explicitSite;

  const pattern = normalizeTaskPattern(userMessage);
  const tokens = pattern.split(/\s+/).filter(Boolean);
  return tokens.find((token) => SHARED_SITE_RE.test(token)) || '';
}

function withSharedSiteContext(goal: string, sharedSite: string): string {
  if (!sharedSite) return goal;
  if (SHARED_SITE_RE.test(goal)) return goal;
  return `${sharedSite} ${goal}`.trim();
}
