import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

class FakeStream extends EventEmitter {
  write = vi.fn((chunk: string) => {
    this.emit('write', chunk);
    return true;
  });
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.emit('exit', null, signal || 'SIGTERM');
    return true;
  });
}

describe('shell-executor', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    spawnMock.mockReset();
    const mod = await import('../../src/main/agent/executors/core/shell-executor');
    mod.__testing.resetState();
  });

  it('serializes concurrent shell_exec calls through one queue', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);

    const mod = await import('../../src/main/agent/executors/core/shell-executor');
    const first = mod.executeShellExec({ command: 'echo first' });
    const second = mod.executeShellExec({ command: 'echo second' });
    await Promise.resolve();

    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    const firstWrite = String(proc.stdin.write.mock.calls[0][0]);
    const firstSentinel = /echo "(__CLAWDIA_DONE_[^:"]+):\$\?"/.exec(firstWrite)?.[1];
    expect(firstSentinel).toBeTruthy();

    proc.stdout.emit('data', Buffer.from(`first output\n${firstSentinel}:0\n`));
    await expect(first).resolves.toContain('first output');

    expect(proc.stdin.write).toHaveBeenCalledTimes(2);
    const secondWrite = String(proc.stdin.write.mock.calls[1][0]);
    const secondSentinel = /echo "(__CLAWDIA_DONE_[^:"]+):\$\?"/.exec(secondWrite)?.[1];
    expect(secondSentinel).toBeTruthy();

    proc.stdout.emit('data', Buffer.from(`second output\n${secondSentinel}:0\n`));
    await expect(second).resolves.toContain('second output');
  });

  it('resets the shell after a timeout so the next call respawns cleanly', async () => {
    vi.useFakeTimers();
    const firstProc = new FakeChildProcess();
    const secondProc = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const mod = await import('../../src/main/agent/executors/core/shell-executor');
    const hung = mod.executeShellExec({ command: 'sleep 999', timeout: 1 });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    await expect(hung).resolves.toContain('[Timed out after 1s]');
    expect(firstProc.kill).toHaveBeenCalledWith('SIGKILL');

    const next = mod.executeShellExec({ command: 'echo recovered' });
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const nextWrite = String(secondProc.stdin.write.mock.calls[0][0]);
    const nextSentinel = /echo "(__CLAWDIA_DONE_[^:"]+):\$\?"/.exec(nextWrite)?.[1];
    secondProc.stdout.emit('data', Buffer.from(`recovered\n${nextSentinel}:0\n`));
    await expect(next).resolves.toContain('recovered');
  });
});
