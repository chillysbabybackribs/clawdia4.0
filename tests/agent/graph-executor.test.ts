import { describe, expect, it } from 'vitest';
import {
  buildGraphWorkerUserMessage,
  buildGraphWorkerRetryUserMessage,
  buildWorkerPayload,
  canExecuteGraphScaffold,
  executeGraphScaffold,
  mapExecutorToAgentProfile,
  parseStructuredWorkerOutput,
  verifyGraphNodeResult,
  verifyWorkerPayloads,
} from '../../src/main/agent/graph-executor';
import { compileTaskExecutionGraphScaffold } from '../../src/main/agent/task-compiler';

describe('graph-executor', () => {
  it('accepts the guarded one-worker scaffold shape', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Compare Amazon products and summarize the best option');
    expect(canExecuteGraphScaffold(scaffold)).toBe(true);
  });

  it('maps executor kinds to practical worker profiles', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Open GIMP and export the image');
    const workerNode = scaffold.planner.graph.nodes.find((node) => node.kind === 'worker')!;
    expect(mapExecutorToAgentProfile(workerNode)).toBe('coordinator');
  });

  it('verifies worker output with simple guarded checks', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Compare Amazon products and summarize the best option');
    const workerNode = scaffold.planner.graph.nodes.find((node) => node.kind === 'worker')!;
    const ok = verifyGraphNodeResult(workerNode, 'This worker returned a substantive result with enough detail.');
    expect(ok.passed).toBe(true);

    const bad = verifyGraphNodeResult(workerNode, '[Error] worker failed');
    expect(bad.passed).toBe(false);
    expect(bad.retryRecommended).toBe(true);
  });

  it('accepts a bounded multi-worker scaffold shape', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Search Amazon for product options and inspect this repo structure');
    const workerCount = scaffold.planner.graph.nodes.filter((node) => node.kind === 'worker').length;
    expect(workerCount).toBe(2);
    expect(canExecuteGraphScaffold(scaffold)).toBe(true);
  });

  it('aggregates structured worker payload verification across multiple workers', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Search Amazon for product options and inspect this repo structure');
    const workerNodes = scaffold.planner.graph.nodes.filter((node) => node.kind === 'worker');
    const payloads = workerNodes.map((node, index) => buildWorkerPayload(node, {
      response: index === 0
        ? 'Browser worker returned enough detail to satisfy the guarded verifier.'
        : 'App worker returned enough detail to satisfy the guarded verifier.',
      toolCalls: [],
    }));

    const verification = verifyWorkerPayloads(workerNodes, payloads);
    expect(verification.passed).toBe(false);
    expect(verification.checks.some((check) => check.name.includes('tool_evidence') || check.name === 'browser_tool_evidence' || check.name === 'app_tool_evidence')).toBe(true);
  });

  it('passes verification when executor-specific tool evidence exists', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Search Amazon for product options and inspect this repo structure');
    const workerNodes = scaffold.planner.graph.nodes.filter((node) => node.kind === 'worker');
    const payloads = workerNodes.map((node) => buildWorkerPayload(node, {
      response: structuredResponseFor(node.executor.kind),
      toolCalls: node.executor.kind === 'browser_cdp'
        ? [{ name: 'browser_extract_product_details', status: 'success' }]
        : node.executor.kind === 'filesystem_core'
          ? [{ name: 'file_read', status: 'success' }]
          : [{ name: 'app_control', status: 'success' }],
    }));

    const verification = verifyWorkerPayloads(workerNodes, payloads);
    expect(verification.passed).toBe(true);
    expect(verification.checks.length).toBeGreaterThan(3);
  });

  it('passes browser research verification when evidence coverage includes review and product-page sources', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;
    const verification = verifyWorkerPayloads([browserNode], [buildWorkerPayload(browserNode, {
      response: JSON.stringify({
        findings: [
          {
            title: 'Logitech MX Keys S Review',
            url: 'https://www.rtings.com/keyboard/reviews/logitech/mx-keys-s',
            facts: ['Quiet office use', 'Strong typing experience', 'Low-profile design'],
            confidence: 0.91,
          },
          {
            title: 'Logitech MX Keys S Product Page',
            url: 'https://www.amazon.com/dp/B0BKW3LB2B',
            facts: ['Current pricing available', 'Full product specs available', 'Direct purchase page'],
            confidence: 0.87,
          },
        ],
      }),
      toolCalls: [{ name: 'browser_extract', status: 'success' }],
    })]);

    expect(verification.passed).toBe(true);
    expect(verification.checks.some((check) => check.name === 'expert_review_coverage' && check.passed)).toBe(true);
    expect(verification.checks.some((check) => check.name === 'official_product_page_coverage' && check.passed)).toBe(true);
  });

  it('builds worker prompts from the original user task instead of a generic probe objective', () => {
    const task = 'Compare two Amazon wireless gaming headsets under $100 and tell me which one is the better buy.';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const workerNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;

    const prompt = buildGraphWorkerUserMessage(workerNode, task);
    expect(prompt).toContain('Compare two Amazon wireless gaming headsets under $100');
    expect(prompt).toContain(workerNode.output.schemaName);
    expect(prompt).toContain('Do not perform generic executor, browser, or network capability checks.');
    expect(prompt).toContain(workerNode.label);
    expect(prompt).toContain('Example valid ProductCompareOutput JSON:');
  });

  it('includes upstream structured payloads in dependent worker prompts', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;
    const fsNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'filesystem_core')!;
    const browserPayload = buildWorkerPayload(browserNode, {
      response: JSON.stringify({
        findings: [{ title: 'Keyboard A', url: 'https://example.com/a', facts: ['Quiet typing'], confidence: 0.91 }],
      }),
      toolCalls: [{ name: 'browser_search', status: 'success' }],
    });

    const prompt = buildGraphWorkerUserMessage(fsNode, task, [browserPayload]);
    expect(prompt).toContain('Upstream structured inputs:');
    expect(prompt).toContain('Keyboard A');
    expect(prompt).toContain('Do not ignore them.');
    expect(prompt).toContain('Example valid AppTaskOutput JSON:');
  });

  it('includes evidence acquisition guidance for browser research workers', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;

    const prompt = buildGraphWorkerUserMessage(browserNode, task);
    expect(prompt).toContain('Evidence acquisition rules:');
    expect(prompt).toContain('Acquire at least one expert review source early');
    expect(prompt).toContain('Acquire at least one official product or direct product page');
    expect(prompt).toContain('Do not guess slugs or invent URLs.');
    expect(prompt).toContain('Once you have enough sources to satisfy the required evidence types, stop browsing');
  });

  it('parses structured worker JSON from fenced or plain output', () => {
    expect(parseStructuredWorkerOutput('{"findings":[{"title":"A","url":"https://example.com","facts":["x"],"confidence":0.9}]}')).toEqual({
      findings: [{ title: 'A', url: 'https://example.com', facts: ['x'], confidence: 0.9 }],
    });
    expect(parseStructuredWorkerOutput('```json\n{"products":[]}\n```')).toEqual({ products: [] });
    expect(parseStructuredWorkerOutput('No JSON here')).toBeNull();
  });

  it('normalizes browser research payloads from product-style output into findings', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;
    const payload = buildWorkerPayload(browserNode, {
      response: JSON.stringify({
        products: [
          {
            title: 'Logitech MX Keys S',
            url: 'https://example.com/mx-keys-s',
            pros: ['Quiet low-profile typing', 'Excellent office keyboard'],
            cons: ['Expensive'],
          },
          {
            title: 'Keychron K5 Max',
            url: 'https://example.com/k5-max',
            pros: ['Mechanical feel', 'Wireless'],
            cons: ['Can be louder'],
          },
        ],
      }),
      toolCalls: [{ name: 'browser_compare_products', status: 'success' }],
    });

    expect(payload.structuredData).toEqual({
      findings: [
        {
          title: 'Logitech MX Keys S',
          url: 'https://example.com/mx-keys-s',
          facts: ['Quiet low-profile typing', 'Excellent office keyboard'],
          confidence: 0.8,
        },
        {
          title: 'Keychron K5 Max',
          url: 'https://example.com/k5-max',
          facts: ['Mechanical feel', 'Wireless'],
          confidence: 0.8,
        },
      ],
      recommendedNextUrls: ['https://example.com/mx-keys-s', 'https://example.com/k5-max'],
      blockers: [],
    });
  });

  it('fails verification when worker output does not satisfy the declared contract', () => {
    const scaffold = compileTaskExecutionGraphScaffold('Compare Amazon products and summarize the best option');
    const workerNode = scaffold.planner.graph.nodes.find((node) => node.kind === 'worker')!;
    const verification = verifyWorkerPayloads([workerNode], [buildWorkerPayload(workerNode, {
      response: '{"winner":"A"}',
      toolCalls: [{ name: 'browser_extract_product_details', status: 'success' }],
    })]);

    expect(verification.passed).toBe(false);
    expect(verification.checks.some((check) => check.name === 'structured_contract_validation' && !check.passed)).toBe(true);
  });

  it('fails browser research verification when evidence coverage is too thin', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;
    const verification = verifyWorkerPayloads([browserNode], [buildWorkerPayload(browserNode, {
      response: JSON.stringify({
        findings: [
          {
            title: 'Quiet Keyboards Roundup',
            url: 'https://www.rtings.com/keyboard/reviews/best/quiet',
            facts: ['Quiet keyboards overview'],
            confidence: 0.8,
          },
        ],
      }),
      toolCalls: [{ name: 'browser_extract', status: 'success' }],
    })]);

    expect(verification.passed).toBe(false);
    expect(verification.checks.some((check) => check.name === 'minimum_findings' && !check.passed)).toBe(true);
    expect(verification.checks.some((check) => check.name === 'official_product_page_coverage' && !check.passed)).toBe(true);
    expect(verification.checks.some((check) => check.name === 'search_results_not_used_as_final_findings' && !check.passed)).toBe(true);
  });

  it('fails browser research verification when findings are too shallow even if URLs are valid', () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const browserNode = scaffold.planner.graph.nodes.find((node) => node.executor.kind === 'browser_cdp')!;
    const verification = verifyWorkerPayloads([browserNode], [buildWorkerPayload(browserNode, {
      response: JSON.stringify({
        findings: [
          {
            title: 'Logitech MX Keys S Review',
            url: 'https://www.rtings.com/keyboard/reviews/logitech/mx-keys-s',
            facts: ['Quiet'],
            confidence: 0.8,
          },
          {
            title: 'Logitech MX Keys S Product Page',
            url: 'https://www.amazon.com/dp/B0BKW3LB2B',
            facts: ['Available'],
            confidence: 0.8,
          },
        ],
      }),
      toolCalls: [{ name: 'browser_extract', status: 'success' }],
    })]);

    expect(verification.passed).toBe(false);
    expect(verification.checks.some((check) => check.name === 'finding_fact_density' && !check.passed)).toBe(true);
  });

  it('builds a retry prompt with failed verification guidance', () => {
    const task = 'Compare Amazon products and summarize the best option';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const workerNode = scaffold.planner.graph.nodes.find((node) => node.kind === 'worker')!;
    const payload = buildWorkerPayload(workerNode, {
      response: '{"winner":"A"}',
      toolCalls: [{ name: 'browser_extract_product_details', status: 'success' }],
    });
    const verification = verifyWorkerPayloads([workerNode], [payload]);

    const retryPrompt = buildGraphWorkerRetryUserMessage(workerNode, task, payload, verification.checks);
    expect(retryPrompt).toContain('Retry attempt: 2');
    expect(retryPrompt).toContain('Previous attempt failed verification');
    expect(retryPrompt).toContain('structured_contract_validation');
  });

  it('retries a failed worker once and succeeds when the retry returns valid contract JSON', async () => {
    const task = 'Compare Amazon products and summarize the best option';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const runWorkerLoop = async (options: { userMessage: string }) => {
      if (options.userMessage.includes('Retry attempt: 2')) {
        return {
          response: JSON.stringify({
            products: [{ title: 'A', url: 'https://example.com/a', pros: ['Good battery'], cons: ['Plastic build'] }],
            winner: 'A',
            rationale: 'Better value.',
          }),
          toolCalls: [{ name: 'browser_compare_products', status: 'success' }],
        };
      }
      return {
        response: '{"winner":"A"}',
        toolCalls: [{ name: 'browser_compare_products', status: 'success' }],
      };
    };

    const result = await executeGraphScaffold({
      scaffold,
      originalUserMessage: task,
      client: {
        chat: async () => ({
          content: [{ type: 'text', text: 'merged response' }],
        }),
      } as any,
      staticPrompt: '',
      dynamicPrompt: '',
      runWorkerLoop: runWorkerLoop as any,
      workerBaseOptions: {
        provider: 'anthropic' as any,
        apiKey: 'test',
        graphExecutionMode: 'disabled',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.response).toBe('merged response');
  });

  it('executes a dependent browser to filesystem chain serially and passes upstream findings to the output worker', async () => {
    const task = 'Research two quiet office keyboards and write a markdown summary file in this repo';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const prompts: string[] = [];

    const result = await executeGraphScaffold({
      scaffold,
      originalUserMessage: task,
      client: {
        chat: async () => ({ content: [{ type: 'text', text: 'merged response' }] }),
      } as any,
      staticPrompt: '',
      dynamicPrompt: '',
      runWorkerLoop: async (options: { userMessage: string; allowedTools?: string[] }) => {
        prompts.push(options.userMessage);
        if (options.allowedTools?.includes('browser_navigate')) {
          return {
            response: JSON.stringify({
              findings: [
                {
                  title: 'Keyboard A Review',
                  url: 'https://www.rtings.com/keyboard/reviews/keyboard-a',
                  facts: ['Quiet typing', 'Strong office ergonomics'],
                  confidence: 0.92,
                },
                {
                  title: 'Keyboard A Product Page',
                  url: 'https://www.amazon.com/dp/B0TEST1234',
                  facts: ['Current pricing available', 'Purchase page available'],
                  confidence: 0.88,
                },
              ],
            }),
            toolCalls: [{ name: 'browser_search', status: 'success' }],
          };
        }
        return {
          response: JSON.stringify({
            appId: 'filesystem',
            actionLog: ['Wrote markdown summary'],
            artifacts: [{ path: '/tmp/quiet-office-keyboards.md', kind: 'text/markdown' }],
            stateSummary: 'Summary written successfully.',
          }),
          toolCalls: [{ name: 'file_write', status: 'success' }],
        };
      },
      workerBaseOptions: {
        provider: 'anthropic' as any,
        apiKey: 'test',
        graphExecutionMode: 'disabled',
      },
    });

    expect(result.handled).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Upstream structured inputs:');
    expect(prompts[1]).toContain('Keyboard A');
  });

  it('falls back when the retry also fails contract verification', async () => {
    const task = 'Compare Amazon products and summarize the best option';
    const scaffold = compileTaskExecutionGraphScaffold(task);

    const result = await executeGraphScaffold({
      scaffold,
      originalUserMessage: task,
      client: {
        chat: async () => ({ content: [{ type: 'text', text: 'should not merge' }] }),
      } as any,
      staticPrompt: '',
      dynamicPrompt: '',
      runWorkerLoop: async () => ({
        response: '{"winner":"A"}',
        toolCalls: [{ name: 'browser_compare_products', status: 'success' }],
      }),
      workerBaseOptions: {
        provider: 'anthropic' as any,
        apiKey: 'test',
        graphExecutionMode: 'disabled',
      },
    });

    expect(result.handled).toBe(false);
  });

  it('emits graph events and state snapshots during execution', async () => {
    const task = 'Compare Amazon products and summarize the best option';
    const scaffold = compileTaskExecutionGraphScaffold(task);
    const events: Array<{ kind: string; phase?: string; payload: Record<string, any> }> = [];
    const states: any[] = [];

    const result = await executeGraphScaffold({
      scaffold,
      originalUserMessage: task,
      client: {
        chat: async () => ({ content: [{ type: 'text', text: 'merged response' }] }),
      } as any,
      staticPrompt: '',
      dynamicPrompt: '',
      runWorkerLoop: async () => ({
        response: JSON.stringify({
          products: [{ title: 'A', url: 'https://example.com/a', pros: ['Good battery'], cons: ['Plastic build'] }],
          winner: 'A',
          rationale: 'Better value.',
        }),
        toolCalls: [{ name: 'browser_compare_products', status: 'success' }],
      }),
      workerBaseOptions: {
        provider: 'anthropic' as any,
        apiKey: 'test',
        graphExecutionMode: 'disabled',
      },
      onGraphEvent: (event) => events.push(event),
      onGraphState: (snapshot) => states.push(snapshot),
    });

    expect(result.handled).toBe(true);
    expect(events.some((event) => event.kind === 'graph_execution_started')).toBe(true);
    expect(events.some((event) => event.kind === 'graph_node_started')).toBe(true);
    expect(events.some((event) => event.kind === 'graph_verification_completed')).toBe(true);
    expect(events.some((event) => event.kind === 'graph_merge_completed')).toBe(true);
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)?.status).toBe('merged');
  });
});

function structuredResponseFor(executorKind: string): string {
  return executorKind === 'browser_cdp'
    ? JSON.stringify({
        findings: [
          {
            title: 'Product A Review',
            url: 'https://www.rtings.com/keyboard/reviews/product-a',
            facts: ['Strong battery life', 'Well-reviewed for office use'],
            confidence: 0.91,
          },
          {
            title: 'Product A Product Page',
            url: 'https://www.amazon.com/dp/B0TEST5678',
            facts: ['Official product details', 'Current listing and pricing available'],
            confidence: 0.86,
          },
        ],
      })
    : executorKind === 'filesystem_core'
      ? JSON.stringify({
          appId: 'filesystem',
          actionLog: ['Read repo structure', 'Prepared summary notes'],
          artifacts: [{ path: '/tmp/notes.md', kind: 'text/markdown' }],
          stateSummary: 'Filesystem inspection completed successfully.',
        })
      : JSON.stringify({
        appId: 'gimp',
        actionLog: ['Opened image', 'Exported PNG'],
        artifacts: [{ path: '/tmp/export.png', kind: 'image/png' }],
        stateSummary: 'Export completed successfully.',
      });
}
