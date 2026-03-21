import {
  createGraphId,
  createNodeId,
  type GraphEdge,
  type GraphNode,
  type PlannerOutput,
} from './execution-graph';
import { getExecutorBinding } from './executor-registry';
import {
  APP_TASK_OUTPUT_CONTRACT,
  BROWSER_RESEARCH_OUTPUT_CONTRACT,
  PLANNER_OUTPUT_CONTRACT,
  PRODUCT_COMPARE_OUTPUT_CONTRACT,
  VERIFICATION_OUTPUT_CONTRACT,
} from './node-contracts';
import { buildEvidencePlan } from './evidence-planner';

export interface TaskExecutionGraphScaffold {
  planner: PlannerOutput;
  rationale: string[];
}

interface TaskPlanningSignals {
  isBrowserTask: boolean;
  isAppTask: boolean;
  isFilesystemTask: boolean;
  isComparisonTask: boolean;
  browserFragment: string;
  appFragment: string;
  filesystemFragment: string;
  requiresDependentOutputChain: boolean;
}

const CLAUSE_SPLIT_RE = /\b(?:and then|then|after that|afterwards|followed by|next| and )\b/i;
const BROWSER_MATCHER = /https?:\/\/|search|browse|amazon|github|reddit|product|price|compare|review|research|find\b/i;
const APP_MATCHER = /gimp|blender|libreoffice|figma|export|render|desktop app|open .*app|in app|inside .*app/i;
const FILESYSTEM_MATCHER = /(repo|project|file|files|code|implement|edit|fix|refactor|write (?:a )?(?:summary|report|markdown|md)|save (?:it|this|the result)|create (?:a )?(?:file|document|report))/i;
const COMPARISON_MATCHER = /\b(compare|vs|best|recommend)\b/i;
const OUTPUT_ACTION_MATCHER = /\b(write|save|create|export|generate)\b/i;
const OUTPUT_OBJECT_MATCHER = /\b(summary|report|markdown|file|document|card|artifact|comparison)\b/i;

export function compileTaskExecutionGraphScaffold(userMessage: string): TaskExecutionGraphScaffold {
  const graphId = createGraphId(userMessage);
  const normalized = userMessage.trim();
  const signals = analyzeTaskPlanningSignals(normalized);
  const evidencePlan = buildEvidencePlan(normalized);
  const supportsDependentChain = signals.requiresDependentOutputChain && signals.isBrowserTask && (signals.isAppTask || signals.isFilesystemTask);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const rationale: string[] = [];

  const plannerNodeId = createNodeId('planner', 0);
  nodes.push({
    id: plannerNodeId,
    kind: 'planner',
    label: 'Task Planner',
    objective: `Plan execution topology for: ${normalized}`,
    executor: getExecutorBinding('llm_general'),
    inputs: [
      { name: 'user_task', source: 'user_task', value: normalized },
      { name: 'evidence_plan', source: 'planner', value: evidencePlan },
    ],
    output: PLANNER_OUTPUT_CONTRACT,
    policy: { retryLimit: 0, canSpawnChildren: true },
    status: 'pending',
  });

  let nodeIndex = 1;
  const workerNodeIds: string[] = [];

  let browserWorkerNodeId: string | null = null;
  if (signals.isBrowserTask) {
    const browserNodeId = createNodeId(signals.isComparisonTask ? 'browser_compare_worker' : 'browser_research_worker', nodeIndex++);
    nodes.push({
      id: browserNodeId,
      kind: 'worker',
      label: signals.isComparisonTask ? 'Browser Compare Worker' : 'Browser Research Worker',
      objective: signals.isComparisonTask
        ? `For the user task fragment "${signals.browserFragment}", use CDP-backed browser execution to gather and compare the relevant products or browser-side findings. Required evidence types: ${formatEvidenceTypes(evidencePlan.required)}. Optional evidence types: ${formatEvidenceTypes(evidencePlan.optional)}. Stay on the user task and do not perform generic browser capability checks.`
        : `For the user task fragment "${signals.browserFragment}", use CDP-backed browser execution to gather the relevant browser-side findings. Required evidence types: ${formatEvidenceTypes(evidencePlan.required)}. Optional evidence types: ${formatEvidenceTypes(evidencePlan.optional)}. Stay on the user task and do not perform generic browser capability checks.`,
      executor: getExecutorBinding('browser_cdp'),
      inputs: [
        { name: 'task_fragment', source: 'planner', value: signals.browserFragment },
        { name: 'evidence_plan', source: 'planner', value: evidencePlan },
      ],
      output: signals.isComparisonTask ? PRODUCT_COMPARE_OUTPUT_CONTRACT : BROWSER_RESEARCH_OUTPUT_CONTRACT,
      policy: { retryLimit: 1, timeoutMs: 120000 },
      status: 'pending',
    });
    workerNodeIds.push(browserNodeId);
    edges.push({ id: `${plannerNodeId}_${browserNodeId}`, from: plannerNodeId, to: browserNodeId, kind: 'serial' });
    rationale.push('Browser/CDP executor selected because the task references web navigation or browser-side comparison.');
    rationale.push(...evidencePlan.rationale);
    browserWorkerNodeId = browserNodeId;
  }

  if (signals.isAppTask) {
    const appNodeId = createNodeId('app_worker', nodeIndex++);
    nodes.push({
      id: appNodeId,
      kind: 'worker',
      label: 'App Worker',
      objective: supportsDependentChain
        ? `Using the validated browser findings, complete the user task fragment "${signals.appFragment}" with CLI-Anything or its GUI fallback and produce the requested artifacts. Stay on the user task and avoid generic executor probing.`
        : `For the user task fragment "${signals.appFragment}", use CLI-Anything or its GUI fallback to execute the required app-local work and produce the requested artifacts. Stay on the user task and avoid generic executor probing.`,
      executor: getExecutorBinding('app_cli_anything'),
      inputs: supportsDependentChain && browserWorkerNodeId
        ? [
            { name: 'task_fragment', source: 'planner', value: signals.appFragment },
            { name: 'browser_findings', source: 'node_output', fromNodeId: browserWorkerNodeId },
          ]
        : [{ name: 'task_fragment', source: 'planner', value: signals.appFragment }],
      output: APP_TASK_OUTPUT_CONTRACT,
      policy: { retryLimit: 1, timeoutMs: 120000 },
      status: 'pending',
    });
    workerNodeIds.push(appNodeId);
    edges.push(
      supportsDependentChain && browserWorkerNodeId
        ? { id: `${browserWorkerNodeId}_${appNodeId}`, from: browserWorkerNodeId, to: appNodeId, kind: 'serial' }
        : { id: `${plannerNodeId}_${appNodeId}`, from: plannerNodeId, to: appNodeId, kind: 'serial' },
    );
    rationale.push('CLI-Anything executor selected because the task references local-app control or artifact production.');
  }

  if (signals.isFilesystemTask) {
    const fsNodeId = createNodeId('filesystem_worker', nodeIndex++);
    nodes.push({
      id: fsNodeId,
      kind: 'worker',
      label: 'Filesystem Worker',
      objective: supportsDependentChain
        ? `Using the validated browser findings, perform the required repository/filesystem work for the user task fragment "${signals.filesystemFragment}" using core file and shell tools. Stay on the user task and avoid unrelated inspection.`
        : `For the user task fragment "${signals.filesystemFragment}", perform the required repository/filesystem work using core file and shell tools. Stay on the user task and avoid unrelated inspection.`,
      executor: getExecutorBinding('filesystem_core'),
      inputs: supportsDependentChain && browserWorkerNodeId
        ? [
            { name: 'task_fragment', source: 'planner', value: signals.filesystemFragment },
            { name: 'browser_findings', source: 'node_output', fromNodeId: browserWorkerNodeId },
          ]
        : [{ name: 'task_fragment', source: 'planner', value: signals.filesystemFragment }],
      output: APP_TASK_OUTPUT_CONTRACT,
      policy: { retryLimit: 1, timeoutMs: 120000 },
      status: 'pending',
    });
    workerNodeIds.push(fsNodeId);
    edges.push(
      supportsDependentChain && browserWorkerNodeId
        ? { id: `${browserWorkerNodeId}_${fsNodeId}`, from: browserWorkerNodeId, to: fsNodeId, kind: 'serial' }
        : { id: `${plannerNodeId}_${fsNodeId}`, from: plannerNodeId, to: fsNodeId, kind: 'serial' },
    );
    rationale.push('Filesystem executor selected because the task is project/file scoped without requiring browser runtime.');
  }

  const verifierNodeId = createNodeId('verifier', nodeIndex++);
  nodes.push({
    id: verifierNodeId,
    kind: 'verifier',
    label: 'Runtime Verifier',
    objective: 'Validate worker outputs against bounded runtime contracts',
    executor: getExecutorBinding('runtime_verifier'),
    inputs: workerNodeIds.map((fromNodeId) => ({ name: `input_${fromNodeId}`, source: 'node_output', fromNodeId })),
    output: VERIFICATION_OUTPUT_CONTRACT,
    policy: { retryLimit: 0, timeoutMs: 30000 },
    status: 'pending',
  });
  for (const workerNodeId of workerNodeIds) {
    edges.push({
      id: `${workerNodeId}_${verifierNodeId}`,
      from: workerNodeId,
      to: verifierNodeId,
      kind: supportsDependentChain ? 'serial' : workerNodeIds.length > 1 ? 'parallel' : 'serial',
    });
  }

  const mergeNodeId = createNodeId('merge', nodeIndex++);
  nodes.push({
    id: mergeNodeId,
    kind: 'merge',
    label: 'Result Synthesizer',
    objective: 'Merge validated worker outputs into a final answer payload',
    executor: getExecutorBinding('llm_general'),
    inputs: [
      { name: 'verification', source: 'node_output', fromNodeId: verifierNodeId },
      ...workerNodeIds.map((fromNodeId) => ({ name: `worker_${fromNodeId}`, source: 'node_output' as const, fromNodeId })),
    ],
    output: BROWSER_RESEARCH_OUTPUT_CONTRACT,
    policy: { retryLimit: 0, timeoutMs: 30000 },
    status: 'pending',
  });
  edges.push({ id: `${verifierNodeId}_${mergeNodeId}`, from: verifierNodeId, to: mergeNodeId, kind: 'merge' });

  return {
    planner: {
      summary: `Scaffolded execution graph with ${workerNodeIds.length} worker node(s), one verifier, and one merge node.`,
      topology: {
        serialStages: supportsDependentChain ? 4 : 3,
        parallelBranches: supportsDependentChain ? 1 : Math.max(1, workerNodeIds.length),
      },
      graph: {
        id: graphId,
        task: normalized,
        createdAt: new Date().toISOString(),
        budget: {
          maxNodes: 8,
          maxParallel: supportsDependentChain ? 1 : workerNodeIds.length > 1 ? workerNodeIds.length : 1,
          maxToolCallsPerNode: 12,
          maxWallMs: 10 * 60 * 1000,
        },
        nodes,
        edges,
        outputs: [{ name: 'final_answer', fromNodeId: mergeNodeId }],
      },
    },
    rationale,
  };
}

function formatEvidenceTypes(evidenceTypes: string[]): string {
  return evidenceTypes.length > 0 ? evidenceTypes.join(', ') : 'none';
}

function analyzeTaskPlanningSignals(task: string): TaskPlanningSignals {
  const clauses = splitTaskIntoClauses(task);
  const browserClauses = clauses.filter((clause) => BROWSER_MATCHER.test(clause));
  const appClauses = clauses.filter((clause) => APP_MATCHER.test(clause));
  const filesystemClauses = clauses.filter((clause) => FILESYSTEM_MATCHER.test(clause));

  const browserFragment = selectBestTaskFragment(browserClauses, task);
  const appFragment = selectBestTaskFragment(appClauses, task);
  const filesystemFragment = selectBestTaskFragment(filesystemClauses, task);

  return {
    isBrowserTask: browserClauses.length > 0 || BROWSER_MATCHER.test(task),
    isAppTask: appClauses.length > 0 || APP_MATCHER.test(task),
    isFilesystemTask: filesystemClauses.length > 0 || (!APP_MATCHER.test(task) && FILESYSTEM_MATCHER.test(task)),
    isComparisonTask: COMPARISON_MATCHER.test(task),
    browserFragment,
    appFragment,
    filesystemFragment,
    requiresDependentOutputChain: detectDependentOutputChain({
      task,
      browserFragment,
      appFragment,
      filesystemFragment,
      hasBrowser: browserClauses.length > 0 || BROWSER_MATCHER.test(task),
      hasApp: appClauses.length > 0 || APP_MATCHER.test(task),
      hasFilesystem: filesystemClauses.length > 0 || (!APP_MATCHER.test(task) && FILESYSTEM_MATCHER.test(task)),
    }),
  };
}

function splitTaskIntoClauses(task: string): string[] {
  const clauses = task
    .split(CLAUSE_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);
  return clauses.length > 0 ? clauses : [task.trim()];
}

function selectBestTaskFragment(matches: string[], fallback: string): string {
  if (matches.length === 0) return fallback.trim();
  return matches
    .sort((a, b) => scoreTaskFragment(b) - scoreTaskFragment(a))
    [0]
    .trim();
}

function scoreTaskFragment(fragment: string): number {
  let score = fragment.length;
  if (OUTPUT_ACTION_MATCHER.test(fragment)) score += 100;
  if (OUTPUT_OBJECT_MATCHER.test(fragment)) score += 100;
  if (/\bin this repo\b|\bto this repo\b|\bsummary file\b|\bmarkdown\b/i.test(fragment)) score += 80;
  if (/\bresearch\b|\bsearch\b|\bfind\b|\bcompare\b/i.test(fragment)) score += 20;
  return score;
}

function detectDependentOutputChain(input: {
  task: string;
  browserFragment: string;
  appFragment: string;
  filesystemFragment: string;
  hasBrowser: boolean;
  hasApp: boolean;
  hasFilesystem: boolean;
}): boolean {
  const outputFragments = [input.appFragment, input.filesystemFragment].filter(Boolean).join(' ');
  const outputish = OUTPUT_ACTION_MATCHER.test(outputFragments) && OUTPUT_OBJECT_MATCHER.test(outputFragments);
  const mixed = input.hasBrowser && (input.hasApp || input.hasFilesystem);
  return mixed && outputish;
}
