import { describe, expect, it } from 'vitest';
import { createIndustrialNetworkPlan, createProgressionReplay } from './autoplay';
import { createGame, placeBuilding, receiverHasRoute, updateGame } from './engine';
import { deserializeGame, serializeGame } from './persistence';
import { BUILD_CELL, BUILDINGS, ECONOMY, GRID_W, HUB, MATERIALS, TOOLS, VEHICLES, type GameState } from './types';

const held = (s: GameState) => s.player.bag + s.robots.reduce((n, r) => n + r.bag, 0)
  + Object.values(s.recovered).reduce((a, b) => a + b, 0) + s.capsules.reduce((n, c) => n + c.units, 0)
  + s.buildings.reduce((n, b) => n + b.buffer + b.outputBuffer + (b.processing?.units ?? 0), 0);
const mass = (s: GameState) => s.dust.reduce((a, b) => a + b, 0) + held(s) + s.stats.delivered - s.stats.rawReclaimed;
function finish(seed: number) {
  const replay = createProgressionReplay(seed, { parallelFactories: 2, maxSeconds: 4500, stopAtFirstPro: true });
  while (!replay.done) {
    replay.step();
    expect(replay.state.credits).toBeGreaterThanOrEqual(0);
    if (replay.frames % 500 === 0) expect(mass(replay.state)).toBe(replay.state.totalDirt);
  }
  return replay;
}

describe('real progression replay', () => {
  it('splits one financed receiver through a common trunk into four working lanes with independent product outlets', () => {
    const state = createGame(42);
    // Only this isolated throughput fixture is financed and gate-qualified.
    state.credits = 1_000_000; state.ownedTools.push('handbrush');
    state.stats.reportsSold = 64; state.stats.delivered = 64;
    const network = createIndustrialNetworkPlan(state, { lanes: 4, remoteDistance: 360 });
    for (const [kind,gx,gy,dir] of network.plan) {
      Object.assign(state.player,{x:gx*24+12,y:gy*24+12});
      expect(placeBuilding(state,kind,gx,gy,dir).ok).toBe(true);
    }
    expect(state.buildings.filter(b=>b.kind==='receiver')).toHaveLength(1);
    expect(network.lanes).toHaveLength(4);
    const paths = network.lanes.map(lane=>new Set(lane.outputPath.map(cell=>`${cell.gx},${cell.gy}`)));
    for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)expect([...paths[i]].some(cell=>paths[j].has(cell))).toBe(false);
    const receiver=state.buildings.find(b=>b.gx===network.receiver.gx&&b.gy===network.receiver.gy)!;
    expect(receiverHasRoute(state,receiver)).toBe(true);
    const baseline=mass(state), baselineSales=state.stats.testsSold, baselineEarned=state.earned;
    receiver.buffer=4096;
    const working=new Set<number>();
    for(let frame=0;frame<4000;frame++) {
      updateGame(state,.05,{dx:0,dy:0,clean:false});
      for(const b of state.buildings)if(b.kind==='tester'&&(b.processing||b.outputBuffer))working.add(b.id);
    }
    expect(working.size).toBe(4);
    expect(state.stats.testsSold-baselineSales).toBe(4096);
    expect(state.earned-baselineEarned).toBe(4096*7);
    expect(mass(state)).toBe(baseline+4096);
  },30_000);
  it.each([42,17,2493285394])('physically builds diverse production, a working fork and a distant receiver in seed %i', seed => {
    const replay = createProgressionReplay(seed, { layoutStrategy: 'network', stopAtFirstPro: true });
    let distantRawCapsules = 0;
    const fedSouthernAnalyzers = new Set<number>();
    while (!replay.done) {
      replay.step();
      if (replay.frames % 500 === 0) expect(mass(replay.state)).toBe(replay.state.totalDirt);
      distantRawCapsules += replay.state.capsules.filter(c => c.material === 'raw' && Math.hypot(c.gx * BUILD_CELL + 12 - HUB.x, c.gy * BUILD_CELL + 12 - HUB.y) > 600).length;
      for (const b of replay.state.buildings) if (b.kind === 'analyzer' && b.gy * BUILD_CELL > HUB.y && (b.buffer || b.outputBuffer || b.processing)) fedSouthernAnalyzers.add(b.id);
    }
    const state = replay.state;
    expect(state.buildings.filter(b => b.kind === 'analyzer')).toHaveLength(6);
    expect(state.buildings.filter(b => b.kind === 'tester')).toHaveLength(6);
    expect(fedSouthernAnalyzers.size).toBe(4);
    const receivers = state.buildings.filter(b => b.kind === 'receiver');
    expect(receivers).toHaveLength(4);
    expect(receivers.every(b => receiverHasRoute(state, b))).toBe(true);
    expect(receivers.filter(b => Math.hypot(b.gx * BUILD_CELL + 12 - HUB.x, b.gy * BUILD_CELL + 12 - HUB.y) >= 1300)).toHaveLength(2);
    expect(receivers.some(b => Math.hypot(b.gx * BUILD_CELL + 12 - HUB.x, b.gy * BUILD_CELL + 12 - HUB.y) >= 1560)).toBe(true);
    expect(distantRawCapsules).toBeGreaterThan(0);
    const cells = new Set(state.buildings.map(b => `${b.gx},${b.gy}`));
    expect(state.buildings.some(b => b.kind === 'belt' && [[1,0],[-1,0],[0,1],[0,-1]].filter(([x,y]) => cells.has(`${b.gx+x},${b.gy+y}`)).length >= 3)).toBe(true);
    expect(state.credits).toBeGreaterThanOrEqual(0);
    expect(mass(state)).toBe(state.totalDirt);
    expect(deserializeGame(serializeGame(state))).toEqual({ ...state, events: [] });
  }, 60_000);
  it('begins with the exact fresh game and advances through real bounded engine ticks', () => {
    const replay = createProgressionReplay(42, { stopAtFirstPro: true });
    expect(replay.state).toEqual(createGame(42)); expect(replay.done).toBe(false);
    let previous = { ...replay.state.player };
    for (let i = 0; i < 600; i++) {
      const time = replay.state.time; replay.step();
      expect(replay.state.time - time).toBeGreaterThan(0); expect(replay.state.time - time).toBeLessThanOrEqual(.100001);
      expect(Math.hypot(replay.state.player.x - previous.x, replay.state.player.y - previous.y)).toBeLessThanOrEqual(25);
      expect(replay.state.credits).toBe(replay.state.earned);
      previous = { ...replay.state.player };
    }
    expect(mass(replay.state)).toBe(replay.state.totalDirt);
  });
  it.each([42, 17])('reaches the first PRO with actual funds, two lines, trails and live cargo for seed %i', seed => {
    const replay = finish(seed), state = replay.state, fresh = createGame(seed);
    expect(state.time).toBeGreaterThan(10 * 60); expect(state.time).toBeLessThan(45 * 60);
    expect(replay.goal).toBeNull(); expect(replay.milestones.at(-1)?.id).toBe('industrialRobot');
    expect(state.robots.map(r => r.kind).sort()).toEqual(['industrialRobot', 'robot']);
    expect(state.vehicles.map(v => v.kind).sort()).toEqual(['compact', 'vehicle']);
    expect(state.buildings.filter(b => b.kind === 'analyzer')).toHaveLength(2);
    expect(state.buildings.filter(b => b.kind === 'tester')).toHaveLength(2);
    const machines = state.buildings.filter(b => b.kind !== 'belt');
    for (let i = 0; i < machines.length; i++) for (let j = i + 1; j < machines.length; j++) {
      expect(Math.abs(machines[i].gx - machines[j].gx) + Math.abs(machines[i].gy - machines[j].gy)).toBeGreaterThanOrEqual(2);
    }
    expect(state.stats.rawSold).toBeGreaterThanOrEqual(TOOLS.handbrush.price);
    expect(state.stats.testsSold).toBeGreaterThanOrEqual(ECONOMY.robotTests);
    expect(state.earned).toBe(state.stats.rawSold * MATERIALS.raw.value + state.stats.reportsSold * MATERIALS.report.value
      + state.stats.testsSold * MATERIALS.test.value + state.discoveries.length * 25);
    const cost = state.ownedTools.reduce((n, tool) => n + TOOLS[tool].price, 0)
      + ECONOMY.capacity.slice(0, state.player.capacityLevel).reduce((a, b) => a + b, 0)
      + ECONOMY.speed.slice(0, state.player.speedLevel).reduce((a, b) => a + b, 0)
      + VEHICLES.compact.price + VEHICLES.vehicle.price + ECONOMY.robot + ECONOMY.industrialRobot
      + state.buildings.reduce((n, b) => n + (b.kind === 'uplink' ? 0 : BUILDINGS[b.kind].price), 0)
      + 2 * (BUILDINGS.belt.price - Math.floor(BUILDINGS.belt.price / 2));
    expect(state.earned - state.credits).toBe(cost); expect(mass(state)).toBe(state.totalDirt);
    expect(held(state)).toBeGreaterThan(0);
    let farthestTrail = 0, closestRemaining = Infinity;
    for (let i = 0; i < state.dust.length; i++) {
      expect(state.dust[i]).toBeLessThanOrEqual(fresh.dust[i]);
      const d = (i % GRID_W * 12 + 6 - HUB.x) ** 2 + (Math.floor(i / GRID_W) * 12 + 6 - HUB.y) ** 2;
      if (state.dust[i] < fresh.dust[i]) farthestTrail = Math.max(farthestTrail, d);
      if (state.dust[i]) closestRemaining = Math.min(closestRemaining, d);
    }
    expect(farthestTrail).toBeGreaterThan(closestRemaining * 2);
    expect(deserializeGame(serializeGame(state))).toEqual({ ...state, events: [] });
    const snapshot = serializeGame(state); replay.step(); expect(serializeGame(state)).toBe(snapshot);
  }, 30_000);
  it('is reproducible and leaves unrelated fresh worlds unchanged', () => {
    const a = finish(42), b = finish(42);
    expect(a.state).toEqual(b.state); expect(a.milestones).toEqual(b.milestones); expect(a.frames).toBe(b.frames);
    expect(createGame(42).credits).toBe(0); expect(createGame(42).cleaned).toBe(0);
  }, 30_000);
  it.each([2493285394, 0, 0xffffffff])('keeps construction reachable without substituting seed %i', seed => {
    const replay = finish(seed);
    expect(replay.state.seed).toBe(seed);
    expect(replay.state.robots.some(robot => robot.kind === 'industrialRobot')).toBe(true);
    expect(mass(replay.state)).toBe(replay.state.totalDirt);
    expect(replay.frames).toBeLessThan(100000);
  }, 30_000);
  it('throws on an insufficient time budget rather than manufacturing a completed preset', () => {
    const replay = createProgressionReplay(42, { maxSeconds: 1, stopAtFirstPro: true });
    expect(() => { while (!replay.done) replay.step(); }).toThrow(/time|limit|budget/i);
    expect(replay.state.robots).toEqual([]); expect(replay.state.credits).toBeLessThan(400);
  });
});
