import { describe, expect, it } from 'vitest';
import {
  buildEvidenceLedgerPromptBlock,
  createEvidenceLedgerState,
  ingestToolEvidence,
} from '../../src/main/agent/evidence-ledger';

describe('evidence-ledger', () => {
  it('extracts facts from sqlite line mode output', () => {
    const state = createEvidenceLedgerState();

    ingestToolEvidence(state, {
      toolName: 'shell_exec',
      input: { command: 'sqlite3 ~/.config/clawdia/data.sqlite ".mode line" "SELECT COUNT(*) AS total_runs;"' },
      result: 'total_runs = 20\nfailed_runs = 4',
      iterationIndex: 2,
    });

    expect(state.facts).toEqual([
      expect.objectContaining({ key: 'total_runs', value: 20 }),
      expect.objectContaining({ key: 'failed_runs', value: 4 }),
    ]);
  });

  it('extracts facts from sqlite column mode single-row output', () => {
    const state = createEvidenceLedgerState();

    ingestToolEvidence(state, {
      toolName: 'shell_exec',
      input: { command: 'sqlite3 ~/.config/clawdia/data.sqlite ".headers on" ".mode column" "SELECT COUNT(*) AS total_runs, 4 AS failed_runs;"' },
      result: [
        'total_runs  failed_runs',
        '----------  -----------',
        '20          4',
      ].join('\n'),
      iterationIndex: 3,
    });

    expect(state.facts).toEqual([
      expect.objectContaining({ key: 'total_runs', value: 20 }),
      expect.objectContaining({ key: 'failed_runs', value: 4 }),
    ]);
  });

  it('renders a compact verified evidence block', () => {
    const state = createEvidenceLedgerState();
    ingestToolEvidence(state, {
      toolName: 'shell_exec',
      input: { command: 'sqlite3 ~/.config/clawdia/data.sqlite ".mode line" "SELECT COUNT(*) AS total_runs;"' },
      result: 'total_runs = 20',
      iterationIndex: 1,
    });

    const block = buildEvidenceLedgerPromptBlock(state);
    expect(block).toContain('VERIFIED EVIDENCE LEDGER');
    expect(block).toContain('total_runs = 20');
  });
});
