interface ScenarioParseResult {
  cleanedMessage: string;
  scenarioId?: string;
}

interface ScenarioPattern {
  id: string;
  test: (message: string) => boolean;
}

const EXPLICIT_SCENARIO_RE = /\[(?:scenario|workflow):\s*([a-z0-9][a-z0-9_\- ]*)\]/i;

const SCENARIO_PATTERNS: ScenarioPattern[] = [
  {
    id: 'repo_summary_roundtrip',
    test: (message) =>
      /test-note\.md/i.test(message)
      && /\bsummary of what this repo does\b/i.test(message)
      && /\bconfirm the third line\b/i.test(message),
  },
  {
    id: 'source_inventory_report',
    test: (message) =>
      /line-counts\.txt/i.test(message)
      && /\btop 15 largest TypeScript files\b/i.test(message),
  },
  {
    id: 'competitor_research_save',
    test: (message) =>
      /competitor-comparison\.md/i.test(message)
      && /\bcompetitor\b/i.test(message)
      && /\bpricing\b/i.test(message),
  },
  {
    id: 'recovery_parent_folder_repair',
    test: (message) =>
      /recovery-demo\/report\.md/i.test(message)
      && /\bparent folder does not exist\b/i.test(message),
  },
  {
    id: 'gui_calculator_smoke',
    test: (message) =>
      /\bcalculator\b/i.test(message)
      && /\b482\b/i.test(message)
      && /\b17\b/i.test(message),
  },
  {
    id: 'swarm_architecture_audit',
    test: (message) =>
      /\bin parallel\b/i.test(message)
      && /\bbrowser\b/i.test(message)
      && /\bagent loop\b/i.test(message)
      && /\bdatabase\b/i.test(message)
      && /\barchitecture summary\b/i.test(message),
  },
  {
    id: 'graph_execution_audit',
    test: (message) =>
      /\bgraph execution\b/i.test(message)
      && /\bparallel\b/i.test(message)
      && /\bdatabase\b/i.test(message)
      && /\bloop orchestration\b/i.test(message),
  },
  {
    id: 'unrestricted_mode_audit',
    test: (message) =>
      /\bunrestricted mode\b/i.test(message)
      && /\brenderer\b/i.test(message)
      && /\bmain process\b/i.test(message)
      && /\bdispatch\b/i.test(message),
  },
];

export function parseScenarioTag(message: string): ScenarioParseResult {
  const explicitMatch = message.match(EXPLICIT_SCENARIO_RE);
  if (explicitMatch) {
    const scenarioId = normalizeScenarioId(explicitMatch[1]);
    const cleanedMessage = message.replace(EXPLICIT_SCENARIO_RE, '').replace(/\s{2,}/g, ' ').trim();
    return {
      cleanedMessage,
      scenarioId: scenarioId || undefined,
    };
  }

  const trimmed = message.trim();
  const inferred = SCENARIO_PATTERNS.find((pattern) => pattern.test(trimmed));
  return {
    cleanedMessage: message,
    scenarioId: inferred?.id,
  };
}

function normalizeScenarioId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

