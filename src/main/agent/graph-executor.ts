import type { ProviderClient, NormalizedMessage } from './client';
import type { AgentProfile, ProviderId } from '../../shared/types';
import type { ExecutionGraph, GraphNode } from './execution-graph';
import { validateContractPayload } from './node-contracts';
import type { TaskExecutionGraphScaffold } from './task-compiler';

export interface GraphWorkerRunOptions {
  runId?: string;
  userMessage: string;
  history: NormalizedMessage[];
  provider: ProviderId;
  apiKey: string;
  forcedAgentProfile?: AgentProfile;
  model?: string;
  allowedTools?: string[];
  graphExecutionMode?: 'auto' | 'disabled';
  onStreamText?: (text: string) => void;
  onThinking?: (thought: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
  onProgress?: (text: string) => void;
}

export interface GraphExecutionResult {
  handled: boolean;
  response?: string;
}

export interface GraphExecutionSnapshot {
  graphId: string;
  task: string;
  status: 'running' | 'retrying' | 'verified' | 'fallback' | 'merged';
  nodeCount: number;
  nodes: Array<{
    nodeId: string;
    label: string;
    executorKind: string;
    status: 'pending' | 'running' | 'retrying' | 'done' | 'failed';
    attempt: number;
    contract: string;
    toolCalls: string[];
    verificationErrors: string[];
  }>;
  verification?: {
    passed: boolean;
    retryRecommended: boolean;
    checks: Array<{ nodeId: string; name: string; passed: boolean; detail: string }>;
  };
}

export interface GraphWorkerPayload {
  nodeId: string;
  label: string;
  executorKind: string;
  contract: string;
  response: string;
  structuredData: unknown | null;
  toolCalls: { name: string; status: string; detail?: string }[];
  attempt: number;
}

interface NodeVerificationResult {
  passed: boolean;
  retryRecommended: boolean;
  checks: Array<{ nodeId: string; name: string; passed: boolean; detail: string }>;
}

export function canExecuteGraphScaffold(scaffold: TaskExecutionGraphScaffold | null): boolean {
  if (!scaffold) return false;
  const graph = scaffold.planner.graph;
  const workerNodes = graph.nodes.filter((node) => node.kind === 'worker');
  const verifierNodes = graph.nodes.filter((node) => node.kind === 'verifier');
  const mergeNodes = graph.nodes.filter((node) => node.kind === 'merge');
  return workerNodes.length >= 1 && workerNodes.length <= 3 && verifierNodes.length === 1 && mergeNodes.length === 1;
}

export function mapExecutorToAgentProfile(node: GraphNode): AgentProfile {
  switch (node.executor.kind) {
    case 'browser_cdp': return 'scout';
    case 'app_cli_anything': return 'coordinator';
    case 'filesystem_core': return 'builder';
    case 'runtime_verifier': return 'reviewer';
    default: return 'general';
  }
}

export function verifyGraphNodeResult(node: GraphNode, result: string): {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  retryRecommended: boolean;
} {
  const checks = [
    {
      name: 'non_error_result',
      passed: !result.startsWith('[Error'),
      detail: result.startsWith('[Error') ? result.slice(0, 160) : 'Worker returned non-error output',
    },
    {
      name: 'non_empty_result',
      passed: result.trim().length > 20,
      detail: `Output length=${result.trim().length}`,
    },
    {
      name: 'contract_presence',
      passed: !!node.output?.schemaName,
      detail: `Contract=${node.output?.schemaName || 'missing'}`,
    },
  ];
  const passed = checks.every((check) => check.passed);
  return {
    passed,
    checks,
    retryRecommended: !passed && node.policy.retryLimit > 0,
  };
}

export function parseStructuredWorkerOutput(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    fencedMatch?.[1]?.trim(),
    trimmed,
    ...extractBalancedJsonCandidates(trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function getContractExample(schemaName: string): string | null {
  switch (schemaName) {
    case 'BrowserResearchOutput':
      return JSON.stringify({
        findings: [
          {
            title: 'Logitech MX Keys S',
            url: 'https://example.com/logitech-mx-keys-s',
            facts: ['Quiet low-profile typing', 'Bluetooth and USB-C charging', 'Good for office use'],
            confidence: 0.9,
          },
          {
            title: 'Keychron K5 Max',
            url: 'https://example.com/keychron-k5-max',
            facts: ['Mechanical switches', 'Wireless and wired connectivity', 'May be louder than low-profile office boards'],
            confidence: 0.82,
          },
        ],
        recommendedNextUrls: ['https://example.com/logitech-mx-keys-s'],
        blockers: [],
      }, null, 2);
    case 'ProductCompareOutput':
      return JSON.stringify({
        products: [
          {
            title: 'Logitech MX Keys S',
            url: 'https://example.com/logitech-mx-keys-s',
            price: '$109.99',
            rating: '4.6',
            reviewCount: '1234',
            pros: ['Quiet typing', 'Solid battery life'],
            cons: ['Expensive'],
          },
        ],
        winner: 'Logitech MX Keys S',
        rationale: 'Best balance of quiet typing and office ergonomics.',
      }, null, 2);
    case 'AppTaskOutput':
      return JSON.stringify({
        appId: 'filesystem',
        actionLog: ['Created markdown file', 'Wrote summary content'],
        artifacts: [{ path: '/tmp/summary.md', kind: 'text/markdown' }],
        stateSummary: 'Requested artifact created successfully.',
        blockers: [],
      }, null, 2);
    default:
      return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function normalizeBrowserResearchPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;

  if (Array.isArray(record.findings)) {
    const findings = record.findings
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const finding = item as Record<string, unknown>;
        const title = toStringOrNull(finding.title) || toStringOrNull(finding.name);
        const url = toStringOrNull(finding.url) || toStringOrNull(finding.link);
        const facts = toStringArray(finding.facts).length > 0
          ? toStringArray(finding.facts)
          : [...toStringArray(finding.pros), ...toStringArray(finding.cons)];
        const confidenceValue = typeof finding.confidence === 'number'
          ? finding.confidence
          : typeof finding.score === 'number'
            ? finding.score
            : 0.75;

        if (!title || !url || facts.length === 0) return null;
        return { title, url, facts, confidence: confidenceValue };
      })
      .filter((item): item is { title: string; url: string; facts: string[]; confidence: number } => Boolean(item));

    return {
      findings,
      recommendedNextUrls: toStringArray(record.recommendedNextUrls),
      blockers: toStringArray(record.blockers),
    };
  }

  const candidates = Array.isArray(record.products)
    ? record.products
    : Array.isArray(record.rows)
      ? record.rows
      : [];

  if (candidates.length === 0) return payload;

  const findings = candidates
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const candidate = item as Record<string, unknown>;
      const title = toStringOrNull(candidate.title) || toStringOrNull(candidate.name);
      const url = toStringOrNull(candidate.url) || toStringOrNull(candidate.link);
      const facts = [
        ...toStringArray(candidate.facts),
        ...toStringArray(candidate.pros),
        ...toStringArray(candidate.highlights),
      ].filter(Boolean);
      if (!title || !url || facts.length === 0) return null;
      return { title, url, facts, confidence: 0.8 };
    })
    .filter((item): item is { title: string; url: string; facts: string[]; confidence: number } => Boolean(item));

  return {
    findings,
    recommendedNextUrls: findings.map((item) => item.url).slice(0, 3),
    blockers: toStringArray(record.blockers),
  };
}

function normalizeStructuredPayloadForContract(schemaName: string, payload: unknown): unknown {
  switch (schemaName) {
    case 'BrowserResearchOutput':
      return normalizeBrowserResearchPayload(payload);
    default:
      return payload;
  }
}

function extractBalancedJsonCandidates(text: string): string[] {
  const starts = ['{', '['];
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!starts.includes(text[i])) continue;
    const open = text[i];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function verifyExecutorEvidence(node: GraphNode, payload: GraphWorkerPayload): Array<{ name: string; passed: boolean; detail: string }> {
  const toolNames = payload.toolCalls.map((toolCall) => toolCall.name);
  const hasAnyTools = toolNames.length > 0;

  if (node.executor.kind === 'browser_cdp') {
    return [{
      name: 'browser_tool_evidence',
      passed: hasAnyTools && toolNames.some((name) => name.startsWith('browser_')),
      detail: `toolCalls=${toolNames.join(', ') || 'none'}`,
    }];
  }

  if (node.executor.kind === 'app_cli_anything') {
    return [{
      name: 'app_tool_evidence',
      passed: hasAnyTools && toolNames.some((name) => name === 'app_control' || name === 'gui_interact' || name === 'dbus_control'),
      detail: `toolCalls=${toolNames.join(', ') || 'none'}`,
    }];
  }

  if (node.executor.kind === 'filesystem_core') {
    return [{
      name: 'filesystem_tool_evidence',
      passed: hasAnyTools && toolNames.some((name) => name === 'shell_exec' || name.startsWith('file_') || name.startsWith('fs_')),
      detail: `toolCalls=${toolNames.join(', ') || 'none'}`,
    }];
  }

  return [{
    name: 'tool_call_evidence',
    passed: hasAnyTools,
    detail: `toolCalls=${toolNames.join(', ') || 'none'}`,
  }];
}

function getEvidenceRequirements(node: GraphNode): string[] {
  const evidencePlan = node.inputs.find((input) => input.name === 'evidence_plan')?.value;
  if (!evidencePlan || typeof evidencePlan !== 'object' || Array.isArray(evidencePlan)) return [];
  const required = (evidencePlan as Record<string, unknown>).required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === 'string') : [];
}

function buildEvidenceExecutionGuidance(evidenceRequirements: string[]): string[] {
  if (evidenceRequirements.length === 0) return [];

  const lines = ['Evidence acquisition rules:'];

  if (evidenceRequirements.includes('expert_reviews')) {
    lines.push('- Acquire at least one expert review source early and extract concrete findings from it.');
  }
  if (evidenceRequirements.includes('official_product_pages')) {
    lines.push('- Acquire at least one official product or direct product page and extract concrete product facts from it.');
  }
  if (evidenceRequirements.includes('pricing')) {
    lines.push('- Capture current pricing from a direct product/listing source, not a generic roundup page.');
  }
  if (evidenceRequirements.includes('user_sentiment')) {
    lines.push('- Add one user-sentiment source only after expert review and product-page coverage are satisfied.');
  }
  if (evidenceRequirements.includes('images')) {
    lines.push('- Collect image evidence only if the task explicitly asks for it.');
  }
  if (evidenceRequirements.includes('videos')) {
    lines.push('- Collect video evidence only if the task explicitly asks for it.');
  }
  if (evidenceRequirements.includes('academic_sources')) {
    lines.push('- Collect academic or white-paper evidence only if the task explicitly asks for it.');
  }

  lines.push('- Prefer direct links discovered from search results or extracted page links. Do not guess slugs or invent URLs.');
  lines.push('- Once you have enough sources to satisfy the required evidence types, stop browsing and return the structured result.');
  lines.push('- Avoid revisiting broad roundup or search-result pages unless you still lack a required evidence type.');

  return lines;
}

function looksLikeReviewSource(url: string): boolean {
  return /(rtings\.com|techgearlab\.com|pcguide\.com|wirecutter\.com|tomshardware\.com|forbes\.com|youtube\.com)/i.test(url);
}

function looksLikeProductPage(url: string): boolean {
  return /(amazon\.com\/(?:dp|gp\/product)\/|\/products\/|\/shop\/p\/|\/p\/)/i.test(url);
}

function looksLikeSearchResults(url: string): boolean {
  return /(google\.com\/search|amazon\.com\/s\?|rtings\.com\/keyboard\/reviews\/best\/|pcguide\.com\/keyboard\/guide\/best-)/i.test(url);
}

function verifyEvidenceCoverage(node: GraphNode, payload: GraphWorkerPayload): Array<{ name: string; passed: boolean; detail: string }> {
  if (node.executor.kind !== 'browser_cdp' || node.output.schemaName !== 'BrowserResearchOutput') return [];
  if (!payload.structuredData || typeof payload.structuredData !== 'object' || Array.isArray(payload.structuredData)) return [];

  const record = payload.structuredData as Record<string, unknown>;
  const findings = Array.isArray(record.findings)
    ? record.findings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const urls = findings
    .map((finding) => (typeof finding.url === 'string' ? finding.url : ''))
    .filter(Boolean);
  const domains = [...new Set(urls.map((url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }))];
  const averageFactsPerFinding = findings.length > 0
    ? findings.reduce((sum, finding) => sum + toStringArray(finding.facts).length, 0) / findings.length
    : 0;
  const requirements = getEvidenceRequirements(node);

  const checks: Array<{ name: string; passed: boolean; detail: string }> = [{
    name: 'minimum_findings',
    passed: findings.length >= 2,
    detail: `findings=${findings.length}`,
  }, {
    name: 'finding_fact_density',
    passed: averageFactsPerFinding >= 2,
    detail: `avg_facts_per_finding=${averageFactsPerFinding.toFixed(2)}`,
  }, {
    name: 'search_results_not_used_as_final_findings',
    passed: urls.every((url) => !looksLikeSearchResults(url)),
    detail: `urls=${urls.join(', ') || 'none'}`,
  }];

  if (requirements.includes('expert_reviews')) {
    checks.push({
      name: 'expert_review_coverage',
      passed: urls.some((url) => looksLikeReviewSource(url)),
      detail: `urls=${urls.join(', ') || 'none'}`,
    });
  }

  if (requirements.includes('official_product_pages')) {
    checks.push({
      name: 'official_product_page_coverage',
      passed: urls.some((url) => looksLikeProductPage(url)),
      detail: `urls=${urls.join(', ') || 'none'}`,
    });
  }

  if (requirements.length >= 2) {
    checks.push({
      name: 'source_domain_diversity',
      passed: domains.length >= 2,
      detail: `domains=${domains.join(', ') || 'none'}`,
    });
  }

  return checks;
}

export function buildWorkerPayload(
  node: GraphNode,
  result: { response: string; toolCalls: { name: string; status: string; detail?: string }[] },
  attempt = 1,
): GraphWorkerPayload {
  const structuredData = normalizeStructuredPayloadForContract(
    node.output.schemaName,
    parseStructuredWorkerOutput(result.response),
  );
  return {
    nodeId: node.id,
    label: node.label,
    executorKind: node.executor.kind,
    contract: node.output.schemaName,
    response: result.response,
    structuredData,
    toolCalls: result.toolCalls,
    attempt,
  };
}

function getUpstreamPayloads(node: GraphNode, availablePayloads: GraphWorkerPayload[]): GraphWorkerPayload[] {
  const upstreamIds = node.inputs
    .filter((input) => input.source === 'node_output' && input.fromNodeId)
    .map((input) => input.fromNodeId as string);
  return availablePayloads.filter((payload) => upstreamIds.includes(payload.nodeId));
}

export function getWorkerDependencyChain(graph: ExecutionGraph, workerNodes: GraphNode[]): GraphNode[] | null {
  const workerIds = new Set(workerNodes.map((node) => node.id));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();

  for (const node of workerNodes) {
    const upstreamWorkerIds = node.inputs
      .filter((input) => input.source === 'node_output' && input.fromNodeId && workerIds.has(input.fromNodeId))
      .map((input) => input.fromNodeId as string);
    dependencies.set(node.id, upstreamWorkerIds);
    for (const upstreamId of upstreamWorkerIds) {
      const items = dependents.get(upstreamId) || [];
      items.push(node.id);
      dependents.set(upstreamId, items);
    }
  }

  const roots = workerNodes.filter((node) => (dependencies.get(node.id) || []).length === 0);
  const hasAnyDependency = workerNodes.some((node) => (dependencies.get(node.id) || []).length > 0);
  if (!hasAnyDependency) return null;
  if (roots.length !== 1) return null;
  if (workerNodes.some((node) => (dependencies.get(node.id) || []).length > 1)) return null;
  if ([...dependents.values()].some((items) => items.length > 1)) return null;

  const ordered: GraphNode[] = [];
  let currentId: string | undefined = roots[0]?.id;
  while (currentId) {
    const node = workerNodes.find((candidate) => candidate.id === currentId);
    if (!node) return null;
    ordered.push(node);
    const next: string[] = dependents.get(currentId) || [];
    currentId = next[0];
  }

  if (ordered.length !== workerNodes.length) return null;

  const edgeSet = new Set(graph.edges.filter((edge) => edge.kind === 'serial').map((edge) => `${edge.from}->${edge.to}`));
  for (let i = 1; i < ordered.length; i++) {
    if (!edgeSet.has(`${ordered[i - 1].id}->${ordered[i].id}`)) return null;
  }
  return ordered;
}

function verifySingleWorkerPayload(node: GraphNode, payload: GraphWorkerPayload): NodeVerificationResult {
  const verification = verifyWorkerPayloads([node], [payload]);
  return {
    passed: verification.passed,
    retryRecommended: verification.retryRecommended,
    checks: verification.checks,
  };
}

export function buildGraphWorkerUserMessage(
  node: GraphNode,
  originalTask: string,
  availablePayloads: GraphWorkerPayload[] = [],
): string {
  const taskFragment = node.inputs.find((input) => input.name === 'task_fragment')?.value;
  const effectiveTask = typeof taskFragment === 'string' && taskFragment.trim().length > 0
    ? taskFragment.trim()
    : originalTask.trim();
  const upstreamPayloads = getUpstreamPayloads(node, availablePayloads);
  const evidenceRequirements = getEvidenceRequirements(node);

  const lines = [
    `User task: ${effectiveTask}`,
    `Worker role: ${node.label}`,
    `Worker objective: ${node.objective}`,
    `Executor: ${node.executor.kind}`,
    `Required output contract: ${node.output.schemaName}`,
    `Return format: a single JSON object matching the required output contract. Do not wrap it in prose.`,
    `Required top-level fields: ${node.output.required.join(', ')}`,
    'Execution rules:',
    '- Stay tightly focused on the user task above.',
    '- Do not perform generic executor, browser, or network capability checks.',
    '- Prefer the scoped tools assigned to this worker.',
    '- If you cannot complete the task cleanly, say exactly what information or page state is missing.',
  ];

  lines.push(...buildEvidenceExecutionGuidance(evidenceRequirements));

  const contractExample = getContractExample(node.output.schemaName);
  if (contractExample) {
    lines.push(
      `Example valid ${node.output.schemaName} JSON:`,
      contractExample,
      'Return JSON in that shape with all required fields populated.',
    );
  }

  if (upstreamPayloads.length > 0) {
    lines.push(
      'Upstream structured inputs:',
      JSON.stringify(
        upstreamPayloads.map((payload) => ({
          nodeId: payload.nodeId,
          label: payload.label,
          contract: payload.contract,
          structuredData: payload.structuredData,
        })),
        null,
        2,
      ),
      'Use the upstream structured inputs above as source material for this worker. Do not ignore them.',
    );
  }

  return lines.join('\n');
}

export function verifyWorkerPayloads(nodes: GraphNode[], payloads: GraphWorkerPayload[]) {
  const checks = payloads.flatMap((payload) => {
    const node = nodes.find((candidate) => candidate.id === payload.nodeId)!;
    const contractValidation = validateContractPayload(node.output, payload.structuredData);
    return [
      ...verifyGraphNodeResult(node, payload.response).checks,
      {
        name: 'structured_contract_parse',
        passed: payload.structuredData !== null,
        detail: payload.structuredData !== null ? 'Structured JSON payload parsed' : 'Could not parse structured JSON payload',
      },
      {
        name: 'structured_contract_validation',
        passed: contractValidation.valid,
        detail: contractValidation.valid ? 'Payload matches declared contract' : contractValidation.errors.join('; '),
      },
      ...verifyEvidenceCoverage(node, payload),
      ...verifyExecutorEvidence(node, payload),
    ].map((check) => ({ nodeId: payload.nodeId, ...check }));
  });
  const passed = checks.every((check) => check.passed);
  const retryRecommended = payloads.some((payload) => {
    const node = nodes.find((candidate) => candidate.id === payload.nodeId)!;
    return checks.some((check) => check.nodeId === payload.nodeId && !check.passed) && node.policy.retryLimit > 0;
  });
  return { passed, checks, retryRecommended };
}

export function buildGraphWorkerRetryUserMessage(
  node: GraphNode,
  originalTask: string,
  payload: GraphWorkerPayload,
  verificationChecks: Array<{ nodeId: string; name: string; passed: boolean; detail: string }>,
  availablePayloads: GraphWorkerPayload[] = [],
): string {
  const failedChecks = verificationChecks
    .filter((check) => check.nodeId === node.id && !check.passed)
    .map((check) => `- ${check.name}: ${check.detail}`);

  return [
    buildGraphWorkerUserMessage(node, originalTask, availablePayloads),
    '',
    `Retry attempt: ${payload.attempt + 1}`,
    'Previous attempt failed verification. Fix the issues below and return a single JSON object matching the required contract.',
    ...failedChecks,
  ].join('\n');
}

async function runGraphWorkerNode(
  workerNode: GraphNode,
  runWorkerLoop: (options: GraphWorkerRunOptions) => Promise<{ response: string; toolCalls: { name: string; status: string; detail?: string }[] }>,
  workerBaseOptions: Omit<GraphWorkerRunOptions, 'userMessage' | 'history' | 'forcedAgentProfile' | 'allowedTools'>,
  userMessage: string,
  attempt: number,
): Promise<GraphWorkerPayload> {
  const result = await runWorkerLoop({
    ...workerBaseOptions,
    runId: workerBaseOptions.runId ? `${workerBaseOptions.runId}-${workerNode.id}` : undefined,
    userMessage,
    history: [],
    forcedAgentProfile: mapExecutorToAgentProfile(workerNode),
    allowedTools: workerNode.executor.toolScope,
    graphExecutionMode: 'disabled',
  });
  return buildWorkerPayload(workerNode, result, attempt);
}

export async function executeGraphScaffold(params: {
  scaffold: TaskExecutionGraphScaffold;
  originalUserMessage: string;
  client: ProviderClient;
  staticPrompt: string;
  dynamicPrompt: string;
  runWorkerLoop: (options: GraphWorkerRunOptions) => Promise<{ response: string; toolCalls: { name: string; status: string; detail?: string }[] }>;
  workerBaseOptions: Omit<GraphWorkerRunOptions, 'userMessage' | 'history' | 'forcedAgentProfile' | 'allowedTools'>;
  onGraphEvent?: (event: { kind: string; phase?: string; payload: Record<string, any> }) => void;
  onGraphState?: (snapshot: GraphExecutionSnapshot) => void;
}): Promise<GraphExecutionResult> {
  const { scaffold, originalUserMessage, client, staticPrompt, dynamicPrompt, runWorkerLoop, workerBaseOptions, onGraphEvent, onGraphState } = params;
  if (!canExecuteGraphScaffold(scaffold)) return { handled: false };

  const graph: ExecutionGraph = scaffold.planner.graph;
  const workerNodes = graph.nodes.filter((node) => node.kind === 'worker');
  const verifierNode = graph.nodes.find((node) => node.kind === 'verifier');
  const mergeNode = graph.nodes.find((node) => node.kind === 'merge');
  if (workerNodes.length === 0 || !verifierNode || !mergeNode) return { handled: false };
  const dependentWorkerChain = getWorkerDependencyChain(graph, workerNodes);

  const emitState = (
    status: GraphExecutionSnapshot['status'],
    payloads: GraphWorkerPayload[],
    verification?: GraphExecutionSnapshot['verification'],
  ) => {
    onGraphState?.({
      graphId: graph.id,
      task: graph.task,
      status,
      nodeCount: graph.nodes.length,
      nodes: workerNodes.map((node) => {
        const payload = payloads.find((candidate) => candidate.nodeId === node.id);
        const nodeChecks = verification?.checks.filter((check) => check.nodeId === node.id && !check.passed) || [];
        return {
          nodeId: node.id,
          label: node.label,
          executorKind: node.executor.kind,
          status: !payload
            ? 'pending'
            : nodeChecks.length > 0
              ? (status === 'retrying' ? 'retrying' : 'failed')
              : status === 'merged' || status === 'verified'
                ? 'done'
                : 'running',
          attempt: payload?.attempt || 0,
          contract: node.output.schemaName,
          toolCalls: payload?.toolCalls.map((toolCall) => toolCall.name) || [],
          verificationErrors: nodeChecks.map((check) => `${check.name}: ${check.detail}`),
        };
      }),
      verification,
    });
  };

  onGraphEvent?.({
    kind: 'graph_execution_started',
    phase: 'planning',
    payload: {
      graphId: graph.id,
      task: graph.task,
      workerNodeIds: workerNodes.map((node) => node.id),
      verifierNodeId: verifierNode.id,
      mergeNodeId: mergeNode.id,
    },
  });
  emitState('running', []);

  let workerResults: GraphWorkerPayload[];
  if (dependentWorkerChain) {
    workerResults = [];
    for (const workerNode of dependentWorkerChain) {
      onGraphEvent?.({
        kind: 'graph_node_started',
        phase: 'executing',
        payload: {
          graphId: graph.id,
          nodeId: workerNode.id,
          label: workerNode.label,
          attempt: 1,
          executorKind: workerNode.executor.kind,
        },
      });
      let payload = await runGraphWorkerNode(
        workerNode,
        runWorkerLoop,
        workerBaseOptions,
        buildGraphWorkerUserMessage(workerNode, originalUserMessage, workerResults),
        1,
      );
      onGraphEvent?.({
        kind: 'graph_node_completed',
        phase: 'executing',
        payload: {
          graphId: graph.id,
          nodeId: payload.nodeId,
          label: payload.label,
          attempt: payload.attempt,
          toolCalls: payload.toolCalls.map((toolCall) => toolCall.name),
        },
      });
      let nodeVerification = verifySingleWorkerPayload(workerNode, payload);
      emitState(nodeVerification.passed ? 'running' : nodeVerification.retryRecommended ? 'retrying' : 'fallback', [...workerResults, payload], {
        passed: nodeVerification.passed,
        retryRecommended: nodeVerification.retryRecommended,
        checks: nodeVerification.checks,
      });
      if (!nodeVerification.passed && nodeVerification.retryRecommended) {
        onGraphEvent?.({
          kind: 'graph_node_retry_scheduled',
          phase: 'reviewing',
          payload: {
            graphId: graph.id,
            nodeId: workerNode.id,
            failedChecks: nodeVerification.checks.filter((check) => !check.passed),
          },
        });
        onGraphEvent?.({
          kind: 'graph_node_started',
          phase: 'executing',
          payload: {
            graphId: graph.id,
            nodeId: workerNode.id,
            label: workerNode.label,
            attempt: payload.attempt + 1,
            executorKind: workerNode.executor.kind,
            retry: true,
          },
        });
        payload = await runGraphWorkerNode(
          workerNode,
          runWorkerLoop,
          workerBaseOptions,
          buildGraphWorkerRetryUserMessage(workerNode, originalUserMessage, payload, nodeVerification.checks, workerResults),
          payload.attempt + 1,
        );
        onGraphEvent?.({
          kind: 'graph_node_completed',
          phase: 'executing',
          payload: {
            graphId: graph.id,
            nodeId: payload.nodeId,
            label: payload.label,
            attempt: payload.attempt,
            toolCalls: payload.toolCalls.map((toolCall) => toolCall.name),
          },
        });
        nodeVerification = verifySingleWorkerPayload(workerNode, payload);
      }
      onGraphEvent?.({
        kind: 'graph_verification_completed',
        phase: 'reviewing',
        payload: {
          graphId: graph.id,
          passed: nodeVerification.passed,
          retryRecommended: nodeVerification.retryRecommended,
          failedNodeIds: nodeVerification.checks.filter((check) => !check.passed).map((check) => check.nodeId),
          nodeId: workerNode.id,
        },
      });
      if (!nodeVerification.passed) {
        onGraphEvent?.({
          kind: 'graph_execution_fallback',
          phase: 'reviewing',
          payload: {
            graphId: graph.id,
            failedNodeIds: [workerNode.id],
          },
        });
        emitState('fallback', [...workerResults, payload], {
          passed: false,
          retryRecommended: false,
          checks: nodeVerification.checks,
        });
        return { handled: false };
      }
      workerResults.push(payload);
    }
  } else {
    workerResults = await Promise.all(workerNodes.map((workerNode) => runGraphWorkerNode(
      (onGraphEvent?.({
        kind: 'graph_node_started',
        phase: 'executing',
        payload: {
          graphId: graph.id,
          nodeId: workerNode.id,
          label: workerNode.label,
          attempt: 1,
          executorKind: workerNode.executor.kind,
        },
      }), workerNode),
      runWorkerLoop,
      workerBaseOptions,
      buildGraphWorkerUserMessage(workerNode, originalUserMessage),
      1,
    )));
    for (const payload of workerResults) {
      onGraphEvent?.({
        kind: 'graph_node_completed',
        phase: 'executing',
        payload: {
          graphId: graph.id,
          nodeId: payload.nodeId,
          label: payload.label,
          attempt: payload.attempt,
          toolCalls: payload.toolCalls.map((toolCall) => toolCall.name),
        },
      });
    }
  }
  emitState('running', workerResults);

  let verification = verifyWorkerPayloads(workerNodes, workerResults);
  onGraphEvent?.({
    kind: 'graph_verification_completed',
    phase: 'reviewing',
    payload: {
      graphId: graph.id,
      passed: verification.passed,
      retryRecommended: verification.retryRecommended,
      failedNodeIds: [...new Set(verification.checks.filter((check) => !check.passed).map((check) => check.nodeId))],
    },
  });
  emitState(verification.passed ? 'verified' : verification.retryRecommended ? 'retrying' : 'fallback', workerResults, verification);
  if (!verification.passed && verification.retryRecommended) {
    const failedNodeIds = new Set(verification.checks.filter((check) => !check.passed).map((check) => check.nodeId));
    for (const nodeId of failedNodeIds) {
      onGraphEvent?.({
        kind: 'graph_node_retry_scheduled',
        phase: 'reviewing',
        payload: {
          graphId: graph.id,
          nodeId,
          failedChecks: verification.checks.filter((check) => check.nodeId === nodeId && !check.passed),
        },
      });
    }
    workerResults = await Promise.all(workerResults.map(async (payload) => {
      const node = workerNodes.find((candidate) => candidate.id === payload.nodeId)!;
      const remainingRetries = node.policy.retryLimit - (payload.attempt - 1);
      if (!failedNodeIds.has(payload.nodeId) || remainingRetries <= 0) return payload;
      onGraphEvent?.({
        kind: 'graph_node_started',
        phase: 'executing',
        payload: {
          graphId: graph.id,
          nodeId: node.id,
          label: node.label,
          attempt: payload.attempt + 1,
          executorKind: node.executor.kind,
          retry: true,
        },
      });
      return await runGraphWorkerNode(
        node,
        runWorkerLoop,
        workerBaseOptions,
        buildGraphWorkerRetryUserMessage(node, originalUserMessage, payload, verification.checks, workerResults.filter((candidate) => candidate.nodeId !== payload.nodeId)),
        payload.attempt + 1,
      );
    }));
    for (const payload of workerResults) {
      if (failedNodeIds.has(payload.nodeId)) {
        onGraphEvent?.({
          kind: 'graph_node_completed',
          phase: 'executing',
          payload: {
            graphId: graph.id,
            nodeId: payload.nodeId,
            label: payload.label,
            attempt: payload.attempt,
            toolCalls: payload.toolCalls.map((toolCall) => toolCall.name),
          },
        });
      }
    }
    verification = verifyWorkerPayloads(workerNodes, workerResults);
    onGraphEvent?.({
      kind: 'graph_verification_completed',
      phase: 'reviewing',
      payload: {
        graphId: graph.id,
        passed: verification.passed,
        retryRecommended: verification.retryRecommended,
        failedNodeIds: [...new Set(verification.checks.filter((check) => !check.passed).map((check) => check.nodeId))],
        afterRetry: true,
      },
    });
    emitState(verification.passed ? 'verified' : 'fallback', workerResults, verification);
  }

  if (!verification.passed) {
    onGraphEvent?.({
      kind: 'graph_execution_fallback',
      phase: 'reviewing',
      payload: {
        graphId: graph.id,
        failedNodeIds: [...new Set(verification.checks.filter((check) => !check.passed).map((check) => check.nodeId))],
      },
    });
    emitState('fallback', workerResults, verification);
    return { handled: false };
  }
  onGraphEvent?.({
    kind: 'graph_merge_started',
    phase: 'reviewing',
    payload: {
      graphId: graph.id,
      mergeNodeId: mergeNode.id,
      workerCount: workerResults.length,
    },
  });
  const mergePrompt = [
    'You are the merge node for a guarded execution graph.',
    `Worker count: ${workerResults.length}`,
    `Verification passed: ${verification.passed}`,
    `Verification checks: ${JSON.stringify(verification.checks)}`,
    'Produce a concise final response for the user based on the structured worker payloads below.',
    'If verification failed, explain that the graph fell back or needs follow-up.',
    '',
    '[WORKER PAYLOADS]',
    JSON.stringify(workerResults, null, 2),
  ].join('\n');

  let mergedText = '';
  const mergeResponse = await client.chat(
    [{ role: 'user', content: mergePrompt }],
    [],
    staticPrompt,
    dynamicPrompt,
    (chunk) => { mergedText += chunk; },
    { maxTokens: 1200 },
  );

  const text = mergeResponse.content
    .filter((block): block is Extract<typeof mergeResponse.content[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  emitState('merged', workerResults, verification);
  onGraphEvent?.({
    kind: 'graph_merge_completed',
    phase: 'completed',
    payload: {
      graphId: graph.id,
      mergeNodeId: mergeNode.id,
      responseLength: (text || '').length,
    },
  });

  return {
    handled: true,
    response: text || workerResults.map((payload) => payload.response).join('\n\n'),
  };
}
