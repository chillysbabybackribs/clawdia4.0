import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn();
const get = vi.fn();
const all = vi.fn(() => []);
const prepare = vi.fn(() => ({ run, get, all }));
const createTab = vi.fn(() => 'temp-tab');
const switchTab = vi.fn();
const closeTab = vi.fn();
const getTabList = vi.fn(() => []);
const getCurrentUrl = vi.fn(() => '');
const getVisibleText = vi.fn(async () => '');
const executeBrowserNavigate = vi.fn();
const executeBrowserClick = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({ prepare }),
}));

vi.mock('../../src/main/db/site-profiles', () => ({
  extractDomain: (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  },
}));

vi.mock('../../src/main/browser/manager', () => ({
  createTab,
  switchTab,
  closeTab,
  getTabList,
  getCurrentUrl,
  getVisibleText,
}));

vi.mock('../../src/main/agent/executors/browser-executors', () => ({
  executeBrowserSearch: vi.fn(),
  executeBrowserNavigate,
  executeBrowserReadPage: vi.fn(),
  executeBrowserClick,
  executeBrowserType: vi.fn(),
  executeBrowserExtract: vi.fn(),
  executeBrowserScroll: vi.fn(),
}));

describe('browser playbook autosave', () => {
  beforeEach(() => {
    prepare.mockClear();
    run.mockClear();
    get.mockReset();
    get.mockReturnValue(undefined);
    createTab.mockReset();
    createTab.mockReturnValue('temp-tab');
    switchTab.mockReset();
    closeTab.mockReset();
    getTabList.mockReset();
    getTabList.mockReturnValue([]);
    getCurrentUrl.mockReset();
    getCurrentUrl.mockReturnValue('');
    getVisibleText.mockReset();
    getVisibleText.mockResolvedValue('');
    executeBrowserNavigate.mockReset();
    executeBrowserNavigate.mockResolvedValue('ok');
    executeBrowserClick.mockReset();
    executeBrowserClick.mockResolvedValue('ok');
  });

  it('skips autosave for coordination/evaluation prompts', async () => {
    const { shouldAutoSavePlaybook } = await import('../../src/main/db/browser-playbooks');
    expect(shouldAutoSavePlaybook(
      'Use agent_spawn to spawn 2 parallel sub-agents and run browser_eval plus browser_dom_snapshot',
      [
        { name: 'browser_navigate', input: { url: 'https://example.com' }, summary: 'navigate' },
        { name: 'browser_eval', input: { expression: 'document.title' }, summary: 'eval' },
      ],
    )).toBe(false);
  });

  it('uses the navigated domain when primaryUrl points at the wrong visible tab', async () => {
    const { savePlaybook } = await import('../../src/main/db/browser-playbooks');
    const saved = savePlaybook(
      'check example domain help page',
      [
        { name: 'browser_navigate', input: { url: 'https://www.iana.org/help/example-domains' }, summary: 'navigate' },
        { name: 'browser_click', input: { target: 'Domains' }, summary: 'click' },
      ],
      'https://www.google.com/',
      { agentProfile: 'general', runtimeMs: 1200 },
    );

    expect(saved).not.toBeNull();
    expect(saved!.domain).toBe('iana.org');
    expect(run).toHaveBeenCalled();
  });

  it('replays a saved playbook against a run-scoped target without creating a visible temp tab', async () => {
    get.mockReturnValue({
      id: 7,
      domain: 'example.com',
      task_pattern: 'check example',
      agent_profile: 'bloodhound',
      steps: JSON.stringify([
        { tool: 'browser_navigate', input: { url: 'https://example.com' }, summary: 'navigate' },
        { tool: 'browser_click', input: { target: '0' }, summary: 'click' },
      ]),
      success_count: 3,
      fail_count: 0,
      success_rate: 1,
      validation_runs: 3,
      avg_runtime_ms: 900,
      avg_step_count: 2,
      notes: '[]',
      last_used: '',
      created_at: '',
    });
    getCurrentUrl.mockReturnValue('https://example.com/result');
    getVisibleText.mockResolvedValue('x'.repeat(100));

    const { executeSavedBloodhoundPlaybookById } = await import('../../src/main/db/browser-playbooks');
    const result = await executeSavedBloodhoundPlaybookById(7, { target: { runId: 'run-1' } });

    expect(result?.ok).toBe(true);
    expect(createTab).not.toHaveBeenCalled();
    expect(executeBrowserNavigate).toHaveBeenCalledWith({ url: 'https://example.com', __runId: 'run-1' });
    const replayCalls = [
      ...executeBrowserNavigate.mock.calls.flat(),
      ...executeBrowserClick.mock.calls.flat(),
    ];
    expect(replayCalls.some((input: any) => input?.__runId === 'run-1')).toBe(true);
    expect(getCurrentUrl).toHaveBeenCalledWith({ runId: 'run-1' });
    expect(closeTab).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });
});
