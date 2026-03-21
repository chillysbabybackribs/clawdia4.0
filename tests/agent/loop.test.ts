import { describe, expect, it } from 'vitest';
import { isExplicitSwarmRequest } from '../../src/main/agent/loop';

describe('isExplicitSwarmRequest()', () => {
  it('detects swarm/coordinator prompts', () => {
    expect(isExplicitSwarmRequest('Use agent_spawn to launch two browser workers')).toBe(true);
    expect(isExplicitSwarmRequest('Spawn 2 parallel sub-agents and compare results')).toBe(true);
  });

  it('does not flag ordinary browser prompts', () => {
    expect(isExplicitSwarmRequest('Navigate to example.com and summarize it')).toBe(false);
  });
});
