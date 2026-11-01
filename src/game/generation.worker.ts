import { createDevelopedGame } from './starts';
import type { GenerationReply } from './generation';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ type: 'start'; seed: number }>) => void) | null;
  postMessage(message: GenerationReply): void;
};

scope.onmessage = event => {
  if (event.data.type !== 'start') return;
  try {
    const state = createDevelopedGame(event.data.seed, progress => scope.postMessage({ type: 'progress', progress }));
    scope.postMessage({ type: 'complete', state });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Не удалось подготовить мир.' });
  }
};
