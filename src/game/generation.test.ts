import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame } from './engine';
import { generateDevelopedGame } from './generation';

class BrowserWorker {
  static instances: BrowserWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  constructor() { BrowserWorker.instances.push(this); }
  postMessage() {}
  terminate() { this.terminated = true; }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

beforeEach(() => { BrowserWorker.instances = []; vi.stubGlobal('Worker', BrowserWorker); });
afterEach(() => vi.unstubAllGlobals());

describe('browser developed-world generation', () => {
  it('reports real simulation progress below 100 until it receives the finished world', async () => {
    const progress = vi.fn();
    const result = generateDevelopedGame({ seed: 7, onProgress: progress });
    const worker = BrowserWorker.instances[0];
    worker?.send({ type: 'progress', progress: { elapsedSeconds: 120, targetSeconds: 4500, goal: 'handbrush', percent: 100 } });
    const world = createGame(7);
    worker?.send({ type: 'complete', state: world });
    await expect(result).resolves.toEqual(world);
    expect(progress).toHaveBeenCalledWith({ elapsedSeconds: 120, targetSeconds: 4500, goal: 'handbrush', percent: 99 });
    expect(worker.terminated).toBe(true);
  });

  it('cancels a running task and ignores its queued replies while a later task succeeds', async () => {
    const controller = new AbortController(), progress = vi.fn();
    const cancelled = generateDevelopedGame({ signal: controller.signal, onProgress: progress });
    const first = BrowserWorker.instances[0];
    const lateMessage = first?.onmessage;
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancellation;
    const next = generateDevelopedGame({ seed: 12, onProgress: progress });
    lateMessage?.({ data: { type: 'progress', progress: { elapsedSeconds: 1000, targetSeconds: 4500, goal: 'robot', percent: 20 } } } as MessageEvent);
    lateMessage?.({ data: { type: 'complete', state: createGame(7) } } as MessageEvent);
    BrowserWorker.instances[1]?.send({ type: 'complete', state: createGame(12) });
    await expect(next).resolves.toMatchObject({ seed: 12 });
    expect(progress).not.toHaveBeenCalled();
    expect(first.terminated).toBe(true);
  });

  it('does not create a worker for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(generateDevelopedGame({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(BrowserWorker.instances).toHaveLength(0);
  });

  it.each(['simulation', 'runtime', 'message'] as const)('rejects %s failure without returning a replacement world', async failure => {
    const result = generateDevelopedGame();
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    const worker = BrowserWorker.instances[0];
    if (failure === 'simulation') worker?.send({ type: 'error', message: 'Simulation could not reach its goal' });
    if (failure === 'runtime') worker?.onerror?.({ message: 'Worker failed', preventDefault() {} } as ErrorEvent);
    if (failure === 'message') worker?.onmessageerror?.({} as MessageEvent);
    await rejected;
    expect(worker.terminated).toBe(true);
  });
});
