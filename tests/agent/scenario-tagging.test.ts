import { describe, expect, it } from 'vitest';
import { parseScenarioTag } from '../../src/main/agent/scenario-tagging';

describe('scenario tagging', () => {
  it('extracts an explicit scenario tag and removes it from the prompt', () => {
    expect(parseScenarioTag('[scenario: Browser Research Save] Research competitors and save a markdown file.')).toEqual({
      cleanedMessage: 'Research competitors and save a markdown file.',
      scenarioId: 'browser_research_save',
    });
  });

  it('infers benchmark scenario ids from known prompts', () => {
    expect(parseScenarioTag('Create a file called .tmp/test-note.md with a 5-line summary of what this repo does, then read it back and confirm the third line.').scenarioId)
      .toBe('repo_summary_roundtrip');
    expect(parseScenarioTag('Research 3 competitors to Clawdia and save a markdown comparison to .tmp/competitor-comparison.md with pricing, core features, and links.').scenarioId)
      .toBe('competitor_research_save');
    expect(parseScenarioTag('Open the system calculator app and enter 482 times 17, then tell me the result.').scenarioId)
      .toBe('gui_calculator_smoke');
  });

  it('leaves unrelated prompts untagged', () => {
    expect(parseScenarioTag('What is the capital of France?')).toEqual({
      cleanedMessage: 'What is the capital of France?',
      scenarioId: undefined,
    });
  });
});
