import { createProgressionReplay } from './autoplay';
import { type GameState } from './types';

export interface DevelopedProgress {
  elapsedSeconds: number;
  targetSeconds: number;
  goal: string | null;
  percent: number;
}

/** Fast-forward only real engine actions. The browser runs this in a worker. */
export function createDevelopedGame(seed = 42, onProgress?: (progress: DevelopedProgress) => void): GameState {
  const targetSeconds = 30 * 60;
  let percent = 0;
  const report = (elapsedSeconds: number, goal: string | null, complete = false) => {
    percent = complete ? 99 : Math.max(percent, Math.min(99, Math.floor(elapsedSeconds / targetSeconds * 99)));
    onProgress?.({ elapsedSeconds, targetSeconds, goal, percent });
  };
  report(0, 'handbrush');
  const replay = createProgressionReplay(seed, { parallelFactories: 2, layoutStrategy: 'network', maxSeconds: 75 * 60, stopAtFirstPro: true, safeHandoff: true, showcaseRobots: 2 });
  let lastReport = 0;
  let previousGoal = replay.goal;
  while (!replay.done) {
    replay.step();
    if (replay.state.time - lastReport >= 30 || replay.goal !== previousGoal) {
      report(replay.state.time, replay.goal);
      lastReport = replay.state.time;
      previousGoal = replay.goal;
    }
  }
  const state = replay.state;
  if (state.robots.filter(robot => robot.kind === 'industrialRobot').length !== 2) throw Error('Replay stopped before both PRO purchases.');
  const remaining = state.dust.reduce((sum, units) => sum + units, 0);
  const held = state.player.bag + state.robots.reduce((sum, robot) => sum + robot.bag, 0)
    + Object.values(state.recovered).reduce((sum, units) => sum + units, 0)
    + state.capsules.reduce((sum, capsule) => sum + capsule.units, 0)
    + state.buildings.reduce((sum, building) => sum + building.buffer + building.outputBuffer + (building.processing?.units ?? 0), 0);
  if (remaining + held + state.stats.delivered - state.stats.rawReclaimed !== state.totalDirt) throw Error('Replay material accounting failed.');
  report(state.time, null, true);
  return state;
}
