import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const argDb = process.argv.find((arg) => arg.startsWith('--db='))?.slice('--db='.length);
const keepDb = process.argv.includes('--keep-db') || process.argv.includes('--append');
const DB_PATH = argDb || process.env.CLAWDIA_DB_PATH || path.join(process.cwd(), '.tmp', 'scorecard-debug.sqlite');
const ARTIFACT_ROOT = path.join(os.tmpdir(), 'clawdia-workflow-scorecard-validation');
const runIdSuffix = keepDb ? `-${Date.now()}` : '';

interface ValidationTask {
  scenarioId: string;
  description: string;
  runId: string;
  execute: (helpers: TaskHelpers) => Promise<'completed' | 'failed'>;
}

interface TaskHelpers {
  artifactRoot: string;
  recordTool: (input: {
    toolName: string;
    toolCategory?: string;
    success: boolean;
    durationMs: number;
    errorType?: string;
    recoveryInvoked?: boolean;
  }) => void;
}

if (!keepDb) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch {}
  }
  fs.rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
}
fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
process.env.CLAWDIA_DB_PATH = DB_PATH;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

async function main(): Promise<void> {
  const { createRun, completeRun } = await import('../src/main/db/runs');
  const { closeDb } = await import('../src/main/db/database');
  const {
    clearSystemAuditCache,
    finalizeRunAudit,
    getCapabilityScorecard,
    recordToolTelemetry,
  } = await import('../src/main/agent/system-audit');

  clearSystemAuditCache();

  const tasks: ValidationTask[] = [
    {
      scenarioId: 'filesystem_roundtrip',
      description: 'Create, read, and list a local validation artifact.',
      runId: 'validation-filesystem-roundtrip',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'filesystem-roundtrip');
        const filePath = path.join(scenarioDir, 'note.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });

        await measureStep('fs_write_file', 'filesystem', async () => {
          fs.writeFileSync(filePath, 'workflow validation\n', 'utf8');
        }, recordTool);

        await measureStep('fs_read_file', 'filesystem', async () => {
          const text = fs.readFileSync(filePath, 'utf8');
          if (!text.includes('workflow validation')) throw new Error('content verification failed');
        }, recordTool);

        await measureStep('fs_read_dir', 'filesystem', async () => {
          const entries = fs.readdirSync(scenarioDir);
          if (!entries.includes('note.txt')) throw new Error('note.txt missing from directory listing');
        }, recordTool);

        return 'completed';
      },
    },
    {
      scenarioId: 'shell_fs_report',
      description: 'Use shell plus filesystem to generate and verify a local report.',
      runId: 'validation-shell-fs-report-success',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'shell-fs-report');
        const filePath = path.join(scenarioDir, 'report.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'alpha\nbeta\ngamma\n' > ${shellQuote(filePath)}`]);
        }, recordTool);

        await measureStep('fs_read_file', 'filesystem', async () => {
          const text = fs.readFileSync(filePath, 'utf8');
          if (!text.includes('gamma')) throw new Error('gamma missing from report');
        }, recordTool);

        await measureStep('shell_exec', 'shell', async () => {
          const { stdout } = await execFileAsync('bash', ['-lc', `wc -l < ${shellQuote(filePath)}`]);
          if (stdout.trim() !== '3') throw new Error(`expected 3 lines, got ${stdout.trim()}`);
        }, recordTool);

        return 'completed';
      },
    },
    {
      scenarioId: 'shell_fs_report',
      description: 'Fail late after meaningful shell and filesystem progress.',
      runId: 'validation-shell-fs-report-late-fail',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'shell-fs-report-late');
        const filePath = path.join(scenarioDir, 'report.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'alpha\nbeta\n' > ${shellQuote(filePath)}`]);
        }, recordTool);

        await measureStep('fs_read_file', 'filesystem', async () => {
          const text = fs.readFileSync(filePath, 'utf8');
          if (!text.includes('beta')) throw new Error('beta missing from report');
        }, recordTool);

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'delta\n' >> ${shellQuote(filePath)}`]);
        }, recordTool);

        const failed = await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `grep -q gamma ${shellQuote(filePath)}`]);
        }, recordTool, { errorType: 'error', allowFailure: true });

        return failed ? 'failed' : 'completed';
      },
    },
    {
      scenarioId: 'shell_fs_report',
      description: 'Repeat the same late failing shell boundary to localize the weak step.',
      runId: 'validation-shell-fs-report-late-fail-2',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'shell-fs-report-late-2');
        const filePath = path.join(scenarioDir, 'report.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'alpha\nbeta\n' > ${shellQuote(filePath)}`]);
        }, recordTool);

        await measureStep('fs_read_file', 'filesystem', async () => {
          const text = fs.readFileSync(filePath, 'utf8');
          if (!text.includes('beta')) throw new Error('beta missing from report');
        }, recordTool);

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'epsilon\n' >> ${shellQuote(filePath)}`]);
        }, recordTool);

        const failed = await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `grep -q gamma ${shellQuote(filePath)}`]);
        }, recordTool, { errorType: 'error', allowFailure: true });

        return failed ? 'failed' : 'completed';
      },
    },
    {
      scenarioId: 'workflow_retry_repair',
      description: 'Fail early when an expected file is missing.',
      runId: 'validation-workflow-retry-repair-early-fail',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'workflow-retry-repair');
        const filePath = path.join(scenarioDir, 'missing.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });
        fs.rmSync(filePath, { force: true });

        const failed = await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `test -f ${shellQuote(filePath)}`]);
        }, recordTool, { errorType: 'error', allowFailure: true });

        return failed ? 'failed' : 'completed';
      },
    },
    {
      scenarioId: 'workflow_retry_repair',
      description: 'Recover from a missing file, then verify it through filesystem reads.',
      runId: 'validation-workflow-retry-repair-success',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'workflow-retry-repair-success');
        const filePath = path.join(scenarioDir, 'repaired.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });
        fs.rmSync(filePath, { force: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `test -f ${shellQuote(filePath)}`]);
        }, recordTool, { errorType: 'error', recoveryInvoked: false, allowFailure: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'repaired\n' > ${shellQuote(filePath)}`]);
        }, recordTool, { recoveryInvoked: true });

        await measureStep('fs_read_file', 'filesystem', async () => {
          const text = fs.readFileSync(filePath, 'utf8');
          if (text.trim() !== 'repaired') throw new Error('repair verification failed');
        }, recordTool);

        return 'completed';
      },
    },
    {
      scenarioId: 'workflow_retry_repair',
      description: 'Repeat the same recovery path to expose the dominant rescue chain.',
      runId: 'validation-workflow-retry-repair-success-2',
      execute: async ({ artifactRoot, recordTool }) => {
        const scenarioDir = path.join(artifactRoot, 'workflow-retry-repair-success-2');
        const filePath = path.join(scenarioDir, 'repaired.txt');
        fs.mkdirSync(scenarioDir, { recursive: true });
        fs.rmSync(filePath, { force: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `test -f ${shellQuote(filePath)}`]);
        }, recordTool, { errorType: 'error', recoveryInvoked: false, allowFailure: true });

        await measureStep('shell_exec', 'shell', async () => {
          await execFileAsync('bash', ['-lc', `printf 'repaired-again\n' > ${shellQuote(filePath)}`]);
        }, recordTool, { recoveryInvoked: true });

        await measureStep('fs_read_file', 'filesystem', async () => {
          const text = fs.readFileSync(filePath, 'utf8');
          if (text.trim() !== 'repaired-again') throw new Error('repair verification failed');
        }, recordTool);

        return 'completed';
      },
    },
  ];

  const plannedTasks = tasks.map((task) => ({
    ...task,
    runId: `${task.runId}${runIdSuffix}`,
  }));

  const taskResults: Array<Record<string, unknown>> = [];

  for (const task of plannedTasks) {
    let iterationIndex = 0;
    createRun(task.runId, 'validation-conversation', task.description, undefined, undefined, task.scenarioId);

    const recordTool = (input: {
      toolName: string;
      toolCategory?: string;
      success: boolean;
      durationMs: number;
      errorType?: string;
      recoveryInvoked?: boolean;
    }) => {
      recordToolTelemetry({
        runId: task.runId,
        iterationIndex,
        toolName: input.toolName,
        toolCategory: input.toolCategory,
        success: input.success,
        durationMs: input.durationMs,
        errorType: input.errorType,
        recoveryInvoked: input.recoveryInvoked,
      });
      iterationIndex += 1;
    };

    const status = await task.execute({ artifactRoot: ARTIFACT_ROOT, recordTool });
    completeRun(task.runId, status, status === 'failed' ? 'Validation task failed as expected.' : undefined);
    finalizeRunAudit(task.runId, status);

    taskResults.push({
      scenarioId: task.scenarioId,
      runId: task.runId,
      description: task.description,
      completed: status === 'completed',
    });
  }

  const scorecard = getCapabilityScorecard();

  console.log(`[validation] db=${DB_PATH}`);
  console.log(`[validation] artifacts=${ARTIFACT_ROOT}`);
  console.log(`[validation] mode=${keepDb ? 'append' : 'reset'}`);
  console.log('[validation] tasks=');
  console.log(JSON.stringify(taskResults, null, 2));
  console.log('');
  console.log(scorecard.text);
  console.log('\nJSON');
  console.log(JSON.stringify({
    overallScore: scorecard.overallScore,
    workflowSummary: scorecard.workflowSummary,
    scenarios: scorecard.scenarioSummaries,
  }, null, 2));

  closeDb();
}

async function measureStep(
  toolName: string,
  toolCategory: string,
  operation: () => Promise<void> | void,
  recordTool: TaskHelpers['recordTool'],
  options?: { errorType?: string; recoveryInvoked?: boolean; allowFailure?: boolean },
): Promise<boolean> {
  const started = Date.now();
  try {
    await operation();
    recordTool({
      toolName,
      toolCategory,
      success: true,
      durationMs: Date.now() - started,
      recoveryInvoked: options?.recoveryInvoked,
    });
    return false;
  } catch (error) {
    recordTool({
      toolName,
      toolCategory,
      success: false,
      durationMs: Date.now() - started,
      errorType: options?.errorType || 'error',
      recoveryInvoked: options?.recoveryInvoked,
    });
    if (options?.allowFailure) return true;
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

main().catch((error) => {
  console.error('[validation] failed:', error);
  process.exitCode = 1;
});
