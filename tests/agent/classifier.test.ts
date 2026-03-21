import { describe, it, expect } from 'vitest';
import { classify } from '../../src/main/agent/classifier';

describe('classify() — greeting detection', () => {
  it('classifies bare greetings as isGreeting=true', () => {
    for (const msg of ['hi', 'hello', 'hey', 'yo', 'sup']) {
      const r = classify(msg);
      expect(r.isGreeting, msg).toBe(true);
      expect(r.model, msg).toBe('haiku');
    }
  });

  it('does not classify non-greetings as greeting', () => {
    expect(classify('hi, can you open GIMP').isGreeting).toBe(false);
  });
});

describe('classify() — tool group routing', () => {
  it('routes browser tasks to browser group', () => {
    expect(classify('search google for tailwind docs').toolGroup).toBe('browser');
    expect(classify('go to https://github.com').toolGroup).toBe('browser');
  });

  it('routes coordination-style browser tasks to full group so agent_spawn is available', () => {
    expect(classify('spawn 2 parallel sub-agents to browse example.com and compare results').toolGroup).toBe('full');
    expect(classify('use agent_spawn to coordinate two workers on browser tasks').toolGroup).toBe('full');
  });

  it('routes filesystem tasks to core group', () => {
    expect(classify('read file src/main/main.ts').toolGroup).toBe('core');
    expect(classify('edit package.json to add a dependency').toolGroup).toBe('core');
  });

  it('routes desktop app tasks to full group', () => {
    expect(classify('open GIMP and resize the image').toolGroup).toBe('full');
    expect(classify('launch blender').toolGroup).toBe('full');
  });

  it('routes document creation to full group', () => {
    expect(classify('create a PDF report of my findings').toolGroup).toBe('full');
  });

  it('routes multi-domain tasks to full group', () => {
    // browser (github) + coding (package.json) = multi-domain = full
    expect(classify('search github and edit the package.json').toolGroup).toBe('full');
  });

  it('defaults unknown tasks to full group', () => {
    expect(classify('what is the weather like today in Paris').toolGroup).toBe('full');
  });
});

describe('classify() — agent profile routing', () => {
  it('sets bloodhound profile on bloodhound keyword', () => {
    expect(classify('bloodhound learn github notifications route').agentProfile).toBe('bloodhound');
    expect(classify('build an executor for checking PRs').agentProfile).toBe('bloodhound');
  });

  it('sets filesystem profile on filesystem-agent tasks without desktop', () => {
    expect(classify('organize my downloads folder').agentProfile).toBe('filesystem');
    expect(classify('find duplicate files on my desktop').agentProfile).toBe('filesystem');
  });

  it('sets general profile on coding tasks', () => {
    expect(classify('fix the bug in src/main/loop.ts').agentProfile).toBe('general');
  });
});

describe('classify() — model tier routing', () => {
  it('uses opus for deep analysis patterns', () => {
    expect(classify('assess the architecture and evaluate the trade-offs').model).toBe('opus');
  });

  it('uses haiku for short factual questions', () => {
    expect(classify('what year is it?').model).toBe('haiku');
  });

  it('uses sonnet as default for most tasks', () => {
    expect(classify('write a script to rename my files').model).toBe('sonnet');
  });
});

describe('classify() — prompt module selection', () => {
  it('includes browser module for browser tasks', () => {
    expect(classify('search google for react docs').promptModules.has('browser')).toBe(true);
  });

  it('includes filesystem module for filesystem agent tasks', () => {
    expect(classify('organize my downloads folder').promptModules.has('filesystem')).toBe(true);
  });

  it('includes desktop_apps module for desktop tasks', () => {
    expect(classify('open GIMP').promptModules.has('desktop_apps')).toBe(true);
  });
});

describe('classify() — self-reference routing', () => {
  it('routes clawdia self-reference to core group', () => {
    expect(classify('clawdia, what can you do?').toolGroup).toBe('core');
  });
});
