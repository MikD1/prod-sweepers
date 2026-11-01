import { describe, it, expect } from 'vitest';
import { deserializeGame, serializeGame, saveToStorage, loadFromStorage, SAVE_KEY } from './persistence';
import { BUILD_CELL, ECONOMY, GRID_W, GRID_H, HUB, PROCESSING, ROBOTS, SPAWN, STATIONS, TERMINALS, VEHICLES, type GameState } from './types';
import { buyUpgrade, createGame, getCapacity, updateGame } from './engine';

const terminalCell = { gx: Math.floor(TERMINALS[0].x / BUILD_CELL), gy: Math.floor(TERMINALS[0].y / BUILD_CELL) };
const R = 4, A = 5, T = 6, B = 7;
function fixture(): GameState {
  return {
    version: 5, seed: 17, time: 42,
    player: { ...SPAWN, facingX: 1, facingY: 0, tool: 'handbrush', bag: 12, capacityLevel: 1, speedLevel: 0, riding: false, vehicleKind: null },
    credits: 103, earned: 148, dust: Array(GRID_W * GRID_H).fill(0), totalDirt: 100, cleaned: 100,
    obstacles: [], landmarks: [], ownedTools: ['toothbrush', 'handbrush'], vehicles: [], robots: [],
    buildings: TERMINALS.map((terminal, index) => ({ id: 5 + index, kind: 'uplink', gx: Math.floor(terminal.x / BUILD_CELL), gy: Math.floor(terminal.y / BUILD_CELL), dir: 0, outputCursor: 0, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0, starter: true })),
    capsules: [], discoveries: [], milestones: ['first-delivery'], events: [], nextId: 9, cleanAccumulator: 0,
    recovered: { raw: 0, report: 0, test: 0 },
    stats: { delivered: 148, capsules: 10, built: 0, robotCleaned: 0, distance: 80, processed: 0, tested: 0, rawSold: 148, reportsSold: 0, testsSold: 0, rawReclaimed: 0 }, completed: false,
  };
}
function processingFixture(): GameState {
  const state = fixture(), { gx, gy } = terminalCell;
  state.buildings.push(
    { id: 9, kind: 'receiver', gx: gx - 4, gy, dir: 0, buffer: 17, outputBuffer: 0, processing: null, cooldown: .2 },
    { id: 10, kind: 'analyzer', gx: gx - 2, gy, dir: 0, buffer: 11, outputBuffer: 5, processing: { units: 8, remaining: PROCESSING.analyzer.cycle * .75 }, cooldown: .4 },
    { id: 11, kind: 'tester', gx: gx - 1, gy: gy + 2, dir: 3, buffer: 6, outputBuffer: 9, processing: { units: 3, remaining: PROCESSING.tester.cycle * .75 }, cooldown: 0 },
    { id: 12, kind: 'belt', gx: gx - 3, gy, dir: 0, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0 },
  );
  state.capsules = [
    { id: 13, gx: gx - 4, gy, dir: 0, progress: .2, units: 8, material: 'raw' },
    { id: 14, gx: gx - 3, gy, dir: 0, from: 2, progress: .4, units: 4, material: 'report' },
    { id: 15, gx: gx - 1, gy: gy + 2, dir: 3, progress: .6, units: 2, material: 'test' },
  ];
  state.nextId = 16;
  state.stats = { ...state.stats, processed: 48, tested: 8, rawSold: 120, reportsSold: 16, testsSold: 4, delivered: 140 };
  return state;
}
function fleetFixture(): GameState {
  const state = processingFixture();
  state.vehicles = [
    { kind: 'compact', x: STATIONS.garage.x + 48, y: STATIONS.garage.y + 24, heading: 8 * Math.PI + 1.2, speed: -80 },
    { kind: 'vehicle', x: STATIONS.garage.x + 96, y: STATIONS.garage.y + 24, heading: -12 * Math.PI, speed: VEHICLES.vehicle.speed },
  ];
  Object.assign(state.player, { x: state.vehicles[0].x, y: state.vehicles[0].y, riding: true, vehicleKind: 'compact' });
  state.robots = [
    { id: 16, kind: 'robot', x: HUB.x + 100, y: HUB.y + 200, bag: 41, capacity: 180, mode: 'returning', target: null, path: [], timer: -.4, cleanAccumulator: .6 },
    { id: 17, kind: 'industrialRobot', x: HUB.x + 300, y: HUB.y + 400, bag: 1000, capacity: ROBOTS.industrialRobot.capacity, mode: 'cleaning', target: { x: HUB.x + 312, y: HUB.y + 412 }, path: [{ x: HUB.x + 306, y: HUB.y + 406 }], timer: 4, cleanAccumulator: .3 },
  ];
  state.nextId = 18;
  return state;
}
function previousVersion(version: number): Record<string, any> {
  const old: any = fixture(); old.version = version;
  old.player.x = 780; old.player.y = 645;
  old.buildings = [{ ...old.buildings[0], id: 5, gx: 32, gy: 24 }];
  if (version < 3) {
    old.vehicle = null; old.robot = null; delete old.vehicles; delete old.robots; delete old.player.vehicleKind;
    if (version === 1) old.buildings[0].kind = 'analyzer';
  }
  return old;
}

describe('strict current-world saves', () => {
  it.each([1, 2, 3, 4])('rejects an actual previous v%s schema instead of migrating it', version => {
    const old = JSON.stringify(previousVersion(version));
    expect(deserializeGame(old) === null).toBe(true);
    expect(loadFromStorage({ getItem: () => old })).toBeNull();
  });
  it('restores exactly four protected sale terminals and the current central spawn', () => {
    const original = fixture(), restored = deserializeGame(serializeGame(original));
    expect(restored).not.toBeNull(); expect(restored!.version).toBe(5);
    expect(restored!.player).toEqual(original.player); expect(restored!.buildings).toEqual(original.buildings);
    expect(restored!.buildings).toHaveLength(4); expect(restored!.nextId).toBe(9);
    expect(deserializeGame(serializeGame(restored!))).toEqual(restored);
  });
  it.each([
    ['missing terminal', (s: any) => { s.buildings.shift(); }],
    ['extra fifth terminal', (s: any) => { s.buildings.push({ ...s.buildings[0], id: s.nextId++, gx: s.buildings[0].gx + 1 }); }],
    ['relocated terminal', (s: any) => { s.buildings[0].gx++; }],
    ['duplicate terminal position', (s: any) => { s.buildings[1].gx = s.buildings[0].gx; s.buildings[1].gy = s.buildings[0].gy; }],
    ['missing terminal protection', (s: any) => { delete s.buildings[0].starter; }],
    ['false terminal protection', (s: any) => { s.buildings[0].starter = false; }],
    ['nonnumeric terminal protection', (s: any) => { s.buildings[0].starter = 'true'; }],
  ])('rejects a malformed four-terminal contract: %s', (_name, mutate) => {
    const state = fixture(); mutate(state); expect(deserializeGame(JSON.stringify(state))).toBeNull();
  });
  it('roundtrips selected moving vehicles, signed speed, arbitrary finite heading and mixed robot cargo', () => {
    const state = fleetFixture(), restored = deserializeGame(serializeGame(state));
    expect(restored).not.toBeNull(); expect(restored).toEqual(state);
  });
  it.each([-1, 0, 1])('accepts vehicle speed at cruise boundary multiplier %s', multiplier => {
    const state = fleetFixture(); for (const vehicle of state.vehicles) vehicle.speed = VEHICLES[vehicle.kind].speed * multiplier;
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull(); expect(restored!.vehicles).toEqual(state.vehicles);
  });
  it('accepts the maximum fleet without clipping cargo or robot capacities', () => {
    const state = fleetFixture(); for (let i = 0; i < 3; i++) state.robots.push({ ...state.robots[0], id: state.nextId++, capacity: 800 + i, bag: 700 + i });
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull(); expect(restored!.robots).toEqual(state.robots);
  });
  it.each([
    ['old-size dust', (s: any) => { s.dust = Array(128 * 96).fill(0); }],
    ['missing vehicles', (s: any) => { delete s.vehicles; }],
    ['missing robots', (s: any) => { delete s.robots; }],
    ['missing selected kind', (s: any) => { delete s.player.vehicleKind; }],
    ['missing recovered inventory', (s: any) => { delete s.recovered; }],
    ['missing reclaim counter', (s: any) => { delete s.stats.rawReclaimed; }],
    ['obsolete singleton transport', (s: any) => { s.vehicle = { x: 10, y: 10 }; s.robot = null; }],
    ['riding no vehicle', (s: any) => { s.vehicles = []; }],
    ['riding null selection', (s: any) => { s.player.vehicleKind = null; }],
    ['riding unowned selection', (s: any) => { s.vehicles = s.vehicles.filter((v: any) => v.kind !== 'compact'); }],
    ['selection on foot', (s: any) => { s.player.riding = false; }],
    ['unknown vehicle', (s: any) => { s.vehicles[0].kind = 'train'; }],
    ['inherited vehicle kind', (s: any) => { s.vehicles[0].kind = 'constructor'; }],
    ['duplicate vehicle kind', (s: any) => { s.vehicles.push({ ...s.vehicles[0] }); }],
    ['invalid vehicle position', (s: any) => { s.vehicles[0].x = Infinity; }],
    ['missing vehicle heading', (s: any) => { delete s.vehicles[0].heading; }],
    ['nonfinite vehicle heading', (s: any) => { s.vehicles[0].heading = Infinity; }],
    ['nonnumeric vehicle heading', (s: any) => { s.vehicles[0].heading = '1'; }],
    ['missing vehicle speed', (s: any) => { delete s.vehicles[0].speed; }],
    ['nonfinite vehicle speed', (s: any) => { s.vehicles[0].speed = Infinity; }],
    ['nonnumeric vehicle speed', (s: any) => { s.vehicles[0].speed = '1'; }],
    ['speed above cruise', (s: any) => { s.vehicles[0].speed = VEHICLES.compact.speed + .01; }],
    ['reverse speed beyond cruise', (s: any) => { s.vehicles[0].speed = -VEHICLES.compact.speed - .01; }],
    ['unknown robot kind', (s: any) => { s.robots[0].kind = 'train'; }],
    ['inherited robot kind', (s: any) => { s.robots[0].kind = 'toString'; }],
    ['duplicate robot id', (s: any) => { s.robots[1].id = s.robots[0].id; }],
    ['noninteger robot id', (s: any) => { s.robots[0].id = 16.5; }],
    ['negative robot id', (s: any) => { s.robots[0].id = -1; }],
    ['future robot id', (s: any) => { s.robots[0].id = s.nextId; }],
    ['too many robots', (s: any) => { s.robots = Array.from({ length: 6 }, (_, i) => ({ ...s.robots[0], id: 20 + i })); s.nextId = 30; }],
    ['overloaded robot', (s: any) => { s.robots[0].bag = s.robots[0].capacity + 1; }],
    ['negative robot capacity', (s: any) => { s.robots[0].capacity = -1; }],
    ['invalid robot timer', (s: any) => { s.robots[0].timer = -1.1; }],
    ['invalid robot path', (s: any) => { s.robots[0].path = [{ x: -1, y: 5 }]; }],
  ])('rejects malformed v5 state: %s', (_name, mutate) => {
    const state = fleetFixture(); mutate(state); expect(deserializeGame(JSON.stringify(state))).toBeNull();
  });
});

describe('durable current production progress', () => {
  it('roundtrips recovered material, cursors, input/output buffers, active jobs and typed capsules', () => {
    const state = processingFixture(); state.recovered = { raw: 17, report: 9, test: 4 };
    state.buildings[R].outputCursor = 0; state.buildings[A].outputCursor = 3; state.buildings[T].outputCursor = 1;
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull();
    expect(restored).toEqual(state); expect(deserializeGame(serializeGame(restored!))).toEqual(state);
  });
  it('preserves absent optional cursor and entry-side fields without adding schema defaults', () => {
    const state = processingFixture(); for (const b of state.buildings) delete b.outputCursor; for (const c of state.capsules) delete c.from;
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull();
    expect(restored!.buildings).toEqual(state.buildings); expect(restored!.capsules).toEqual(state.capsules);
  });
  it('finishes saved current-cycle jobs exactly once and conserves their units', () => {
    const state = fixture(), { gx, gy } = terminalCell;
    state.buildings.push(
      { id: 9, kind: 'analyzer', gx: gx - 1, gy, dir: 0, buffer: 0, outputBuffer: 0, processing: { units: 8, remaining: PROCESSING.analyzer.cycle }, cooldown: 0 },
      { id: 10, kind: 'tester', gx, gy: gy + 1, dir: 3, buffer: 0, outputBuffer: 0, processing: { units: 8, remaining: PROCESSING.tester.cycle }, cooldown: 0 },
    ); state.nextId = 11;
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull();
    for (let i = 0; i < 40; i++) updateGame(restored!, .1, { dx: 0, dy: 0, clean: false });
    expect(restored!.credits).toBe(state.credits + 80); expect(restored!.stats.reportsSold).toBe(8); expect(restored!.stats.testsSold).toBe(8);
    expect(restored!.stats.delivered).toBe(state.stats.delivered + 16); expect(restored!.capsules).toEqual([]);
    expect(restored!.buildings.every(b => b.buffer === 0 && b.outputBuffer === 0 && b.processing === null)).toBe(true);
  });
  it.each([
    ['negative recovered amount', (s: any) => { s.recovered.raw = -1; }],
    ['nonfinite recovered amount', (s: any) => { s.recovered.report = Infinity; }],
    ['nonnumeric recovered amount', (s: any) => { s.recovered.test = '4'; }],
    ['missing recovered material', (s: any) => { delete s.recovered.report; }],
    ['unknown recovered material', (s: any) => { s.recovered.credits = 8; }],
    ['null recovered inventory', (s: any) => { s.recovered = null; }],
    ['array recovered inventory', (s: any) => { s.recovered = [0, 0, 0]; }],
    ['negative output cursor', (s: any) => { s.buildings[R].outputCursor = -1; }],
    ['oversized output cursor', (s: any) => { s.buildings[R].outputCursor = 4; }],
    ['fractional output cursor', (s: any) => { s.buildings[R].outputCursor = 1.5; }],
    ['null output cursor', (s: any) => { s.buildings[R].outputCursor = null; }],
    ['negative capsule entry', (s: any) => { s.capsules[1].from = -1; }],
    ['oversized capsule entry', (s: any) => { s.capsules[1].from = 4; }],
    ['fractional capsule entry', (s: any) => { s.capsules[1].from = 1.5; }],
    ['nonnumeric capsule entry', (s: any) => { s.capsules[1].from = '2'; }],
    ['unknown capsule material', (s: any) => { s.capsules[0].material = 'credits'; }],
    ['inherited capsule material', (s: any) => { s.capsules[0].material = 'constructor'; }],
    ['missing capsule material', (s: any) => { delete s.capsules[0].material; }],
    ['negative output buffer', (s: any) => { s.buildings[A].outputBuffer = -1; }],
    ['missing output buffer', (s: any) => { delete s.buildings[A].outputBuffer; }],
    ['missing processing state', (s: any) => { delete s.buildings[A].processing; }],
    ['oversized processing batch', (s: any) => { s.buildings[A].processing.units = 9; }],
    ['empty processing batch', (s: any) => { s.buildings[A].processing.units = 0; }],
    ['fractional processing batch', (s: any) => { s.buildings[A].processing.units = 1.5; }],
    ['negative remaining work', (s: any) => { s.buildings[A].processing.remaining = -1; }],
    ['nonfinite remaining work', (s: any) => { s.buildings[A].processing.remaining = Infinity; }],
    ['analyzer work beyond current cycle', (s: any) => { s.buildings[A].processing.remaining = PROCESSING.analyzer.cycle + .01; }],
    ['tester work beyond current cycle', (s: any) => { s.buildings[T].processing.remaining = PROCESSING.tester.cycle + .01; }],
    ['obsolete analyzer cycle', (s: any) => { s.buildings[A].processing.remaining = 2.4; }],
    ['obsolete tester cycle', (s: any) => { s.buildings[T].processing.remaining = 4; }],
    ['receiver processing job', (s: any) => { s.buildings[R].processing = { units: 8, remaining: .1 }; }],
    ['receiver output inventory', (s: any) => { s.buildings[R].outputBuffer = 1; }],
    ['belt input inventory', (s: any) => { s.buildings[B].buffer = 1; }],
    ['belt output inventory', (s: any) => { s.buildings[B].outputBuffer = 1; }],
    ['terminal input inventory', (s: any) => { s.buildings[0].buffer = 1; }],
    ['terminal output inventory', (s: any) => { s.buildings[0].outputBuffer = 1; }],
    ['missing production statistics', (s: any) => { delete s.stats.processed; }],
    ['negative production statistics', (s: any) => { s.stats.testsSold = -1; }],
    ['inherited structure kind', (s: any) => { s.buildings[R].kind = 'toString'; }],
    ['inherited equipped tool', (s: any) => { s.player.tool = 'toString'; s.ownedTools = ['toothbrush', 'toString']; }],
    ['duplicate building cell', (s: any) => { s.buildings[A].gx = s.buildings[R].gx; s.buildings[A].gy = s.buildings[R].gy; }],
  ])('rejects corrupt production or routing data: %s', (_name, mutate) => {
    const state = processingFixture(); mutate(state); expect(deserializeGame(JSON.stringify(state))).toBeNull();
  });
  it('applies best-owned-tool capacity after loading without changing cargo or funds', () => {
    const state = fixture(); state.ownedTools.push('broom', 'widebrush'); state.player.tool = 'toothbrush'; state.player.bag = 725;
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull(); expect(restored!.player).toEqual(state.player);
    expect(restored!.credits).toBe(state.credits); expect(getCapacity(restored!)).toBe(1500);
  });
  it('keeps the reclaimed-material counter across repeated saves without resetting sale stock', () => {
    const state = processingFixture(); state.stats.rawReclaimed = 32;
    const restored = deserializeGame(serializeGame(state)); expect(restored?.stats.rawReclaimed).toBe(32);
    const savedAgain = deserializeGame(serializeGame(restored!)); expect(savedAgain?.stats.rawSold).toBe(120); expect(savedAgain?.stats.rawReclaimed).toBe(32);
  });
  it.each([0, 120])('accepts reclaimed stock boundary %s', value => {
    const state = processingFixture(); state.stats.rawReclaimed = value; expect(deserializeGame(serializeGame(state))?.stats.rawReclaimed).toBe(value);
  });
  it.each([-1, 121, Infinity, '4', null])('rejects invalid reclaimed stock %s', value => {
    const state: any = processingFixture(); state.stats.rawReclaimed = value; expect(deserializeGame(JSON.stringify(state))).toBeNull();
  });
  it.each([null, '', '{broken', '{}', '{"version":4}'])('ignores unreadable saves: %s', raw => { expect(deserializeGame(raw)).toBeNull(); });
  it('rejects malformed inventories, world cells and transport data', () => {
    for (const mutate of [
      (s: any) => { s.player.bag = -1; }, (s: any) => { s.player.x = '780'; }, (s: any) => { s.dust.pop(); },
      (s: any) => { s.dust[0] = -10; }, (s: any) => { s.totalDirt++; }, (s: any) => { s.buildings[0].dir = 8; },
      (s: any) => { s.capsules = [{ id: 9, ...terminalCell, units: -8, progress: 0, dir: 0 }]; }, (s: any) => { s.robots = [{ x: 1 }]; },
    ]) { const state = fixture(); mutate(state); expect(deserializeGame(JSON.stringify(state))).toBeNull(); }
  });
  it('clears transient events while preserving credits, cleanup and inventory', () => {
    const state = fixture(); state.events = [{ id: state.nextId++, kind: 'credit', ...HUB, text: '+8', amount: 8, time: 42 }];
    const restored = deserializeGame(JSON.stringify(state)); expect(restored).not.toBeNull();
    expect(restored!.events).toEqual([]); expect(restored!.player.bag).toBe(12); expect(restored!.credits).toBe(103); expect(restored!.cleaned).toBe(100);
    expect(JSON.parse(serializeGame(state)).events).toEqual([]);
  });
  it('handles unavailable browser storage and saves current state through the stable key', () => {
    expect(saveToStorage({ setItem() { throw new Error('quota'); } }, fixture())).toBe(false);
    expect(loadFromStorage({ getItem() { throw new Error('blocked'); } })).toBeNull();
    const values = new Map<string, string>(), storage = { setItem(k: string, v: string) { values.set(k, v); }, getItem(k: string) { return values.get(k) ?? null; } };
    expect(saveToStorage(storage, fixture())).toBe(true); expect(values.has(SAVE_KEY)).toBe(true); expect(loadFromStorage(storage)?.player.capacityLevel).toBe(1);
  });
  it('restores a runtime idle robot after current-world cleanup', () => {
    const state = createGame(23); state.ownedTools = ['toothbrush', 'handbrush']; Object.assign(state.player, STATIONS.garage);
    const { gx, gy } = terminalCell;
    state.buildings.push({ id: state.nextId++, kind: 'receiver', gx: gx - 1, gy, dir: 0, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0 });
    state.stats.reportsSold = ECONOMY.robotReports; state.stats.delivered = ECONOMY.robotReports; state.credits = ECONOMY.robot;
    expect(buyUpgrade(state, 'robot').ok).toBe(true); state.dust.fill(0); state.cleaned = state.totalDirt;
    updateGame(state, .1, { dx: 0, dy: 0, clean: false }); expect(state.robots[0].timer).toBeLessThan(0);
    const restored = deserializeGame(serializeGame(state)); expect(restored).not.toBeNull();
    expect(restored!.robots[0].timer).toBe(state.robots[0].timer); expect(restored!.cleaned).toBe(state.totalDirt);
  });
});


describe('v5 reset boundary', () => {
  it('rejects an otherwise valid v4 world instead of reusing its global-work assumptions', () => {
    const old: any = fixture(); old.version = 4;
    expect(deserializeGame(JSON.stringify(old)) === null).toBe(true);
  });
});
