import { describe, expect, it } from 'vitest';
import { compileBrowserExecutionSketch, compileTaskExecutionGraphScaffold } from '../../src/main/agent/task-compiler';

describe('compileBrowserExecutionSketch()', () => {
  it('returns null for coordination/swarm prompts', () => {
    expect(
      compileBrowserExecutionSketch('Use agent_spawn to spawn 2 parallel sub-agents and compare browser results'),
    ).toBeNull();
    expect(
      compileBrowserExecutionSketch('Spawn two browser workers in parallel and summarize the result'),
    ).toBeNull();
  });
});

describe('compileTaskExecutionGraphScaffold()', () => {
  it('builds a browser-cdp worker path for browser comparison tasks', () => {
    const task = 'Compare Amazon headset options and summarize the best one';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp');
    const plannerNode = scaffold.planner.graph.nodes.find((node) => node.kind === 'planner');
    expect(browserNode).toBeTruthy();
    expect(browserNode?.output.schemaName).toBe('ProductCompareOutput');
    expect(browserNode?.objective).toContain('Compare Amazon headset options');
    expect(browserNode?.objective).toContain('Required evidence types: official_product_pages, expert_reviews');
    expect(browserNode?.objective).toContain('do not perform generic browser capability checks');
    expect(plannerNode?.inputs.some((input) => input.name === 'evidence_plan')).toBe(true);
    expect(scaffold.planner.topology.parallelBranches).toBeGreaterThanOrEqual(1);
  });

  it('builds an app-cli-anything worker path for app execution tasks', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Open GIMP, export the image, and save the artifact');
    const appNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'app_cli_anything');
    expect(appNode).toBeTruthy();
    expect(appNode?.label).toContain('App');
  });

  it('builds mixed browser and app workers for mixed execution tasks', () => {
    const task = 'Research two mechanical keyboards online and then open GIMP to export a comparison card';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const workerNodes = scaffold.planner.graph.nodes.filter((node) => node.kind === 'worker');
    const appNode = workerNodes.find((node) => node.executor.kind === 'app_cli_anything');

    expect(workerNodes).toHaveLength(2);
    expect(scaffold.planner.topology.parallelBranches).toBe(1);
    expect(appNode?.inputs.some((input) => input.source === 'node_output')).toBe(true);
    expect(appNode?.objective).toContain('validated browser findings');
  });

  it('builds mixed browser and filesystem workers when both are requested', () => {
    const task = 'Research the latest Playwright release notes and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const workerNodes = scaffold.planner.graph.nodes.filter((node) => node.kind === 'worker');
    const browserNode = workerNodes.find((node) => node.executor.kind === 'browser_cdp');
    const fsNode = workerNodes.find((node) => node.executor.kind === 'filesystem_core');

    expect(workerNodes).toHaveLength(2);
    expect(browserNode).toBeTruthy();
    expect(fsNode).toBeTruthy();
    expect(scaffold.planner.topology.parallelBranches).toBe(1);
    expect(fsNode?.inputs.some((input) => input.source === 'node_output' && input.fromNodeId === browserNode?.id)).toBe(true);
  });

  it('does not force image, video, or academic evidence unless the task asks for them', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp');

    expect(browserNode?.objective).toContain('official_product_pages');
    expect(browserNode?.objective).toContain('expert_reviews');
    expect(browserNode?.objective).not.toContain('pricing');
    expect(browserNode?.objective).not.toContain('images');
    expect(browserNode?.objective).not.toContain('videos');
    expect(browserNode?.objective).not.toContain('academic_sources');
  });
});
