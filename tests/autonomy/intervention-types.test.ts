import { describe, expect, it, vi } from 'vitest';

const run = vi.fn();
const get = vi.fn();
const prepare = vi.fn(() => ({ run, get }));
vi.mock('../../src/main/db/database', () => ({ getDb: () => ({ prepare }) }));

describe('intervention type union', () => {
  it('accepts phone_required as a valid intervention type', async () => {
    const { createRunHumanIntervention } = await import('../../src/main/db/run-human-interventions');
    run.mockReturnValue({ lastInsertRowid: 1 });
    get.mockReturnValue({ id: 1, run_id: 'r1', status: 'pending', intervention_type: 'phone_required', target: null, summary: 'test', instructions: null, request_json: '{}', created_at: '2026-01-01', resolved_at: null });
    expect(() => createRunHumanIntervention('r1', {
      interventionType: 'phone_required',
      summary: 'Service requires a phone number',
    })).not.toThrow();
  });

  it('accepts unexpected_form as a valid intervention type', async () => {
    const { createRunHumanIntervention } = await import('../../src/main/db/run-human-interventions');
    run.mockReturnValue({ lastInsertRowid: 2 });
    get.mockReturnValue({ id: 2, run_id: 'r1', status: 'pending', intervention_type: 'unexpected_form', target: null, summary: 'test', instructions: null, request_json: '{}', created_at: '2026-01-01', resolved_at: null });
    expect(() => createRunHumanIntervention('r1', {
      interventionType: 'unexpected_form',
      summary: 'Signup form did not match known pattern',
    })).not.toThrow();
  });
});
