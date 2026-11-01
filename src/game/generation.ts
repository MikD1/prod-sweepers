import type { DevelopedProgress } from './starts';
import type { GameState } from './types';

export interface GenerationOptions {
  seed?: number;
  onProgress?: (progress: DevelopedProgress) => void;
  signal?: AbortSignal;
}

export type GenerationReply =
  | { type: 'progress'; progress: DevelopedProgress }
  | { type: 'complete'; state: GameState }
  | { type: 'error'; message: string };

export function generateDevelopedGame({ seed = 42, onProgress, signal }: GenerationOptions = {}): Promise<GameState> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException('Подготовка мира отменена.', 'AbortError');
    if (signal?.aborted) { reject(aborted()); return; }
    let worker: Worker | undefined;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel);
      if (worker) {
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const cancel = () => fail(aborted());
    try {
      worker = new Worker(new URL('./generation.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<GenerationReply>) => {
        if (settled) return;
        try {
          const data = event.data;
          if (data.type === 'progress') {
            const progress = data.progress;
            onProgress?.({ ...progress, percent: Math.max(0, Math.min(99, Number.isFinite(progress.percent) ? progress.percent : 0)) });
          } else if (data.type === 'complete') {
            settled = true; cleanup(); resolve(data.state);
          } else if (data.type === 'error') fail(new Error(data.message));
        } catch (error) { fail(error); }
      };
      worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Не удалось запустить подготовку мира.')); };
      worker.onmessageerror = () => fail(new Error('Не удалось получить подготовленный мир.'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      worker.postMessage({ type: 'start', seed });
    } catch (error) { fail(error); }
  });
}
