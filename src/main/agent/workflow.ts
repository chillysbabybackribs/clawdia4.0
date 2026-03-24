import type { TaskProfile } from './classifier';
import type { ProviderClient, NormalizedMessage } from './client';
import { appendRunEvent } from '../db/run-events';
import { upsertRunArtifact } from '../db/run-artifacts';
import type { PerformanceStance } from '../../shared/types';
import { requestApproval, waitForApproval } from './approval-manager';
import { EXECUTION_PLANNING_ENABLED } from './runtime-constraints';

function buildPlanningPrompt(
  userMessage: string,
  performanceStance: PerformanceStance,
  revisionContext?: { previousPlan: string; round: number },
): string {
  const lines = [
    'You are generating an execution plan for an agent run.',
    `User request: ${userMessage}`,
    `Performance stance: ${performanceStance}`,
    'Produce concise markdown with these sections in this order:',
    '## Objective',
    '## Plan',
    'Use 3-6 numbered steps.',
    'Each numbered step must be a single line.',
    '## Risks',
    'Use 0-3 bullet points.',
    'Each risk bullet must be a single line.',
    '## Review',
    'Use 0-3 bullet points describing how success should be checked.',
    'Each review bullet must be a single line.',
    'Do not mention being an AI model. Do not use code fences.',
    'Do not include scratchpad reasoning, alternatives, self-talk, or notes after the Review section.',
    'Choose one plan and stop immediately after the Review section.',
  ];

  if (revisionContext) {
    lines.push(
      `Revision round: ${revisionContext.round}`,
      'The previous plan was sent back for revision.',
      'Generate a meaningfully improved plan rather than repeating the same structure.',
      'Previous plan:',
      revisionContext.previousPlan,
    );
  }

  return lines.join('\n');
}

function sanitizeExecutionPlan(markdown: string): string {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const allowedSections = ['## Objective', '## Plan', '## Risks', '## Review'] as const;
  type Section = typeof allowedSections[number];
  const out: string[] = [];
  let currentSection: Section | null = null;
  const seenSections = new Set<Section>();

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = allowedSections.find((item) => line.trim() === item);
    if (heading) {
      if (seenSections.has(heading)) break;
      seenSections.add(heading);
      currentSection = heading;
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(heading);
      continue;
    }

    if (!currentSection) continue;
    if (!line.trim()) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }

    if (currentSection === '## Objective') {
      if (/^[-*`]/.test(line.trim()) || /^#{1,6}\s/.test(line.trim())) break;
      out.push(line);
      continue;
    }

    if (currentSection === '## Plan') {
      if (!/^\d+\.\s+/.test(line.trim())) break;
      out.push(line);
      continue;
    }

    if (currentSection === '## Risks' || currentSection === '## Review') {
      if (!/^[-*]\s+/.test(line.trim())) break;
      out.push(line);
      continue;
    }
  }

  return out.join('\n').trim();
}

export function shouldCreateExecutionPlan(userMessage: string, profile: TaskProfile): boolean {
  if (!EXECUTION_PLANNING_ENABLED) return false;
  const text = userMessage.trim();

  if (!text || profile.isGreeting) return false;
  if (profile.agentProfile !== 'general') return true;
  if (profile.model === 'opus') return true;

  const explicitlyRequestsPlanning =
    /\b(plan|approach|review|audit|migrate|workflow|orchestrate|step[- ]by[- ]step|implementation plan)\b/i.test(text);
  if (explicitlyRequestsPlanning) return true;

  const substantialChangeIntent =
    /\b(implement|refactor|rewrite|redesign|restructure|integrate|add support|build|create|write|draft)\b/i.test(text);
  const projectScopedTarget =
    /\b(file|files|repo|repository|project|app|application|system|workflow|feature|integration|document|report)\b/i.test(text);
  if (substantialChangeIntent && projectScopedTarget && text.length >= 100) return true;

  const longCrossDomainTask = profile.toolGroup === 'full' && text.length >= 180;
  if (longCrossDomainTask) return true;

  return false;
}

export async function createExecutionPlan(params: {
  client: ProviderClient;
  runId?: string;
  userMessage: string;
  staticPrompt: string;
  dynamicPrompt: string;
  performanceStance: PerformanceStance;
  onText?: (text: string) => void;
  signal?: AbortSignal;
  revisionContext?: { previousPlan: string; round: number };
}): Promise<string | null> {
  const { client, runId, userMessage, staticPrompt, dynamicPrompt, performanceStance, onText, signal, revisionContext } = params;

  try {
    const planningMessages: NormalizedMessage[] = [
      { role: 'user', content: buildPlanningPrompt(userMessage, performanceStance, revisionContext) },
    ];
    const response = await client.chat(planningMessages, [], staticPrompt, dynamicPrompt, onText, { signal, maxTokens: 900 });
    const text = response.content
      .filter((block): block is Extract<typeof response.content[number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    const plan = sanitizeExecutionPlan(text);
    if (!plan) return null;

    if (runId) {
      upsertRunArtifact(runId, 'execution_plan', 'Execution Plan', plan);
      appendRunEvent(runId, {
        kind: 'workflow_plan_created',
        phase: 'planning',
        payload: {
          title: 'Execution Plan',
          preview: plan.slice(0, 500),
        },
      });
    }

    return plan;
  } catch (err: any) {
    if (runId) {
      appendRunEvent(runId, {
        kind: 'workflow_plan_failed',
        phase: 'planning',
        payload: { message: err?.message || 'Unknown planning error' },
      });
    }
    return null;
  }
}

export async function requireExecutionPlanApproval(params: {
  runId: string;
  plan: string;
}): Promise<'approved' | 'denied' | 'revise'> {
  const approval = requestApproval(params.runId, {
    actionType: 'workflow_plan',
    target: 'Execution Plan',
    summary: 'Approve the execution plan before Clawdia starts making changes or running tools.',
    request: {
      artifactKind: 'execution_plan',
      plan: params.plan,
    },
  });

  return waitForApproval(approval.id);
}
