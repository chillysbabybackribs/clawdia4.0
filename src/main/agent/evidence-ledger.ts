export interface EvidenceFact {
  key: string;
  value: string | number | boolean;
  source: string;
  toolName: string;
  iterationIndex: number;
}

export interface EvidenceLedgerState {
  facts: EvidenceFact[];
}

export interface IngestEvidenceInput {
  toolName: string;
  detail?: string;
  input?: Record<string, any>;
  result: string;
  iterationIndex: number;
}

const MAX_FACTS = 30;
const MAX_RENDERED_FACTS = 12;

export function createEvidenceLedgerState(): EvidenceLedgerState {
  return { facts: [] };
}

export function ingestToolEvidence(
  state: EvidenceLedgerState,
  input: IngestEvidenceInput,
): void {
  if (input.toolName !== 'shell_exec') return;
  const command = String(input.input?.command || input.input?.cmd || input.detail || '').trim();
  if (!command || !/\bsqlite3\b/.test(command)) return;

  const parsedFacts = [
    ...parseSqliteLineFacts(input.result, command, input.iterationIndex, input.toolName),
    ...parseSqliteColumnFacts(input.result, command, input.iterationIndex, input.toolName),
  ];

  for (const fact of parsedFacts) {
    upsertFact(state, fact);
  }
}

export function buildEvidenceLedgerPromptBlock(state: EvidenceLedgerState): string | undefined {
  if (state.facts.length === 0) return undefined;
  const recentFacts = state.facts.slice(-MAX_RENDERED_FACTS);
  const lines = [
    'VERIFIED EVIDENCE LEDGER:',
    'Use the exact values below for local metrics unless you re-query the source of truth.',
  ];
  for (const fact of recentFacts) {
    lines.push(`- ${fact.key} = ${String(fact.value)} (source: ${fact.source})`);
  }
  return lines.join('\n');
}

function upsertFact(state: EvidenceLedgerState, nextFact: EvidenceFact): void {
  const existingIndex = state.facts.findIndex((fact) => fact.key === nextFact.key && fact.source === nextFact.source);
  if (existingIndex >= 0) {
    state.facts[existingIndex] = nextFact;
  } else {
    state.facts.push(nextFact);
    if (state.facts.length > MAX_FACTS) state.facts.splice(0, state.facts.length - MAX_FACTS);
  }
}

function parseSqliteLineFacts(
  text: string,
  source: string,
  iterationIndex: number,
  toolName: string,
): EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  const matches = [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/gm)];
  for (const match of matches) {
    const key = match[1];
    const rawValue = match[2].trim();
    facts.push({
      key,
      value: normalizeFactValue(rawValue),
      source,
      toolName,
      iterationIndex,
    });
  }
  return facts;
}

function parseSqliteColumnFacts(
  text: string,
  source: string,
  iterationIndex: number,
  toolName: string,
): EvidenceFact[] {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length < 3) return [];
  if (!/^-{2,}(?:\s+-{2,})*$/.test(lines[1])) return [];

  const headers = splitSqliteColumns(lines[0]);
  const rows = lines.slice(2).map(splitSqliteColumns).filter((row) => row.length === headers.length);
  if (headers.length === 0 || rows.length !== 1) return [];

  return headers.map((header, index) => ({
    key: header,
    value: normalizeFactValue(rows[0][index]),
    source,
    toolName,
    iterationIndex,
  }));
}

function splitSqliteColumns(line: string): string[] {
  return line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
}

function normalizeFactValue(rawValue: string): string | number | boolean {
  if (/^(true|false)$/i.test(rawValue)) return rawValue.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue);
  return rawValue;
}
