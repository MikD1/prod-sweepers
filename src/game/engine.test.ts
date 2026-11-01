import { describe, expect, it } from 'vitest';
import * as engine from './engine';
import { buyUpgrade as purchaseAtStation, canPlaceBuilding, createGame, equipTool, getCapacity, getContextAction, getSpeed, interact, placeBuilding, removeBuilding, rotateBuilding, toggleVehicle, updateGame } from './engine';
import { CELL, DIRECTIONS, ECONOMY, GRID_H, GRID_W, HUB, SPAWN, TERMINALS, LOGISTICS, PROCESSING, RECEIVER_CAPACITY, ROBOTS, STATIONS, VEHICLES, type BuildKind, type Building, type Direction, type GameState, type MaterialKind, type UpgradeId } from './types';
import { deserializeGame, serializeGame } from './persistence';

// Economy setup for focused legacy scenarios; station enforcement is tested directly below.
function buyUpgrade(state: GameState, id: UpgradeId) {
  const savedPosition = { x: state.player.x, y: state.player.y };
  const station = ['compact', 'vehicle', 'robot', 'industrialRobot'].includes(id) ? STATIONS.garage : STATIONS.workshop;
  state.player.x = station.x; state.player.y = station.y;
  const before = state.robots?.length ?? 0;
  const outcome = purchaseAtStation(state, id);
  state.player.x = savedPosition.x; state.player.y = savedPosition.y;
  // Existing navigation scenarios start the actor beside their authored obstacle.
  if (outcome.ok && state.robots.length > before) Object.assign(state.robots.at(-1)!, savedPosition);
  return outcome;
}
const idle = { dx: 0, dy: 0, clean: false };
function tick(state: GameState, seconds: number) {
  for (let i = 0; i < Math.ceil(seconds * 10 - 1e-9); i++) updateGame(state, 0.1, idle);
}
function freshWorld() {
  const state = createGame(7);
  state.obstacles = [];
  state.dust.fill(0);
  state.landmarks = [];
  state.player.x = 780; state.player.y = 645;
  return state;
}
function clearWorld() {
  const state = freshWorld();
  // These fixtures explicitly model a loaded legacy factory, not a fresh world.
  const terminal: Building = { id: 5, kind: 'uplink', gx: 32, gy: 24, dir: 0, outputCursor: 0, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0, starter: true };
  const empty = { buffer: 0, outputBuffer: 0, processing: null, cooldown: 0, starter: true };
  state.buildings = [
    { ...empty, id: 1, kind: 'receiver', gx: 28, gy: 24, dir: 0 },
    { ...empty, id: 2, kind: 'belt', gx: 29, gy: 24, dir: 0 },
    { ...empty, id: 3, kind: 'belt', gx: 30, gy: 24, dir: 0 },
    { ...empty, id: 4, kind: 'belt', gx: 31, gy: 24, dir: 0 },
    terminal,
  ];
  return state;
}
function pile(state: GameState, x: number, y: number, amount: number) {
  const index = Math.floor(y / CELL) * GRID_W + Math.floor(x / CELL);
  state.dust[index] = amount;
  return index;
}
function addMachine(state: GameState, kind: BuildKind, gx: number, gy: number, dir: Direction = 3): Building {
  const building: Building = { id: state.nextId++, kind, gx, gy, dir, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0 };
  state.buildings.push(building);
  return building;
}
function connectedRemote(state: GameState, gx: number, gy: number) {
  const receiver = addMachine(state, 'receiver', gx, gy);
  const terminal = state.buildings.find(building => building.kind === 'uplink')!;
  const cell = (x: number, y: number) => { if (!state.buildings.some(building => building.gx === x && building.gy === y)) addMachine(state, 'belt', x, y); };
  for (let x = gx + Math.sign(terminal.gx - gx); x !== terminal.gx; x += Math.sign(terminal.gx - gx)) cell(x, gy);
  if (gy !== terminal.gy) cell(terminal.gx, gy);
  for (let y = gy + Math.sign(terminal.gy - gy); y !== terminal.gy; y += Math.sign(terminal.gy - gy)) cell(terminal.gx, y);
  return receiver;
}
function factory() {
  const state = clearWorld();
  // Keep the real fixed sale terminal; test factories cannot manufacture new sale points.
  state.buildings = state.buildings.filter(building => building.gx === 32 && building.gy === 24);
  return state;
}
function heldMaterial(state: GameState) {
  return state.player.bag + state.robots.reduce((sum, robot) => sum + robot.bag, 0)
    + Object.values(state.recovered ?? {}).reduce((sum, units) => sum + units, 0)
    + state.capsules.reduce((sum, capsule) => sum + capsule.units, 0)
    + state.buildings.reduce((sum, building) => sum + building.buffer + building.outputBuffer + (building.processing?.units ?? 0), 0);
}
function qualifyVehicle(state: GameState) {
  state.ownedTools.push('widebrush');
  state.player.capacityLevel = 2;
  state.stats.testsSold = 128;
  state.credits = VEHICLES.vehicle.price;
}
function qualifyRobot(state: GameState) {
  state.ownedTools.push('handbrush');
  state.stats.reportsSold = 16;
  state.credits = ROBOTS.robot.price;
}

describe('world and movement', () => {
  it('creates a deterministic reachable world whose dust accounting matches the layers', () => {
    const a = createGame(100);
    const b = createGame(100);
    expect(a.dust).toHaveLength(GRID_W * GRID_H);
    expect(a.dust).toEqual(b.dust);
    expect(a.totalDirt).toBe(a.dust.reduce((sum, n) => sum + n, 0));
    expect(a.totalDirt).toBeGreaterThan(10000);
    expect(a.obstacles.length).toBeGreaterThan(10);
    expect(a.landmarks.length).toBeGreaterThan(3);
    expect(a.credits).toBe(0);
  });

  it('clamps long frames and normalizes diagonal movement', () => {
    const state = clearWorld();
    const { x, y } = state.player;
    updateGame(state, 10, { dx: 1, dy: 1, clean: false });
    expect(Math.hypot(state.player.x - x, state.player.y - y)).toBeCloseTo(11);
    expect(state.time).toBeCloseTo(0.1);
  });

  it('slides along scenery without crossing it or the world boundary', () => {
    const state = clearWorld();
    state.player.x = 90;
    state.player.y = 100;
    state.obstacles = [{ x: 105, y: 50, w: 40, h: 160, kind: 'server' }];
    for (let i = 0; i < 40; i++) updateGame(state, 0.1, { dx: 1, dy: 0.25, clean: false });
    expect(state.player.x).toBeLessThanOrEqual(97);
    expect(state.player.y).toBeGreaterThan(100);
    state.player.x = 9;
    state.player.y = 9;
    for (let i = 0; i < 10; i++) updateGame(state, 0.1, { dx: -1, dy: -1, clean: false });
    expect(state.player.x).toBeGreaterThanOrEqual(8);
    expect(state.player.y).toBeGreaterThanOrEqual(8);
  });

  it('discovers each landmark once and awards a useful early credit reward', () => {
    const state = clearWorld();
    state.landmarks = [{ id: 'test', x: state.player.x, y: state.player.y, name: 'Тестовый сервер', color: '#fff' }];
    tick(state, 2);
    expect(state.discoveries).toEqual(['test']);
    expect(state.credits).toBe(25);
  });
});

describe('automatic four-side factory connections', () => {
  const sides = [0, 1, 2, 3] as Direction[];
  const outputs = [
    { kind: 'receiver', material: 'raw', value: 1 },
    { kind: 'analyzer', material: 'report', value: 3 },
    { kind: 'tester', material: 'test', value: 7 },
    { kind: 'belt', material: 'raw', value: 1 },
    { kind: 'belt', material: 'report', value: 3 },
    { kind: 'belt', material: 'test', value: 7 },
  ] as const;

  it.each(outputs.flatMap(output => sides.map(side => ({ ...output, side }))))('$kind routes $material to the terminal on side $side without rotation', ({ kind, material, value, side }) => {
    const state = factory();
    const vector = DIRECTIONS[side];
    const source = addMachine(state, kind, 32 - vector.x, 24 - vector.y, ((side + 2) % 4) as Direction);
    if (kind === 'receiver') source.buffer = 8;
    else if (kind === 'belt') state.capsules.push({ id: 1000, gx: source.gx, gy: source.gy, dir: source.dir, progress: 0, units: 8, material });
    else source.outputBuffer = 8;
    tick(state, 3);
    expect(state.credits).toBe(8 * value);
    expect(state.stats.delivered).toBe(8);
    expect(heldMaterial(state)).toBe(0);
  });

  it.each(sides.flatMap(side => (['analyzer', 'tester'] as const).map(kind => ({ side, kind }))))('$kind accepts matching input on side $side independently of its orientation', ({ side, kind }) => {
    const state = factory();
    const machine = addMachine(state, kind, 36, 28, side);
    const direction = DIRECTIONS[side];
    const source = addMachine(state, kind === 'analyzer' ? 'receiver' : 'analyzer', 36 + direction.x, 28 + direction.y, side);
    if (source.kind === 'receiver') source.buffer = 8;
    else source.outputBuffer = 8;
    tick(state, 0.1 + Math.ceil(LOGISTICS.hopDuration / 0.1) * 0.1);
    expect(machine.buffer + (machine.processing?.units ?? 0)).toBe(8);
    expect(state.credits).toBe(0);
    expect(heldMaterial(state)).toBe(8);
  });

  it.each(outputs.slice(0, 3))('round-robins $material output between available branches without changing material', ({ kind, material }) => {
    const state = factory();
    const source = addMachine(state, kind, 36, 28, 0);
    source.outputCursor = 0;
    const supplied = kind === 'receiver' ? LOGISTICS.rawCapsuleUnits * 4 : 32;
    if (kind === 'receiver') source.buffer = supplied;
    else source.outputBuffer = 32;
    for (const [gx, gy] of [[37,28],[38,28],[38,27],[38,26],[38,25],[38,24],[37,24],[36,24],[36,27],[36,26],[36,25],[35,24],[34,24],[33,24]]) addMachine(state, 'belt', gx, gy, 0);
    const departed = new Set<number>();
    const sidesTaken: number[] = [];
    for (let i = 0; i < 100; i++) {
      updateGame(state, 0.1, idle);
      for (const capsule of state.capsules) if (!departed.has(capsule.id)) {
        if (capsule.gx === 37 && capsule.gy === 28 || capsule.gx === 36 && capsule.gy === 27) {
          departed.add(capsule.id);
          sidesTaken.push(capsule.gx === 37 ? 0 : 3);
          expect(capsule.material).toBe(material);
        }
      }
      expect(heldMaterial(state) + state.stats.delivered).toBe(supplied);
    }
    expect(sidesTaken).toEqual([0, 3, 0, 3]);
  });

  it('keeps a chosen valid transfer progressing when another outlet becomes available', () => {
    const state = factory();
    const source = addMachine(state, 'belt', 36, 28, 0);
    source.outputCursor = 0;
    addMachine(state, 'belt', 37, 28);
    addMachine(state, 'belt', 36, 27);
    state.capsules.push({ id: 1000, gx: 36, gy: 28, dir: 3, from: 2, progress: 0.3, units: 8, material: 'raw' });
    updateGame(state, 0.1, idle);
    expect(state.capsules[0].dir).toBe(3);
    expect(state.capsules[0].progress).toBeGreaterThan(0.3);
    expect(source.outputCursor).toBe(0);
  });

  it('reroutes around a newly blocked outlet and advances the cursor only after successful handoff', () => {
    const state = factory();
    const source = addMachine(state, 'belt', 36, 28, 0);
    source.outputCursor = 0;
    addMachine(state, 'belt', 37, 28);
    addMachine(state, 'belt', 36, 29);
    state.capsules.push({ id: 1000, gx: 36, gy: 28, dir: 0, from: 2, progress: 0.3, units: 8, material: 'raw' });
    state.capsules.push({ id: 1001, gx: 37, gy: 28, dir: 0, from: 2, progress: 0, units: 1, material: 'raw' });
    updateGame(state, 0.1, idle);
    expect(state.capsules.find(capsule => capsule.id === 1000)!.dir).toBe(1);
    expect(state.capsules.find(capsule => capsule.id === 1000)!.progress).toBeCloseTo(0.1 / LOGISTICS.hopDuration);
    expect(source.outputCursor).toBe(0);
    tick(state, 0.5);
    const transferred = state.capsules.find(capsule => capsule.id === 1000)!;
    expect([transferred.gx, transferred.gy, transferred.from]).toEqual([36, 29, 3]);
    expect(source.outputCursor).toBe(2);
    expect(heldMaterial(state)).toBe(9);
  });

  it('does not bounce into its entry side, waits at a dead end, then follows a new branch', () => {
    const state = factory();
    addMachine(state, 'belt', 35, 28);
    addMachine(state, 'belt', 36, 28, 2);
    state.capsules.push({ id: 1000, gx: 36, gy: 28, dir: 2, from: 2, progress: 0, units: 8, material: 'report' });
    tick(state, 3);
    expect(state.capsules[0].gx).toBe(36);
    expect(state.capsules[0].gy).toBe(28);
    addMachine(state, 'belt', 36, 27);
    tick(state, 1);
    expect([state.capsules[0].gx, state.capsules[0].gy, state.capsules[0].from]).toEqual([36, 27, 1]);
    expect(heldMaterial(state)).toBe(8);
  });

  it('circulates without duplication in a loop and exits after a branch to the terminal is added', () => {
    const state = factory();
    for (const [gx, gy] of [[36,28],[37,28],[37,29],[36,29]]) addMachine(state, 'belt', gx, gy, 0);
    state.capsules.push({ id: 1000, gx: 36, gy: 28, dir: 0, from: 2, progress: 0, units: 8, material: 'raw' });
    tick(state, 10);
    expect(state.capsules).toHaveLength(1);
    expect(heldMaterial(state)).toBe(8);
    for (const [gx, gy] of [[36,27],[36,26],[36,25],[36,24],[35,24],[34,24],[33,24]]) addMachine(state, 'belt', gx, gy, 0);
    tick(state, 30);
    expect(state.stats.delivered).toBe(8);
    expect(state.credits).toBe(8);
    expect(heldMaterial(state)).toBe(0);
  });

  it('finds typed multi-turn receiver routes through a cycle without depending on arrow directions', () => {
    const state = factory();
    const receiver = addMachine(state, 'receiver', 35, 27, 1);
    for (const [gx, gy] of [[35,26],[36,26],[36,25],[35,25],[34,25]]) addMachine(state, 'belt', gx, gy, 1);
    addMachine(state, 'analyzer', 33, 25, 1);
    addMachine(state, 'tester', 32, 25, 1);
    expect(engine.receiverHasRoute(state, receiver)).toBe(true);
    const tester = state.buildings.find(building => building.kind === 'tester')!;
    tester.kind = 'analyzer';
    expect(engine.receiverHasRoute(state, receiver)).toBe(false);
  });

  it('draws compatible physical connections for a ghost even when buffers are currently full', () => {
    const state = factory();
    addMachine(state, 'receiver', 36, 27);
    const tester = addMachine(state, 'tester', 37, 28); tester.buffer = 32;
    addMachine(state, 'analyzer', 36, 29);
    addMachine(state, 'belt', 35, 28);
    const ghost: Building = { id: -1, kind: 'analyzer', gx: 36, gy: 28, dir: 2, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0 };
    expect(engine.getBuildingConnections(state, ghost).sort()).toEqual([0, 2, 3]);
    expect(state.buildings.some(building => building.id === -1)).toBe(false);
  });

  it('continues the same branch schedule after serializing an in-progress capsule', () => {
    const state = factory();
    const receiver = addMachine(state, 'receiver', 36, 28, 0); receiver.buffer = 32;
    addMachine(state, 'belt', 37, 28);
    addMachine(state, 'belt', 36, 27);
    tick(state, 0.9);
    const restored: GameState = JSON.parse(JSON.stringify(state));
    tick(state, 2);
    tick(restored, 2);
    expect(restored.buildings).toEqual(state.buildings);
    expect(restored.capsules).toEqual(state.capsules);
    expect(heldMaterial(restored)).toBe(32);
  });

  it('drains multiple raw batches through a shared processor input/output belt without head-on deadlock', () => {
    const state = factory();
    const receiver = addMachine(state, 'receiver', 34, 24, 2); receiver.buffer = 40;
    addMachine(state, 'belt', 33, 24, 1);
    addMachine(state, 'belt', 33, 25, 1);
    addMachine(state, 'analyzer', 33, 26, 3);
    // The junction may sell raw directly; batches it sends south cannot bounce
    // back into their entry side and must exchange ports with finished reports.
    for (let i = 0; i < 400; i++) {
      updateGame(state, 0.1, idle);
      expect(heldMaterial(state) + state.stats.delivered).toBe(40);
      expect(new Set(state.capsules.map(capsule => `${capsule.gx},${capsule.gy}`)).size).toBe(state.capsules.length);
    }
    expect(state.stats.delivered).toBe(40);
    expect(state.stats.reportsSold).toBeGreaterThan(0);
    expect(state.credits).toBe(state.stats.rawSold + state.stats.reportsSold * 3);
    expect(heldMaterial(state)).toBe(0);
  });

  it('keeps finished reports out of an input dead end when a bent consumer route exists', () => {
    const state = factory();
    addMachine(state, 'receiver', 29, 28, 0).buffer = 128;
    for (const [gx, gy] of [[30,28],[31,28],[31,27],[32,26],[32,25]]) addMachine(state, 'belt', gx, gy, 0);
    addMachine(state, 'analyzer', 32, 27, 0);
    for (let i = 0; i < 2000; i++) {
      updateGame(state, 0.1, idle);
      expect(heldMaterial(state) + state.stats.delivered).toBe(128);
    }
    expect(state.stats.reportsSold).toBe(128);
    expect(state.stats.rawSold).toBe(0);
    expect(heldMaterial(state)).toBe(0);
  });

  it('waits for a blocked consumer branch without spilling into an empty dead end or advancing its cursor', () => {
    const state = factory();
    const source = addMachine(state, 'analyzer', 36, 28, 3); source.outputBuffer = 32;
    addMachine(state, 'belt', 35, 28);
    addMachine(state, 'belt', 36, 27);
    const tester = addMachine(state, 'tester', 36, 26, 3);
    tester.buffer = 32; tester.processing = { units: 8, remaining: 4 }; // Saved work from the previous recipe.
    for (const [gx, gy] of [[36,25],[36,24],[35,24],[34,24],[33,24]]) addMachine(state, 'belt', gx, gy, 0);
    tick(state, 3);
    expect(state.capsules.some(capsule => capsule.gx === 35 && capsule.gy === 28)).toBe(false);
    expect(source.outputCursor).toBe(0);
    expect(heldMaterial(state) + state.stats.delivered).toBe(72);
    tick(state, 25);
    expect(state.stats.testsSold).toBe(72);
    expect(heldMaterial(state)).toBe(0);
  });
});

describe('recoverable factory demolition', () => {
  it('initializes an empty typed recovery warehouse', () => {
    expect(createGame(42).recovered).toEqual({ raw: 0, report: 0, test: 0 });
  });

  it('removes a loaded receiver, refunds only construction, and pays recovered raw only at the base once', () => {
    const state = factory();
    state.player.x = 720;
    state.player.y = 720;
    const receiver = addMachine(state, 'receiver', 33, 27); receiver.buffer = 7;
    state.capsules.push({ id: 1000, gx: 33, gy: 27, dir: 0, progress: 0.3, units: 3, material: 'raw' });
    expect(removeBuilding(state, 33, 27).ok).toBe(true);
    expect(state.credits).toBe(50);
    expect(state.earned).toBe(0);
    expect(state.recovered).toEqual({ raw: 10, report: 0, test: 0 });
    expect(state.capsules).toHaveLength(0);
    expect(heldMaterial(state)).toBe(10);
    expect(engine.sellRecovered(state).ok).toBe(false);
    expect(state.recovered.raw).toBe(10);
    state.player.x = 780;
    state.player.y = 588;
    expect(getContextAction(state)).toContain('10');
    expect(interact(state).ok).toBe(true);
    expect(state.credits).toBe(60);
    expect(state.stats.rawSold).toBe(10);
    expect(state.stats.delivered).toBe(10);
    expect(state.recovered).toEqual({ raw: 0, report: 0, test: 0 });
    expect(engine.sellRecovered(state).ok).toBe(false);
    expect(interact(state).ok).toBe(false);
    expect(state.credits).toBe(60);
  });

  it('preserves each processor input, unfinished job, typed output and capsule on demolition', () => {
    const state = factory();
    const analyzer = addMachine(state, 'analyzer', 33, 27);
    analyzer.buffer = 5; analyzer.processing = { units: 3, remaining: 0.3 }; analyzer.outputBuffer = 7;
    const tester = addMachine(state, 'tester', 34, 27);
    tester.buffer = 4; tester.processing = { units: 6, remaining: 0.7 }; tester.outputBuffer = 8;
    state.capsules.push({ id: 1000, gx: 33, gy: 27, dir: 0, progress: 0.2, units: 2, material: 'report' });
    state.capsules.push({ id: 1001, gx: 34, gy: 27, dir: 0, progress: 0.2, units: 3, material: 'test' });
    expect(heldMaterial(state)).toBe(38);
    expect(removeBuilding(state, 33, 27).ok).toBe(true);
    expect(removeBuilding(state, 34, 27).ok).toBe(true);
    expect(state.recovered).toEqual({ raw: 8, report: 19, test: 11 });
    expect(heldMaterial(state)).toBe(38);
    expect(state.credits).toBe(2100);
    expect(state.stats.delivered).toBe(0);
    state.player.x = 780; state.player.y = 588; state.player.bag = 4;
    expect(interact(state).ok).toBe(true);
    expect(state.credits).toBe(2246);
    expect(state.stats.rawSold).toBe(12);
    expect(state.stats.reportsSold).toBe(19);
    expect(state.stats.testsSold).toBe(11);
    expect(state.stats.delivered).toBe(42);
    expect(heldMaterial(state)).toBe(0);
  });

  it('allows legacy starter demolition without issuing a free construction refund', () => {
    const state = clearWorld();
    state.buildings[0].buffer = 20;
    state.credits = 7;
    expect(removeBuilding(state, 28, 24).ok).toBe(true);
    expect(state.credits).toBe(7);
    expect(state.recovered.raw).toBe(20);
    expect(removeBuilding(state, 32, 24).ok).toBe(false);
    expect(state.credits).toBe(7);
  });

  it('keeps reach and fixed-terminal protections without altering warehouse stock', () => {
    const state = factory();
    addMachine(state, 'receiver', 2, 2).buffer = 12;
    const before = JSON.stringify(state);
    expect(removeBuilding(state, 2, 2).ok).toBe(false);
    expect(removeBuilding(state, 32, 24).ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('cleaning and economy', () => {
  it('removes individual dust layers only while cleaning and transfers each into the bag', () => {
    const state = clearWorld();
    const index = pile(state, state.player.x + 20, state.player.y, 3);
    updateGame(state, 0.1, idle);
    expect(state.dust[index]).toBe(3);
    updateGame(state, 0.1, { ...idle, clean: true, aimX: state.player.x + 100, aimY: state.player.y });
    expect(state.dust[index]).toBe(2);
    expect(state.player.bag).toBe(1);
    expect(state.cleaned).toBe(1);
  });

  it('stops at bag capacity without consuming or losing dust', () => {
    const state = clearWorld();
    state.player.bag = 119;
    const index = pile(state, state.player.x + 20, state.player.y, 3);
    for (let i = 0; i < 20; i++) updateGame(state, 0.1, { ...idle, clean: true, aimX: state.player.x + 100, aimY: state.player.y });
    expect(state.player.bag).toBe(120);
    expect(state.dust[index]).toBe(2);
    expect(state.cleaned).toBe(1);
  });

  it('deposits into the nearest receiver and pays every unit through the starter conveyor', () => {
    const state = clearWorld();
    state.player.x = 684;
    state.player.y = 618;
    state.player.bag = 19;
    expect(getContextAction(state)).toContain('19');
    expect(interact(state).ok).toBe(true);
    expect(state.player.bag).toBe(0);
    expect(state.credits).toBe(0);
    tick(state, 12);
    expect(state.credits).toBe(19);
    expect(state.stats.delivered).toBe(19);
    expect(state.capsules).toHaveLength(0);
    expect(state.buildings[0].buffer).toBe(0);
  });

  it('supports direct terminal sales but rejects interactions outside reach', () => {
    const state = clearWorld();
    state.player.x = 790;
    state.player.y = 620;
    state.player.bag = 11;
    expect(interact(state).ok).toBe(true);
    expect(state.credits).toBe(11);
    state.player.x = 100;
    state.player.y = 100;
    state.player.bag = 5;
    expect(interact(state).ok).toBe(false);
    expect(state.player.bag).toBe(5);
  });

  it('retains capsules under backpressure and resumes payment when a route is restored', () => {
    const state = clearWorld();
    state.buildings = state.buildings.filter(building => building.gx !== 30);
    state.buildings[0].buffer = 27;
    tick(state, 20);
    expect(state.credits).toBe(0);
    const conserved = state.capsules.reduce((sum, c) => sum + c.units, 0) + state.buildings.reduce((sum, b) => sum + b.buffer, 0);
    expect(conserved).toBe(27);
    expect(new Set(state.capsules.map(c => `${c.gx},${c.gy}`)).size).toBe(state.capsules.length);
    addMachine(state, 'belt', 30, 24, 1);
    tick(state, 15);
    expect(state.credits).toBe(27);
  });

  it('does not grant unaffordable or duplicate purchases and makes purchased tools usable', () => {
    const state = clearWorld();
    expect(buyUpgrade(state, 'handbrush').ok).toBe(false);
    expect(equipTool(state, 'broom').ok).toBe(false);
    state.credits = 500;
    expect(buyUpgrade(state, 'handbrush').ok).toBe(true);
    expect(state.credits).toBe(100);
    expect(state.player.tool).toBe('handbrush');
    expect(buyUpgrade(state, 'handbrush').ok).toBe(false);
    expect(equipTool(state, 'toothbrush').ok).toBe(true);
  });

  it('adds half the brush base per container upgrade and bounds repeatable upgrades', () => {
    const state = clearWorld();
    state.credits = 10000;
    state.ownedTools.push('handbrush', 'broom', 'widebrush');
    expect(buyUpgrade(state, 'capacity').ok).toBe(true);
    expect(getCapacity(state)).toBe(1500);
    expect(buyUpgrade(state, 'capacity').ok).toBe(true);
    expect(getCapacity(state)).toBe(2000);
    expect(buyUpgrade(state, 'capacity').ok).toBe(true);
    expect(getCapacity(state)).toBe(2500);
    expect(buyUpgrade(state, 'capacity').ok).toBe(false);
    expect(buyUpgrade(state, 'speed').ok).toBe(true);
    expect(getSpeed(state)).toBeGreaterThan(110);
    expect(buyUpgrade(state, 'speed').ok).toBe(true);
    expect(buyUpgrade(state, 'speed').ok).toBe(false);
  });

  it('keeps an overloaded driver in the vehicle until cargo is safely delivered', () => {
    const state = clearWorld();
    expect(toggleVehicle(state).ok).toBe(false);
    qualifyVehicle(state);
    expect(buyUpgrade(state, 'vehicle').ok).toBe(true);
    state.player.x = state.vehicles[0].x; state.player.y = state.vehicles[0].y;
    expect(toggleVehicle(state).ok).toBe(true);
    expect(state.player.riding).toBe(true);
    expect(getCapacity(state)).toBe(VEHICLES.vehicle.capacity * 2);
    expect(getSpeed(state)).toBe(VEHICLES.vehicle.speed);
    state.player.bag = 2500;
    const blockedExit = toggleVehicle(state);
    expect(blockedExit.ok).toBe(false);
    expect(blockedExit.message).toContain('Сначала сдай');
    expect(blockedExit.message).toContain('на станции');
    expect(state.player.bag).toBe(2500);
    expect(state.player.riding).toBe(true);
    state.player.x = 790;
    state.player.y = 620;
    expect(interact(state).ok).toBe(true);
    expect(state.credits).toBe(2500);
    expect(toggleVehicle(state).ok).toBe(true);
    expect(state.player.riding).toBe(false);
    expect(state.player.bag).toBe(0);
    expect(getCapacity(state)).toBe(2000);
  });

  it('rejects remote vehicle purchase and explains garage parking after local purchase', () => {
    const state = clearWorld();
    state.player.x = 100;
    state.player.y = 100;
    qualifyVehicle(state);
    expect(engine.buyUpgrade(state, 'vehicle').ok).toBe(false);
    const purchase = buyUpgrade(state, 'vehicle');
    expect(purchase.ok).toBe(true);
    expect(purchase.message).toContain('ждёт у базы');
    expect(state.vehicles[0].kind).toBe('vehicle');
    expect(toggleVehicle(state).ok).toBe(false);
    state.player.x = state.vehicles[0].x;
    state.player.y = state.vehicles[0].y;
    expect(toggleVehicle(state).ok).toBe(true);
  });
});

describe('construction and automation', () => {
  it.each([
    ['occupied machine', 'Анализатор', (state: GameState) => { addMachine(state, 'analyzer', 34, 27); }],
    ['out of reach', 'Подойди ближе', (state: GameState) => { state.player.x = 100; state.player.y = 100; }],
    ['obstacle', 'препятствие', (state: GameState) => { state.obstacles.push({ x: 816, y: 648, w: 24, h: 24, kind: 'rock' }); }],
    ['insufficient credits', 'ещё 1 кр.', (state: GameState) => { state.credits = 9; }],
  ] as const)('explains why a conveyor cannot be placed: %s', (_name, reason, prepare) => {
    const state = freshWorld(); state.credits = 1000;
    prepare(state);
    const snapshot = JSON.stringify(state);
    const response = placeBuilding(state, 'belt', 34, 27, 0);
    expect(response.ok).toBe(false);
    expect(response.message).toContain(reason);
    expect(canPlaceBuilding(state, 'belt', 34, 27)).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('validates construction reach, occupancy, terrain and price before charging', () => {
    const state = clearWorld();
    state.credits = 10;
    expect(placeBuilding(state, 'belt', 2, 2, 0).ok).toBe(false);
    expect(state.credits).toBe(10);
    expect(canPlaceBuilding(state, 'belt', 32, 24)).toBe(false);
    state.obstacles.push({ x: 816, y: 648, w: 24, h: 24, kind: 'rock' });
    expect(canPlaceBuilding(state, 'belt', 34, 27)).toBe(false);
    expect(placeBuilding(state, 'belt', 33, 27, 1).ok).toBe(true);
    expect(state.credits).toBe(0);
    expect(state.buildings.at(-1)?.dir).toBe(1);
    expect(removeBuilding(state, 32, 24).ok).toBe(false);
  });

  it('preserves buffered and in-transit material when a paid receiver is removed', () => {
    const state = clearWorld();
    state.credits = 250;
    expect(placeBuilding(state, 'receiver', 33, 27, 0).ok).toBe(true);
    const machine = state.buildings.at(-1)!;
    machine.buffer = 3;
    state.capsules.push({ id: 999, gx: 33, gy: 27, dir: 0, progress: 0.2, units: 7, material: 'raw' });
    expect(removeBuilding(state, 33, 27).ok).toBe(true);
    expect(state.recovered.raw).toBe(10);
    expect(state.capsules).toHaveLength(0);
    expect(state.credits).toBe(200);
    expect(state.earned).toBe(0);
  });

  it('rescues a loaded edge receiver automatically when a new neighboring line is extended', () => {
    const state = clearWorld();
    state.player.x = 1500;
    state.player.y = 1090;
    state.credits = 500;
    expect(placeBuilding(state, 'receiver', 63, 46, 0).ok).toBe(true);
    const receiver = state.buildings.at(-1)!;
    receiver.buffer = 10;
    tick(state, 5);
    expect(state.capsules).toHaveLength(1);
    expect(state.capsules[0].units + receiver.buffer).toBe(10);
    expect(placeBuilding(state, 'belt', 62, 46, 0).ok).toBe(true);
    expect(placeBuilding(state, 'belt', 61, 46, 0).ok).toBe(true);
    const creditsBeforeDelivery = state.credits;
    tick(state, 8);
    expect(state.credits).toBe(creditsBeforeDelivery);
    expect(state.stats.delivered).toBe(0);
    expect(heldMaterial(state)).toBe(10);
    expect(state.capsules.some(capsule => capsule.gx === 61 && capsule.gy === 46)).toBe(true);
    expect(receiver.buffer).toBe(0);
  });

  it('resets an occupied conveyor turn without copying or losing capsule contents', () => {
    const state = clearWorld();
    state.credits = 10;
    expect(placeBuilding(state, 'belt', 33, 27, 0).ok).toBe(true);
    state.capsules.push({ id: 999, gx: 33, gy: 27, dir: 0, progress: 0.7, units: 7, material: 'report' });
    expect(rotateBuilding(state, 33, 27).ok).toBe(true);
    expect(state.capsules).toEqual([{ id: 999, gx: 33, gy: 27, dir: 1, progress: 0, units: 7, material: 'report' }]);
    expect(state.credits).toBe(0);
  });

  it('rejects rotation of starter structures and structures outside construction reach', () => {
    const state = clearWorld();
    expect(rotateBuilding(state, 32, 24).ok).toBe(false);
    expect(state.buildings.find(building => building.gx === 32)!.dir).toBe(0);
    expect(rotateBuilding(state, 33, 27).ok).toBe(false);
    state.credits = 10;
    expect(placeBuilding(state, 'belt', 33, 27, 0).ok).toBe(true);
    state.player.x = 100;
    state.player.y = 100;
    expect(rotateBuilding(state, 33, 27).ok).toBe(false);
    expect(state.buildings.at(-1)!.dir).toBe(0);
  });

  it('purchases an autonomous robot that routes around an obstacle and delivers collected layers', () => {
    const state = clearWorld();
    qualifyRobot(state);
    state.obstacles.push({ x: 660, y: 660, w: 200, h: 36, kind: 'server' });
    for (let y = 720; y <= 768; y += 12) for (let x = 720; x <= 792; x += 12) pile(state, x, y, 3);
    expect(buyUpgrade(state, 'robot').ok).toBe(true);
    tick(state, 110);
    expect(state.stats.robotCleaned).toBeGreaterThan(0);
    expect(state.stats.delivered).toBeGreaterThan(0);
    expect(state.credits).toBeGreaterThan(0);
  });

  it('routes a robot purchased beside scenery even when its containing grid center is blocked', () => {
    const state = clearWorld();
    state.player.x = 97;
    state.player.y = 100;
    state.obstacles = [{ x: 105, y: 50, w: 40, h: 160, kind: 'server' }];
    pile(state, 66, 306, 3);
    connectedRemote(state, 2, 12);
    qualifyRobot(state);
    buyUpgrade(state, 'robot');
    tick(state, 10);
    expect(state.stats.robotCleaned).toBe(3);
  });

  it('sends robot cargo to receivers even when a sale terminal is closer to its route', () => {
    const state = clearWorld();
    qualifyRobot(state);
    buyUpgrade(state, 'robot');
    // A typed connected line may temporarily back up at an occupied processor.
    const processor = state.buildings.find(building => building.gx === 29)!;
    processor.kind = 'analyzer';
    processor.buffer = 32;
    processor.processing = { units: 8, remaining: 10 };
    state.robots[0].x = 780;
    state.robots[0].y = 588;
    state.robots[0].bag = 12;
    state.robots[0].mode = 'returning';
    tick(state, 2);
    expect(state.credits).toBe(0);
    expect(state.robots[0].bag).toBe(0);
    expect(heldMaterial(state)).toBe(52);
  });

  it('collects a useful load after a long journey before starting its return trip', () => {
    const state = clearWorld();
    state.player.x = 100;
    state.player.y = 100;
    qualifyRobot(state);
    for (let gy = 7; gy < 12; gy++) for (let gx = 90; gx < 95; gx++) state.dust[gy * GRID_W + gx] = 3;
    connectedRemote(state, 45, 4);
    buyUpgrade(state, 'robot');
    for (let frames = 0; frames < 500 && state.robots[0].bag === 0; frames++) updateGame(state, 0.1, idle);
    expect(state.time).toBeGreaterThan(8);
    tick(state, 1.5);
    expect(state.robots[0].mode).toBe('cleaning');
    expect(state.robots[0].bag).toBeGreaterThanOrEqual(30);
  });

  it('continues after JSON persistence with finite state and bounded particle events', () => {
    const state = clearWorld();
    state.player.bag = 8;
    state.player.x = 684;
    state.player.y = 618;
    interact(state);
    tick(state, 1);
    const restored: GameState = JSON.parse(JSON.stringify(state));
    tick(restored, 30);
    expect(restored.credits).toBe(8);
    expect(Number.isFinite(restored.player.x)).toBe(true);
    expect(restored.events.length).toBeLessThan(100);
    expect(restored.events.every(event => restored.time - event.time < 4)).toBe(true);
  });
});

describe('processing factory economy', () => {
  it.each([
    { stages: 0, credits: 8, raw: 8, reports: 0, tests: 0 },
    { stages: 1, credits: 24, raw: 0, reports: 8, tests: 0 },
    { stages: 2, credits: 56, raw: 0, reports: 0, tests: 8 },
  ])('sells the same eight units for $credits credits after $stages processing stages', ({ stages, credits, raw, reports, tests }) => {
    const state = factory();
    if (stages === 2) addMachine(state, 'tester', 32, 25);
    if (stages > 0) addMachine(state, 'analyzer', 32, 25 + (stages === 2 ? 1 : 0));
    addMachine(state, 'receiver', 32, 25 + stages).buffer = 8;
    tick(state, 20);
    expect(state.credits).toBe(credits);
    expect(state.stats.delivered).toBe(8);
    expect(state.stats.rawSold).toBe(raw);
    expect(state.stats.reportsSold).toBe(reports);
    expect(state.stats.testsSold).toBe(tests);
    expect(heldMaterial(state)).toBe(0);
  });

  it('reserves raw input into timed work and pays only after the finished product reaches the terminal', () => {
    const state = factory();
    addMachine(state, 'receiver', 32, 27).buffer = 8;
    const analyzer = addMachine(state, 'analyzer', 32, 26);
    const tester = addMachine(state, 'tester', 32, 25);
    for (let steps = 0; steps < 100 && !analyzer.processing; steps++) updateGame(state, 0.1, idle);
    expect(state.credits).toBe(0);
    expect(analyzer.processing?.units).toBe(8);
    expect(analyzer.buffer).toBe(0);
    expect(heldMaterial(state)).toBe(8);
    for (let steps = 0; steps < 100 && !tester.processing; steps++) updateGame(state, 0.1, idle);
    expect(tester.processing?.units).toBe(8);
    expect(state.stats.processed).toBe(8);
    expect(state.stats.delivered).toBe(0);
    expect(state.credits).toBe(0);
    tick(state, 12);
    expect(state.stats.tested).toBe(8);
    expect(state.credits).toBe(56);
  });

  it('cannot hand-deliver raw bags into processors or build extra sale terminals', () => {
    const state = factory();
    state.player.x = 492;
    state.player.y = 492;
    const analyzer = addMachine(state, 'analyzer', 20, 20);
    state.player.bag = 8;
    expect(interact(state).ok).toBe(false);
    expect(state.player.bag).toBe(8);
    expect(analyzer.buffer).toBe(0);
    expect(state.credits).toBe(0);
    // Persisted/scripted input must not bypass the buildable-kind boundary.
    state.credits = 1000;
    expect(placeBuilding(state, 'uplink' as BuildKind, 20, 21, 0).ok).toBe(false);
    expect(state.buildings.filter(building => building.kind === 'uplink')).toHaveLength(1);
    expect(state.credits).toBe(1000);
  });

  it('makes parallel processors sell queued work faster without changing eventual total value', () => {
    const serial = factory();
    addMachine(serial, 'analyzer', 31, 24, 0).buffer = 32;
    const parallel = factory();
    addMachine(parallel, 'analyzer', 31, 24, 0).buffer = 16;
    addMachine(parallel, 'analyzer', 32, 25, 3).buffer = 16;
    tick(serial, PROCESSING.analyzer.cycle + LOGISTICS.hopDuration + 0.1);
    tick(parallel, PROCESSING.analyzer.cycle + LOGISTICS.hopDuration + 0.1);
    expect(serial.credits).toBe(24);
    expect(parallel.credits).toBe(48);
    expect(heldMaterial(serial) + serial.stats.delivered).toBe(32);
    expect(heldMaterial(parallel) + parallel.stats.delivered).toBe(32);
    tick(serial, 20);
    tick(parallel, 20);
    expect(serial.credits).toBe(96);
    expect(parallel.credits).toBe(96);
  });

  it('partially unloads into finite receiver space and retains the rest in the player bag', () => {
    const state = clearWorld();
    state.player.x = 684;
    state.player.y = 618;
    state.player.bag = 10;
    state.buildings[0].buffer = RECEIVER_CAPACITY - 3;
    const delivery = interact(state);
    expect(delivery.ok).toBe(true);
    expect(delivery.message).toContain('7');
    expect(state.buildings[0].buffer).toBe(RECEIVER_CAPACITY);
    expect(state.player.bag).toBe(7);
    expect(interact(state).ok).toBe(false);
    expect(heldMaterial(state)).toBe(RECEIVER_CAPACITY + 7);
  });

  it('waits at a full processor input instead of overflowing it or consuming the capsule', () => {
    const state = factory();
    const analyzer = addMachine(state, 'analyzer', 32, 25);
    analyzer.buffer = 32;
    analyzer.processing = { units: 8, remaining: PROCESSING.analyzer.cycle };
    addMachine(state, 'belt', 32, 26);
    state.capsules.push({ id: 1000, gx: 32, gy: 26, dir: 3, progress: 0, units: 8, material: 'raw' });
    tick(state, PROCESSING.analyzer.cycle / 2);
    expect(analyzer.buffer).toBe(32);
    expect(state.capsules).toHaveLength(1);
    expect(state.capsules[0].gx).toBe(32);
    expect(state.capsules[0].gy).toBe(26);
    expect(heldMaterial(state)).toBe(48);
    expect(state.credits).toBe(0);
  });

  it.each(['report', 'test'] as const)('rejects $0 capsules at an analyzer so output cannot be boosted repeatedly', material => {
    const state = factory();
    const analyzer = addMachine(state, 'analyzer', 32, 25);
    addMachine(state, 'belt', 32, 26);
    state.capsules.push({ id: 1000, gx: 32, gy: 26, dir: 3, progress: 0, units: 8, material });
    tick(state, 20);
    expect(analyzer.buffer).toBe(0);
    expect(analyzer.processing).toBeNull();
    expect(state.capsules).toHaveLength(1);
    expect(state.capsules[0].material).toBe(material);
    expect(state.capsules[0].gy).toBe(26);
    expect(state.stats.processed).toBe(0);
    expect(state.credits).toBe(0);
    expect(heldMaterial(state)).toBe(8);
  });

  it('backs up finite processor output and stops starting work until space is available', () => {
    const state = factory();
    const analyzer = addMachine(state, 'analyzer', 36, 28, 0);
    analyzer.buffer = 32;
    tick(state, 20);
    expect(state.credits).toBe(0);
    expect(heldMaterial(state)).toBe(32);
    analyzer.buffer = 32;
    tick(state, 20);
    expect(analyzer.outputBuffer).toBe(32);
    expect(analyzer.processing).toBeNull();
    expect(analyzer.buffer).toBe(0);
    expect(state.capsules).toHaveLength(1);
    expect(state.capsules[0].material).toBe('report');
    expect(state.capsules[0].units).toBe(32);
    expect(heldMaterial(state)).toBe(64);
    analyzer.buffer = 8;
    tick(state, 20);
    expect(analyzer.buffer).toBe(8);
    expect(analyzer.processing).toBeNull();
    expect(heldMaterial(state)).toBe(72);
  });

  it('preserves processing jobs and typed products when a blocked output is rotated to the terminal', () => {
    const state = factory();
    const analyzer = addMachine(state, 'analyzer', 32, 25, 0);
    analyzer.buffer = 32;
    for (let steps = 0; steps < 100 && !state.capsules.length; steps++) updateGame(state, 0.1, idle);
    expect(analyzer.processing).not.toBeNull();
    const job = { ...analyzer.processing! };
    const capsuleId = state.capsules[0].id;
    for (let i = 0; i < 3; i++) expect(rotateBuilding(state, 32, 25).ok).toBe(true);
    expect(analyzer.processing).toEqual(job);
    expect(state.capsules[0].id).toBe(capsuleId);
    expect(state.capsules[0].material).toBe('report');
    expect(state.capsules[0].dir).toBe(3);
    expect(heldMaterial(state)).toBe(32);
    tick(state, 20);
    expect(state.credits).toBe(96);
    expect(state.stats.processed).toBe(32);
    expect(heldMaterial(state)).toBe(0);
  });

  it('recovers unfinished and completed processor material instead of blocking demolition', () => {
    const state = clearWorld();
    const analyzer = addMachine(state, 'analyzer', 33, 27);
    analyzer.outputBuffer = 8;
    analyzer.processing = { units: 8, remaining: PROCESSING.analyzer.cycle };
    expect(removeBuilding(state, 33, 27).ok).toBe(true);
    expect(state.recovered).toEqual({ raw: 8, report: 8, test: 0 });
    expect(heldMaterial(state)).toBe(16);
    expect(removeBuilding(state, 33, 27).ok).toBe(false);
  });

  it('makes a loaded robot wait while every receiver is full rather than selling at a nearby terminal', () => {
    const state = clearWorld();
    qualifyRobot(state);
    buyUpgrade(state, 'robot');
    const receiver = state.buildings[0];
    receiver.buffer = RECEIVER_CAPACITY;
    const analyzer = state.buildings.find(building => building.gx === 29)!;
    analyzer.kind = 'analyzer'; analyzer.buffer = 32;
    analyzer.processing = { units: 8, remaining: 2.4 }; // Valid legacy work can outlast the new recipe.
    state.capsules.push({ id: 1000, gx: 28, gy: 24, dir: 1, progress: 0, units: 8, material: 'raw' });
    state.robots[0].x = 780;
    state.robots[0].y = 588;
    state.robots[0].bag = 12;
    state.robots[0].mode = 'returning';
    tick(state, 1.5);
    expect(state.robots[0].bag).toBe(12);
    expect(receiver.buffer).toBe(RECEIVER_CAPACITY);
    expect(state.credits).toBe(0);
    expect(heldMaterial(state)).toBe(RECEIVER_CAPACITY + 60);
    tick(state, 300);
    expect(state.robots[0].bag).toBe(0);
    expect(state.stats.delivered).toBe(RECEIVER_CAPACITY + 60);
    expect(state.credits).toBe((RECEIVER_CAPACITY + 60) * 3);
  });

  it('routes robot cargo to an available remote receiver when its nearest receiver is full', () => {
    const state = clearWorld();
    qualifyRobot(state);
    buyUpgrade(state, 'robot');
    state.buildings[0].buffer = RECEIVER_CAPACITY;
    const analyzer = state.buildings.find(building => building.gx === 29)!;
    analyzer.kind = 'analyzer'; analyzer.buffer = 32;
    analyzer.processing = { units: 8, remaining: 2.4 };
    state.capsules.push({ id: 1000, gx: 28, gy: 24, dir: 1, progress: 0, units: 8, material: 'raw' });
    const remote = addMachine(state, 'receiver', 30, 28, 0);
    addMachine(state, 'belt', 31, 28, 3);
    addMachine(state, 'belt', 31, 27, 3);
    addMachine(state, 'belt', 31, 26, 3);
    addMachine(state, 'belt', 31, 25, 3);
    state.robots[0].x = 684;
    state.robots[0].y = 618;
    state.robots[0].bag = 12;
    state.robots[0].mode = 'returning';
    tick(state, 2);
    expect(state.robots[0].bag).toBe(0);
    expect(remote.buffer + state.capsules.filter(capsule => capsule.gx !== 28).reduce((sum, capsule) => sum + capsule.units, 0)).toBe(12);
    expect(state.credits).toBe(0);
    expect(heldMaterial(state)).toBe(RECEIVER_CAPACITY + 60);
  });
});

describe('progression requirements', () => {
  it('cannot buy a skipped brush tier with cash and explains the next required tool', () => {
    const state = clearWorld();
    state.credits = 50000;
    expect(buyUpgrade(state, 'broom').ok).toBe(false);
    expect(state.credits).toBe(50000);
    expect(engine.getUpgradeRequirement?.(state, 'broom')).toMatch(/Ручная щётка/);
    expect(engine.upgradePrice(state, 'broom')).toBe(1800);
    expect(buyUpgrade(state, 'handbrush').ok).toBe(true);
    expect(buyUpgrade(state, 'widebrush').ok).toBe(false);
    expect(buyUpgrade(state, 'broom').ok).toBe(true);
    expect(buyUpgrade(state, 'widebrush').ok).toBe(true);
    expect(state.credits).toBe(41800);
  });

  it('gates later container and speed levels while preserving legacy higher-tier ownership', () => {
    const state = clearWorld();
    state.credits = 50000;
    expect(buyUpgrade(state, 'capacity').ok).toBe(true);
    expect(state.credits).toBe(49700);
    expect(buyUpgrade(state, 'capacity').ok).toBe(false);
    expect(buyUpgrade(state, 'speed').ok).toBe(true);
    expect(buyUpgrade(state, 'speed').ok).toBe(false);
    // A v2 save may own a high brush without retaining every predecessor.
    state.ownedTools = ['toothbrush', 'widebrush'];
    expect(buyUpgrade(state, 'capacity').ok).toBe(true);
    expect(buyUpgrade(state, 'capacity').ok).toBe(true);
    expect(buyUpgrade(state, 'speed').ok).toBe(true);
    expect(getCapacity(state)).toBe(2500);
    expect(engine.getReceiverCapacity(state)).toBe(RECEIVER_CAPACITY * 8);
    expect(buyUpgrade(state, 'capacity').ok).toBe(false);
    expect(buyUpgrade(state, 'speed').ok).toBe(false);
    expect(equipTool(state, 'widebrush').ok).toBe(true);
  });

  it('unlocks processors from tool ownership and sold production rather than cash or work counters', () => {
    const state = clearWorld();
    state.credits = 50000;
    expect(canPlaceBuilding(state, 'analyzer', 33, 27)).toBe(false);
    expect(placeBuilding(state, 'analyzer', 33, 27, 0).ok).toBe(false);
    expect(state.credits).toBe(50000);
    expect(engine.getBuildRequirement?.(state, 'analyzer')).toMatch(/Ручная щётка/);
    state.ownedTools.push('broom');
    expect(placeBuilding(state, 'analyzer', 33, 27, 0).ok).toBe(true);
    state.stats.processed = 1000;
    state.stats.tested = 1000;
    state.stats.reportsSold = 47;
    state.stats.testsSold = 16;
    expect(placeBuilding(state, 'tester', 34, 27, 0).ok).toBe(false);
    expect(engine.getBuildRequirement?.(state, 'tester')).toMatch(/64/);
    state.stats.reportsSold = 48;
    expect(canPlaceBuilding(state, 'tester', 34, 27)).toBe(true);
    expect(placeBuilding(state, 'tester', 34, 27, 0).ok).toBe(true);
    expect(state.credits).toBe(45800);
  });

  it('requires the broom, second container and 128 sold tests for a heavy vehicle', () => {
    const state = clearWorld();
    state.credits = 50000;
    state.stats.testsSold = 128;
    state.player.capacityLevel = 2;
    expect(buyUpgrade(state, 'vehicle').ok).toBe(false);
    state.ownedTools.push('broom');
    state.player.capacityLevel = 1;
    expect(buyUpgrade(state, 'vehicle').ok).toBe(false);
    state.player.capacityLevel = 2;
    state.stats.testsSold = 127;
    expect(buyUpgrade(state, 'vehicle').ok).toBe(false);
    state.stats.testsSold = 128;
    expect(buyUpgrade(state, 'vehicle').ok).toBe(true);
    expect(state.credits).toBe(50000 - VEHICLES.vehicle.price);
    state.stats.testsSold = 0;
    expect(engine.getUpgradeRequirement?.(state, 'vehicle')).toBeNull();
    state.player.x = state.vehicles[0].x;
    state.player.y = state.vehicles[0].y;
    expect(toggleVehicle(state).ok).toBe(true);
  });

  it('requires a heavy vehicle and 256 sold tests for PRO without disabling owned robots after progress changes', () => {
    const state = clearWorld();
    state.credits = ROBOTS.industrialRobot.price + 40000;
    state.stats.testsSold = 256;
    expect(buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    state.vehicles = [{ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 700 }];
    state.stats.testsSold = 255;
    expect(buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    state.stats.testsSold = 256;
    expect(buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    expect(state.credits).toBe(40000);
    state.vehicles = [];
    state.stats.testsSold = 0;
    expect(engine.getUpgradeRequirement(state, 'industrialRobot')).not.toBeNull();
    pile(state, state.robots[0].x + 12, state.robots[0].y, 3);
    tick(state, 1);
    expect(state.stats.robotCleaned).toBe(3);
  });

  it('expands receiver storage for partial player deliveries alongside container upgrades', () => {
    const state = clearWorld();
    state.player.capacityLevel = 1;
    state.player.x = 684;
    state.player.y = 618;
    state.player.bag = 10;
    state.buildings[0].buffer = RECEIVER_CAPACITY * 2 - 3;
    expect(interact(state).ok).toBe(true);
    expect(state.buildings[0].buffer).toBe(RECEIVER_CAPACITY * 2);
    expect(state.player.bag).toBe(7);
    expect(engine.getReceiverCapacity(state)).toBe(RECEIVER_CAPACITY * 2);
    expect(engine.getBuildingStatus(state, state.buildings[0])).toContain(String(RECEIVER_CAPACITY * 2));
  });

  it('makes the heavy vehicle clean its front strip and retain cargo above walking capacity', () => {
    const state = clearWorld();
    state.vehicles = [{ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: state.player.x, y: state.player.y }];
    state.player.capacityLevel = 2;
    expect(toggleVehicle(state).ok).toBe(true);
    expect(getCapacity(state)).toBe(VEHICLES.vehicle.capacity * 2);
    expect(getSpeed(state)).toBe(VEHICLES.vehicle.speed);
    state.player.bag = 250;
    pile(state, state.player.x, state.player.y + VEHICLES.vehicle.reach, 100);
    updateGame(state, 0.1, { ...idle, clean: true });
    expect(state.player.bag).toBe(250 + VEHICLES.vehicle.rate * 0.1);
    expect(toggleVehicle(state).ok).toBe(false);
    updateGame(state, 0.1, { dx: 0, dy: -1, clean: false });
    expect(state.player.y).toBeCloseTo(645 + VEHICLES.vehicle.acceleration * 0.01);
  });
});

describe('connected delivery routes', () => {
  function carrying(state: GameState, x = 780, y = 650) {
    state.robots = [{ id: state.nextId++, kind: 'robot', x, y, bag: 12, capacity: 180, mode: 'returning', target: null, path: [], timer: 0, cleanAccumulator: 0 }];
  }

  it.each(['missing', 'cycle', 'wrong material'] as const)('ignores a closer receiver with a $0 route and uses the connected base line', reason => {
    const state = clearWorld();
    const disconnected = addMachine(state, 'receiver', 31, 27, 0);
    if (reason === 'cycle') {
      addMachine(state, 'belt', 32, 27, 1);
      addMachine(state, 'belt', 32, 28, 0);
      addMachine(state, 'belt', 33, 28, 3);
      addMachine(state, 'belt', 33, 27, 2);
    } else if (reason === 'wrong material') addMachine(state, 'tester', 32, 27, 3);

    carrying(state);
    tick(state, 8);
    expect(state.stats.delivered).toBe(12);
    expect(state.robots[0].bag).toBe(0);
    expect(disconnected.buffer).toBe(0);
    expect(engine.receiverHasRoute?.(state, disconnected)).toBe(false);
    expect(engine.receiverHasRoute?.(state, state.buildings[0])).toBe(true);
  });

  it('preserves cargo and reports a wait when no connected receiver exists', () => {
    const state = factory();
    carrying(state, 780, 588);
    tick(state, 20);
    expect(state.robots[0].bag).toBe(12);
    expect(state.credits).toBe(0);
    expect(engine.getRobotStatus(state)).toContain('ждут связанную линию');
    const disconnected = addMachine(state, 'receiver', 36, 28, 0);
    tick(state, 10);
    expect(state.robots[0].bag).toBe(12);
    expect(disconnected.buffer).toBe(0);
  });

  it('unloads into the receiver reached by its path when another connected receiver is diagonally adjacent', () => {
    const state = clearWorld();
    const base = state.buildings[0]; base.cooldown = 10;
    const closer = addMachine(state, 'receiver', 29, 25, 3); closer.cooldown = 10;
    carrying(state, 696, 630);
    tick(state, 1);
    expect(state.robots[0].bag).toBe(0);
    expect(closer.buffer).toBe(12);
    expect(base.buffer).toBe(0);
  });

  it('finds a reachable receiver by walking paths rather than choosing an enclosed nearer one', () => {
    const state = clearWorld();
    state.obstacles = [
      { x: 648, y: 552, w: 72, h: 12, kind: 'server' },
      { x: 648, y: 612, w: 72, h: 12, kind: 'server' },
      { x: 648, y: 552, w: 12, h: 72, kind: 'server' },
      { x: 708, y: 552, w: 12, h: 72, kind: 'server' },
    ];
    addMachine(state, 'receiver', 31, 27, 3);
    addMachine(state, 'belt', 31, 26, 3);
    addMachine(state, 'belt', 31, 25, 3);
    carrying(state, 684, 650);
    tick(state, 8);
    expect(state.stats.delivered).toBe(12);
    expect(state.buildings[0].buffer).toBe(0);
    expect(state.robots[0].bag).toBe(0);
  });

  it('accepts typed processing routes during temporary backpressure and uses enlarged receiver storage', () => {
    const state = factory();
    state.player.capacityLevel = 1;
    const receiver = addMachine(state, 'receiver', 32, 27, 3);
    receiver.buffer = RECEIVER_CAPACITY;
    const analyzer = addMachine(state, 'analyzer', 32, 26, 3);
    analyzer.buffer = 32;
    analyzer.outputBuffer = 32;
    const tester = addMachine(state, 'tester', 32, 25, 3);
    tester.buffer = 32;
    tester.outputBuffer = 32;
    carrying(state, 780, 660);
    tick(state, 0.1);
    expect(state.robots[0].bag).toBe(0);
    expect(heldMaterial(state) + state.stats.delivered).toBe(RECEIVER_CAPACITY + 140);
    expect(engine.receiverHasRoute?.(state, receiver)).toBe(true);
  });

  it('summarizes fleet delivery and cleaning activity', () => {
    const state = clearWorld();
    carrying(state, 100, 100);
    pile(state, 684, 600, 3);
    tick(state, 0.1);
    expect(engine.getRobotStatus(state)).toContain('доставка 1');
    state.robots[0].mode = 'cleaning';
    expect(engine.getRobotStatus(state)).toContain('убирают 1');
  });
});

describe('terminal raw recovery', () => {
  it('buys back only previously sold raw units at a loss while conserving the material budget', () => {
    const state = clearWorld();
    state.player.x = 780;
    state.player.y = 588;
    state.stats.rawSold = 20;
    state.credits = 100;
    expect(engine.reclaimBugs?.(state)?.ok).toBe(true);
    expect(state.player.bag).toBe(20);
    expect(state.stats.rawReclaimed).toBe(20);
    expect(state.credits).toBe(60);
    expect(heldMaterial(state) + state.stats.rawSold - state.stats.rawReclaimed).toBe(20);
    expect(interact(state).ok).toBe(true);
    expect(state.credits).toBe(80);
    expect(state.stats.rawSold).toBe(40);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(true);
    expect(state.credits).toBe(40);
    expect(heldMaterial(state) + state.stats.rawSold - state.stats.rawReclaimed).toBe(20);
    expect(state.stats.delivered).toBe(20);
  });

  it('limits recovery by the batch and remaining terminal stock', () => {
    const state = clearWorld();
    state.player.x = 780;
    state.player.y = 588;
    state.player.capacityLevel = 2;
    state.credits = 1000;
    state.stats.rawSold = 100;
    expect(engine.reclaimBugs?.(state)?.ok).toBe(true);
    expect(state.player.bag).toBe(64);
    expect(state.credits).toBe(872);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(true);
    expect(state.player.bag).toBe(100);
    expect(state.stats.rawReclaimed).toBe(100);
    expect(state.credits).toBe(800);
    const snapshot = JSON.stringify(state);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('partially recovers to available bag space and whole-unit purchasing power', () => {
    const state = clearWorld();
    state.player.x = 780;
    state.player.y = 588;
    state.stats.rawSold = 100;
    state.credits = 100;
    state.player.bag = 117;
    expect(engine.reclaimBugs?.(state)?.ok).toBe(true);
    expect(state.player.bag).toBe(120);
    expect(state.credits).toBe(94);
    expect(state.stats.rawReclaimed).toBe(3);
    const fullSnapshot = JSON.stringify(state);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(fullSnapshot);
    state.player.bag = 0;
    state.credits = 9;
    expect(engine.reclaimBugs?.(state)?.ok).toBe(true);
    expect(state.player.bag).toBe(4);
    expect(state.credits).toBe(1);
    const poorSnapshot = JSON.stringify(state);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(poorSnapshot);
  });

  it('rejects recovery away from the base or without raw stock without charging or creating units', () => {
    const state = clearWorld();
    state.stats.rawSold = 20;
    state.credits = 100;
    state.player.x = 100;
    state.player.y = 100;
    const remoteSnapshot = JSON.stringify(state);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(remoteSnapshot);
    state.player.x = 780;
    state.player.y = 588;
    state.stats.rawSold = 0;
    state.stats.reportsSold = 100;
    state.stats.testsSold = 100;
    const emptySnapshot = JSON.stringify(state);
    expect(engine.reclaimBugs?.(state)?.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(emptySnapshot);
  });
});

describe('longer gather cycles and player-built first production line', () => {
  it('starts with four protected sale terminals and no free production route', () => {
    const state = createGame(42);
    expect(state.buildings.map(b => [b.kind, b.id, b.gx, b.gy])).toEqual(TERMINALS.map((terminal, index) => ['uplink', index + 5, Math.floor(terminal.x / 24), Math.floor(terminal.y / 24)]));
    expect(state.buildings[0].starter).toBe(true);
    expect(state.nextId).toBe(9);
  });

  it('sells raw at one credit but earns three after buying and feeding the first real analysis line', () => {
    const raw = factory();
    raw.player.x = 780;
    raw.player.y = 620;
    raw.player.bag = 8;
    expect(interact(raw).ok).toBe(true);
    expect(raw.credits).toBe(8);
    expect(raw.stats.rawSold).toBe(8);

    const processed = factory();
    processed.credits = 1110;
    expect(buyUpgrade(processed, 'handbrush').ok).toBe(true);
    expect(canPlaceBuilding(processed, 'analyzer', 32, 26)).toBe(true);
    expect(placeBuilding(processed, 'receiver', 32, 27, 3).ok).toBe(true);
    expect(placeBuilding(processed, 'analyzer', 32, 26, 3).ok).toBe(true);
    expect(placeBuilding(processed, 'belt', 32, 25, 3).ok).toBe(true);
    expect(processed.credits).toBe(0);
    processed.player.x = 780;
    processed.player.y = 660;
    processed.player.bag = 8;
    expect(interact(processed).ok).toBe(true);
    tick(processed, 20);
    expect(processed.credits).toBe(24);
    expect(processed.stats.reportsSold).toBe(8);
    expect(processed.stats.rawSold).toBe(0);
    expect(processed.stats.built).toBe(3);
  });

  it('grows collection capacity with each purchased brush and retains it when an older tool is equipped', () => {
    const state = freshWorld();
    state.credits = 10000;
    expect(getCapacity(state)).toBe(120);
    expect(engine.getWalkingCapacity?.(state)).toBe(120);
    expect(buyUpgrade(state, 'handbrush').ok).toBe(true);
    expect(getCapacity(state)).toBe(300);
    state.player.bag = 299;
    expect(equipTool(state, 'toothbrush').ok).toBe(true);
    const index = pile(state, state.player.x + 20, state.player.y, 3);
    for (let n = 0; n < 5; n++) updateGame(state, 0.1, { ...idle, clean: true, aimX: state.player.x + 100, aimY: state.player.y });
    expect(state.player.bag).toBe(300);
    expect(state.dust[index]).toBe(2);
    expect(buyUpgrade(state, 'broom').ok).toBe(true);
    expect(getCapacity(state)).toBe(600);
    expect(buyUpgrade(state, 'widebrush').ok).toBe(true);
    expect(getCapacity(state)).toBe(1000);
    expect(equipTool(state, 'toothbrush').ok).toBe(true);
    expect(getCapacity(state)).toBe(1000);
  });

  it('adds half the brush base per container level while doubling receiver storage', () => {
    const state = freshWorld();
    state.ownedTools.push('handbrush');
    for (const [level, walking, receiver] of [[0, 300, RECEIVER_CAPACITY], [1, 450, RECEIVER_CAPACITY * 2], [2, 600, RECEIVER_CAPACITY * 4], [3, 750, RECEIVER_CAPACITY * 8]]) {
      state.player.capacityLevel = level;
      expect(getCapacity(state)).toBe(walking);
      expect(engine.getWalkingCapacity?.(state)).toBe(walking);
      expect(engine.getReceiverCapacity(state)).toBe(receiver);
    }
  });

  it('uses the same multiplier for the rover and checks its exit against owned brush capacity', () => {
    const state = freshWorld();
    state.ownedTools.push('widebrush');
    state.player.capacityLevel = 2;
    state.vehicles = [{ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: state.player.x, y: state.player.y }];
    expect(toggleVehicle(state).ok).toBe(true);
    expect(getCapacity(state)).toBe(VEHICLES.vehicle.capacity * 2);
    expect(engine.getWalkingCapacity?.(state)).toBe(2000);
    state.player.bag = 2001;
    expect(toggleVehicle(state).ok).toBe(false);
    expect(state.player.riding).toBe(true);
    state.player.bag = 2000;
    expect(toggleVehicle(state).ok).toBe(true);
    expect(state.player.bag).toBe(2000);
    expect(getCapacity(state)).toBe(2000);
  });
});

describe('responsive production throughput', () => {
  it('delivers the first report batch within two seconds of feeding a receiver', () => {
    const state = factory();
    addMachine(state, 'receiver', 32, 26).buffer = 8;
    addMachine(state, 'analyzer', 32, 25);
    tick(state, 2);
    expect(state.stats.reportsSold).toBe(8);
    expect(state.credits).toBe(24);
    expect(heldMaterial(state)).toBe(0);
  });

  it('drains queued analysis and tests promptly while conserving every unit at each step', () => {
    const state = factory();
    addMachine(state, 'receiver', 32, 27).buffer = 32;
    addMachine(state, 'analyzer', 32, 26);
    addMachine(state, 'tester', 32, 25);
    for (let step = 0; step < 60; step++) {
      updateGame(state, 0.1, idle);
      expect(heldMaterial(state) + state.stats.delivered).toBe(32);
    }
    expect(state.stats.testsSold).toBeGreaterThanOrEqual(16);
    expect(state.stats.rawSold).toBe(0);
    expect(state.stats.reportsSold).toBe(0);
    tick(state, 12);
    expect(state.stats.testsSold).toBe(32);
    expect(state.stats.processed).toBe(32);
    expect(state.stats.tested).toBe(32);
    expect(state.credits).toBe(224);
    expect(heldMaterial(state)).toBe(0);
  });
});

describe('station purchases and canonical fleets', () => {
  function qualified() {
    const state = clearWorld();
    // Explicit fixture fields allow the new contract to fail through assertions before integration.
    state.robots = []; state.vehicles = []; state.player.vehicleKind = null;
    state.ownedTools.push('handbrush', 'broom', 'widebrush');
    state.player.capacityLevel = 2;
    state.stats.reportsSold = 32; state.stats.testsSold = 256;
    state.credits = 1000000;
    return state;
  }
  function garage(state: GameState) { Object.assign(state.player, STATIONS.garage); }

  it('creates v5 with no singleton fleet fields and expanded populated regions', () => {
    const state = createGame(42);
    expect(state.version).toBe(5);
    expect(state.vehicles).toEqual([]); expect(state.robots).toEqual([]);
    expect(state.player.vehicleKind).toBeNull();
    expect('vehicle' in state).toBe(false); expect('robot' in state).toBe(false);
    expect(state.landmarks.filter(landmark => landmark.x > 1536 || landmark.y > 1152).length).toBeGreaterThanOrEqual(12);
  });

  it('requires the correct physical station and never charges a refused remote purchase', () => {
    const state = qualified();
    state.player.x = 100; state.player.y = 100;
    const credits = state.credits;
    expect(engine.buyUpgrade(state, 'speed').ok).toBe(false);
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(false);
    expect(state.credits).toBe(credits);
    Object.assign(state.player, STATIONS.workshop);
    expect(engine.getNearbyStation(state)).toBe('workshop');
    expect(engine.buyUpgrade(state, 'speed').ok).toBe(true);
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(false);
    garage(state); state.player.x += 64;
    expect(engine.getNearbyStation(state)).toBe('garage');
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(true);
    state.player.x += 0.1;
    expect(engine.getNearbyStation(state)).toBeNull();
  });

  it('opens the small robot and compact before tests while preserving their own prerequisites', () => {
    const state = qualified(); garage(state);
    state.ownedTools = ['toothbrush', 'handbrush']; state.stats.testsSold = 0;
    state.stats.reportsSold = 15; state.player.capacityLevel = 0;
    expect(engine.buyUpgrade(state, 'robot').ok).toBe(false);
    state.stats.reportsSold = 16;
    expect(engine.buyUpgrade(state, 'robot').ok).toBe(true);
    expect(state.vehicles).toHaveLength(0);
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(false);
    state.player.capacityLevel = 1; state.stats.reportsSold = 31;
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(false);
    state.stats.reportsSold = 32;
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(true);
    const receiver = state.buildings.find(building => building.kind === 'receiver')!;
    state.buildings = state.buildings.filter(building => building !== receiver);
    expect(engine.buyUpgrade(state, 'robot').ok).toBe(false);
  });

  it('keeps both vehicles parked independently and uses the nearest selected vehicle specifications', () => {
    const state = qualified(); garage(state);
    expect(engine.buyUpgrade(state, 'compact').ok).toBe(true);
    expect(engine.buyUpgrade(state, 'vehicle').ok).toBe(true);
    expect(state.vehicles).toHaveLength(2);
    const compact = state.vehicles.find(vehicle => vehicle.kind === 'compact')!;
    const heavy = state.vehicles.find(vehicle => vehicle.kind === 'vehicle')!;
    expect(Math.hypot(compact.x - STATIONS.garage.x, compact.y - STATIONS.garage.y)).toBeLessThan(110);
    expect(Math.hypot(heavy.x - compact.x, heavy.y - compact.y)).toBeGreaterThanOrEqual(24);
    Object.assign(state.player, compact);
    expect(toggleVehicle(state).ok).toBe(true);
    expect(engine.getVehicle(state)).toBe(compact);
    expect(getSpeed(state)).toBe(VEHICLES.compact.speed); expect(getCapacity(state)).toBe(2400);
    updateGame(state, 0.1, { ...idle, dy: -1 });
    expect(toggleVehicle(state).ok).toBe(true);
    const parkedCompact = { ...compact };
    Object.assign(state.player, heavy);
    expect(toggleVehicle(state).ok).toBe(true);
    expect(engine.getVehicle(state)).toBe(heavy);
    expect(getSpeed(state)).toBe(VEHICLES.vehicle.speed); expect(getCapacity(state)).toBe(10000);
    state.player.bag = 2001;
    expect(toggleVehicle(state).ok).toBe(false);
    expect(state.player.bag).toBe(2001); expect(state.player.riding).toBe(true);
    state.player.bag = 2000;
    expect(toggleVehicle(state).ok).toBe(true);
    expect(engine.getVehicle(state)).toBeNull(); expect(state.player.vehicleKind).toBeNull();
    expect(compact).toEqual(parkedCompact);
  });

  it('spawns garage vehicles outside scenery even when the first parking spot is blocked', () => {
    const state = qualified(); garage(state);
    state.obstacles.push({ x: STATIONS.garage.x + 12, y: STATIONS.garage.y + 8, w: 48, h: 48, kind: 'server' });
    expect(engine.buyUpgrade(state, 'vehicle').ok).toBe(true);
    const car = state.vehicles[0], obstacle = state.obstacles[0];
    const nearX = Math.max(obstacle.x, Math.min(car.x, obstacle.x + obstacle.w));
    const nearY = Math.max(obstacle.y, Math.min(car.y, obstacle.y + obstacle.h));
    expect(Math.hypot(car.x - nearX, car.y - nearY)).toBeGreaterThanOrEqual(8);
  });

  it('prices repeated robot kinds independently, assigns unique IDs and enforces five total', () => {
    const state = qualified(); garage(state);
    state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 700 });
    expect(engine.upgradePrice(state, 'robot')).toBe(1800);
    expect(engine.buyUpgrade(state, 'robot').ok).toBe(true);
    expect(engine.upgradePrice(state, 'robot')).toBe(2200);
    expect(engine.upgradePrice(state, 'industrialRobot')).toBe(ROBOTS.industrialRobot.price);
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    expect(engine.upgradePrice(state, 'industrialRobot')).toBe(90000);
    for (let i = 0; i < 3; i++) expect(engine.buyUpgrade(state, 'robot').ok).toBe(true);
    expect(state.robots).toHaveLength(5);
    expect(new Set(state.robots.map(robot => robot.id)).size).toBe(5);
    expect(state.robots.every(robot => robot.id < state.nextId)).toBe(true);
    const credits = state.credits;
    expect(engine.buyUpgrade(state, 'robot').ok).toBe(false);
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    expect(state.credits).toBe(credits - 90000);
    expect(state.robots).toHaveLength(5);
  });

  it('requires the heavy vehicle for PRO while the heavy vehicle needs no compact', () => {
    const state = qualified(); garage(state);
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    state.ownedTools = ['toothbrush', 'broom'];
    expect(engine.buyUpgrade(state, 'vehicle').ok).toBe(true);
    state.stats.testsSold = 255;
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    state.stats.testsSold = 256;
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    expect(state.robots[0].capacity).toBe(ROBOTS.industrialRobot.capacity);
  });

  it('protects station work areas from new construction without touching saved buildings', () => {
    const state = qualified();
    Object.assign(state.player, STATIONS.workshop);
    const gx = Math.floor(STATIONS.workshop.x / 24), gy = Math.floor(STATIONS.workshop.y / 24);
    expect(placeBuilding(state, 'belt', gx, gy, 0).ok).toBe(false);
    const existing = addMachine(state, 'belt', gx, gy);
    tick(state, 0.1);
    expect(state.buildings).toContain(existing);
  });

  it('remotely deposits PRO cargo only into route-connected receivers and retains partial overflow', () => {
    const state = qualified(); garage(state);
    state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 700 });
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    const bot = state.robots[0], receiver = state.buildings[0];
    bot.x = 900; bot.y = 588; bot.mode = 'returning'; bot.bag = 150;
    receiver.buffer = engine.getReceiverCapacity(state) - 50; receiver.cooldown = 100;
    const credits = state.credits;
    tick(state, 0.1);
    expect(receiver.buffer).toBe(engine.getReceiverCapacity(state));
    expect(bot.bag).toBe(100); expect(state.credits).toBe(credits);
    expect(bot.x).toBe(900); expect(bot.y).toBe(588);
    tick(state, 2);
    expect(bot.bag).toBe(100);
    receiver.buffer -= 100;
    tick(state, 1.2);
    expect(bot.bag).toBe(0); expect(state.credits).toBe(credits);
    expect(receiver.buffer).toBe(engine.getReceiverCapacity(state));
  });

  it('holds remote cargo while no typed terminal route exists then resumes when connected', () => {
    const state = qualified(); garage(state);
    state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 700 });
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    const bot = state.robots[0]; bot.mode = 'returning'; bot.bag = 180; bot.x = 900; bot.y = 588;
    const link = state.buildings.find(building => building.gx === 31)!;
    state.buildings = state.buildings.filter(building => building !== link);
    const credits = state.credits;
    tick(state, 2);
    expect(bot.bag).toBe(180); expect(state.buildings[0].buffer).toBe(0);
    state.buildings.push(link); state.buildings[0].cooldown = 100;
    tick(state, 1.2);
    expect(bot.bag).toBe(0); expect(state.buildings[0].buffer).toBe(180);
    expect(state.credits).toBe(credits);
  });

  it('gives PRO a large actual cleaning intake boost and spreads fleet targets without losing material', () => {
    function run(kind: 'robot' | 'industrialRobot', fleetSize: number) {
      const state = qualified(); garage(state);
      state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 700 });
      for (let i = 0; i < fleetSize; i++) expect(engine.buyUpgrade(state, kind).ok).toBe(true);
      for (let y = 444; y < 744; y += CELL) for (let x = 540; x < 840; x += CELL) pile(state, x, y, 5);
      for (const bot of state.robots) { bot.x = 684; bot.y = 588; }
      const initial = state.dust.reduce((sum, amount) => sum + amount, 0);
      tick(state, 6);
      expect(state.cleaned + state.dust.reduce((sum, amount) => sum + amount, 0)).toBe(initial);
      expect(heldMaterial(state) + state.stats.delivered).toBe(state.cleaned);
      return state;
    }
    const small = run('robot', 1), pro = run('industrialRobot', 1), fleet = run('robot', 5);
    expect(pro.stats.robotCleaned).toBeGreaterThan(small.stats.robotCleaned * 3);
    const targets = fleet.robots.map(bot => bot.target).filter(Boolean);
    expect(new Set(targets.map(target => `${target!.x}:${target!.y}`)).size).toBeGreaterThan(1);
    expect(engine.getRobotStatus(fleet)).toContain('5/5');
  });
});

describe('exhausted expanded-world fleet', () => {
  it('stops searching exhausted world cells while still delivering the final carried material', () => {
    const state = clearWorld();
    state.dust.fill(0); state.cleaned = state.totalDirt;
    let reads = 0;
    state.dust = new Proxy(state.dust, { get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    } });
    state.robots = Array.from({ length: 5 }, (_, index) => ({ id: state.nextId++, kind: index === 4 ? 'industrialRobot' : 'robot', x: 684, y: 588, bag: index === 4 ? 12 : 0, capacity: index === 4 ? 2400 : 180, mode: 'cleaning', target: null, path: [], timer: 0, cleanAccumulator: 0 }));
    tick(state, 5);
    expect(state.robots.every(robot => robot.bag === 0)).toBe(true);
    expect(state.stats.delivered).toBe(12);
    expect(reads).toBeLessThan(1000);
    expect(state.robots.every(robot => robot.path.length === 0 && robot.target === null)).toBe(true);
  });
});


describe('full-fleet PRO upgrades', () => {
  it('upgrades five early small robots in place without losing cargo or permanently locking late technology', () => {
    const state = clearWorld();
    Object.assign(state.player, STATIONS.garage);
    state.ownedTools.push('handbrush'); state.stats.reportsSold = 16; state.credits = 2000000;
    for (let index = 0; index < 5; index++) expect(engine.buyUpgrade(state, 'robot').ok).toBe(true);
    expect(engine.upgradePrice(state, 'robot')).toBe(Infinity);
    expect(engine.upgradePrice(state, 'industrialRobot')).toBe(ROBOTS.industrialRobot.price);
    const original = state.robots.map((robot, index) => {
      Object.assign(robot, { x: 1200 + index * 12, y: 900, bag: 40 + index, mode: 'returning', timer: index + 2, target: { x: 684, y: 588 }, path: [{ x: 1200, y: 890 }, { x: 1190, y: 890 }], cleanAccumulator: 0.4 });
      return JSON.parse(JSON.stringify(robot));
    });
    const cargo = heldMaterial(state), before = state.credits;
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    expect(state.credits).toBe(before);
    state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 720 }); state.stats.testsSold = 255;
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    expect(state.credits).toBe(before);
    state.stats.testsSold = 256;
    let spent = 0;
    for (let index = 0; index < 5; index++) {
      const price = Math.round(ROBOTS.industrialRobot.price * ECONOMY.robotPriceMultiplier ** index / 100) * 100;
      expect(engine.upgradePrice(state, 'industrialRobot')).toBe(price);
      const identities = [...state.robots];
      expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
      spent += price;
      expect(state.credits).toBe(before - spent);
      expect(state.robots).toHaveLength(5);
      expect(state.robots.every((robot, robotIndex) => robot === identities[robotIndex])).toBe(true);
      expect(state.robots[index]).toEqual({ ...original[index], kind: 'industrialRobot', capacity: ROBOTS.industrialRobot.capacity });
      expect(heldMaterial(state)).toBe(cargo);
      expect(state.robots.map(robot => robot.id)).toEqual(original.map(robot => robot.id));
    }
    expect(state.robots.every(robot => robot.kind === 'industrialRobot')).toBe(true);
    expect(engine.upgradePrice(state, 'industrialRobot')).toBe(Infinity);
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    expect(engine.buyUpgrade(state, 'robot').ok).toBe(false);
    expect(state.credits).toBe(before - spent);
  });

  it('preserves a legacy small robot capacity above PRO capacity during replacement', () => {
    const state = clearWorld(); Object.assign(state.player, STATIONS.garage);
    state.credits = ROBOTS.industrialRobot.price; state.stats.testsSold = 256;
    state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 720 });
    state.robots = Array.from({ length: 5 }, (_, index) => ({ id: state.nextId++, kind: 'robot', x: 888, y: 696, bag: index ? 0 : 3000, capacity: index ? 180 : 4000, mode: 'returning', target: null, path: [], timer: 1, cleanAccumulator: 0 }));
    const first = state.robots[0];
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    expect(state.robots[0]).toBe(first); expect(first.capacity).toBe(4000); expect(first.bag).toBe(3000);
    expect(state.robots).toHaveLength(5); expect(state.credits).toBe(0);
  });
});

describe('factory capacity matched to vehicle progression', () => {
  it('accepts a full second-container heavy vehicle load into one empty receiver', () => {
    const state = clearWorld();
    state.player.capacityLevel = 2;
    state.vehicles = [{ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 684, y: 588 }];
    state.player.x = 684; state.player.y = 588;
    expect(toggleVehicle(state).ok).toBe(true);
    state.player.bag = getCapacity(state);
    const load = state.player.bag;
    expect(interact(state).ok).toBe(true);
    expect(state.player.bag).toBe(0);
    expect(state.buildings[0].buffer).toBe(load);
    expect(heldMaterial(state)).toBe(load);
  });

  it('sustains over 800 tested units per minute on a single supplied full-processing line', () => {
    const state = factory();
    const receiver = addMachine(state, 'receiver', 32, 27);
    addMachine(state, 'analyzer', 32, 26); addMachine(state, 'tester', 32, 25);
    const supplied = engine.getReceiverCapacity(state); receiver.buffer = supplied;
    tick(state, 15);
    const sold = state.stats.testsSold;
    tick(state, 30);
    expect((state.stats.testsSold - sold) * 2).toBeGreaterThanOrEqual(800);
    expect(state.stats.rawSold).toBe(0); expect(state.stats.reportsSold).toBe(0);
    expect(heldMaterial(state) + state.stats.delivered).toBe(supplied);
  });

  it('keeps PRO a major purchase after expanding factory throughput', () => {
    const state = clearWorld(); Object.assign(state.player, STATIONS.garage);
    state.vehicles.push({ kind: 'vehicle', heading: Math.PI / 2, speed: 0, x: 920, y: 720 }); state.stats.testsSold = 256;
    state.credits = 74999;
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(false);
    expect(state.credits).toBe(74999); expect(state.robots).toHaveLength(0);
    state.credits++;
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    expect(state.credits).toBe(0); expect(state.robots).toHaveLength(1);
    expect(engine.upgradePrice(state, 'industrialRobot')).toBe(90000);
  });
});


describe('center base and four independent terminals', () => {
  it('starts at the central spawn with four protected fixed sale terminals', () => {
    const state = createGame(42);
    expect(state.version).toBe(5);
    expect({ x: state.player.x, y: state.player.y }).toEqual(SPAWN);
    expect(state.buildings.filter(building => building.kind === 'uplink').map(building => ({ x: building.gx * 24 + 12, y: building.gy * 24 + 12 }))).toEqual(TERMINALS.map(terminal => ({ x: terminal.x, y: terminal.y })));
    expect(state.buildings.map(building => building.id)).toEqual([5, 6, 7, 8]);
    expect(state.nextId).toBe(9);
  });

  it.each([0, 1, 2, 3])('accepts bags, recovery sales, reclaim and connected factory traffic at terminal %i', index => {
    const state = createGame(7); state.obstacles = []; state.dust.fill(0); state.landmarks = [];
    const terminal = state.buildings[index];
    Object.assign(state.player, { x: terminal.gx * 24 + 12, y: terminal.gy * 24 + 12 });
    state.player.bag = 8; state.recovered = { raw: 1, report: 2, test: 3 };
    expect(interact(state).ok).toBe(true);
    expect(state.credits).toBe(36); expect(state.recovered).toEqual({ raw: 0, report: 0, test: 0 });
    expect(engine.reclaimBugs(state).ok).toBe(true); expect(state.player.bag).toBe(9);
    expect(engine.getNearestTerminal?.(state)).toBe(terminal);
    expect(removeBuilding(state, terminal.gx, terminal.gy).ok).toBe(false);
    expect(rotateBuilding(state, terminal.gx, terminal.gy).ok).toBe(false);
    const receiver = addMachine(state, 'receiver', terminal.gx + 1, terminal.gy); receiver.buffer = 8;
    expect(engine.receiverHasRoute(state, receiver)).toBe(true);
    tick(state, 1); expect(state.stats.delivered).toBe(22);
  });
});

describe('steered front-sweep vehicles', () => {
  function car(kind: 'compact' | 'vehicle' = 'compact') {
    const state = clearWorld();
    state.player.x = 606; state.player.y = 606;
    state.vehicles = [{ kind, x: 606, y: 606, heading: 0, speed: 0 }];
    expect(toggleVehicle(state).ok).toBe(true);
    return state;
  }
  it.each(['compact', 'vehicle'] as const)('%s cleans only its oriented front strip and ignores mouse aim', kind => {
    const state = car(kind);
    const front = pile(state, 630, 606, 8), behind = pile(state, 582, 606, 8), side = pile(state, 606, 642, 8);
    for (let index = 0; index < 10; index++) updateGame(state, 0.1, { ...idle, clean: true, aimX: 500, aimY: 606 });
    expect(state.dust[front]).toBe(0); expect(state.dust[behind]).toBe(8); expect(state.dust[side]).toBe(8);
    expect(state.player.bag).toBe(8); expect(state.vehicles[0].heading).toBe(0);
    const sweep = engine.getVehicleSweep?.(state);
    expect(sweep).toEqual({ x: 606 + VEHICLES[kind].reach, y: 606, forwardX: 1, forwardY: 0, width: VEHICLES[kind].width, depth: VEHICLES[kind].depth });
    state.vehicles[0].heading = Math.PI / 2;
    const newFront = pile(state, 606, 630, 8);
    for (let index = 0; index < 10; index++) updateGame(state, 0.1, { ...idle, clean: true });
    expect(state.dust[newFront]).toBe(0); expect(state.dust[behind]).toBe(8);
  });
  it('accelerates forward, brakes and reverses with a lower cap while steering has a finite rate', () => {
    const state = car(); const vehicle = state.vehicles[0], config = VEHICLES.compact;
    updateGame(state, 0.1, { ...idle, dy: -1 });
    expect(vehicle.speed).toBeCloseTo(config.acceleration * 0.1);
    expect(state.player.x).toBeGreaterThan(606); expect(state.player.y).toBeCloseTo(606);
    for (let i = 0; i < 30; i++) updateGame(state, 0.1, { ...idle, dy: -1 });
    expect(vehicle.speed).toBe(config.speed);
    const heading = vehicle.heading;
    updateGame(state, 0.1, { ...idle, dx: 1, dy: -1 });
    expect(vehicle.heading - heading).toBeGreaterThan(0);
    expect(vehicle.heading - heading).toBeLessThanOrEqual(config.turnRate * 0.1 + 1e-9);
    for (let i = 0; i < 10; i++) updateGame(state, 0.1, { ...idle, dy: -1, clean: true });
    expect(vehicle.speed).toBe(config.cleanSpeed); expect(getSpeed(state, true)).toBe(config.cleanSpeed);
    for (let i = 0; i < 30; i++) updateGame(state, 0.1, { ...idle, dy: 1 });
    expect(vehicle.speed).toBeCloseTo(-config.speed * 0.45);
    updateGame(state, 0.1, idle);
    expect(Math.abs(vehicle.speed)).toBeLessThan(config.speed * 0.45);
  });
  it.each(['compact', 'vehicle'] as const)('%s can accelerate from rest in either direction at high refresh rates', kind => {
    for (const hz of [60, 120, 144, 240]) for (const dy of [-1, 1]) {
      const state = car(kind);
      for (let frame = 0; frame < hz * 2; frame++) updateGame(state, 1 / hz, { ...idle, dy });
      expect((state.player.x - 606) * -dy, `${kind}, ${hz} Hz, throttle ${-dy}`).toBeGreaterThan(100);
      expect(state.vehicles[0].speed * -dy).toBeGreaterThan(50);
    }
  });
  it.each(['compact', 'vehicle'] as const)('%s still stops at a real obstacle and can reverse away at high refresh rates', kind => {
    const state = car(kind);
    state.obstacles = [{ x: 626, y: 580, w: 24, h: 80, kind: 'server' }];
    for (let frame = 0; frame < 240; frame++) updateGame(state, 1 / 120, { ...idle, dy: -1 });
    expect(state.player.x).toBeGreaterThan(616);
    expect(state.player.x).toBeLessThanOrEqual(618);
    expect(state.vehicles[0].speed).toBe(0);
    for (let frame = 0; frame < 120; frame++) updateGame(state, 1 / 120, { ...idle, dy: 1 });
    expect(state.player.x).toBeLessThan(590);
  });
});

describe('global robot work and finite delivery logistics', () => {
  function bot(kind: 'robot' | 'industrialRobot' = 'robot', x = 2000, y = 1200) {
    const state = clearWorld();
    state.robots = [{ id: state.nextId++, kind, x, y, bag: 0, capacity: ROBOTS[kind].capacity, mode: 'cleaning', target: null, path: [], timer: 0, cleanAccumulator: 0 }];
    return state;
  }
  it.each(['robot', 'industrialRobot'] as const)('%s cleans far beyond any receiver and eventually delivers every unit through the connected line', kind => {
    const state = bot(kind), dirt = pile(state, 2000, 1200, 5);
    tick(state, 60);
    expect(state.dust[dirt]).toBe(0); expect(state.stats.robotCleaned).toBe(5);
    expect(state.stats.rawSold).toBe(5); expect(state.credits).toBe(5);
    expect(heldMaterial(state)).toBe(0);
  });
  it('makes a distant connected receiver shorten the small robot return without teleporting cargo', () => {
    const baseOnly = bot('robot', 1092, 720), outpost = bot('robot', 1092, 720);
    const remote = connectedRemote(outpost, 45, 24); remote.cooldown = 100;
    for (const state of [baseOnly, outpost]) {
      state.buildings[0].cooldown = 100;
      state.robots[0].bag = 12; state.robots[0].mode = 'returning';
      tick(state, 0.1); expect(state.robots[0].bag).toBe(12);
      tick(state, 2);
    }
    expect(baseOnly.robots[0].bag).toBe(12); expect(baseOnly.buildings[0].buffer).toBe(0);
    expect(outpost.robots[0].bag).toBe(0); expect(remote.buffer).toBe(12); expect(outpost.buildings[0].buffer).toBe(0);
  });
  it('distributes PRO cargo globally across available connected inputs and retains overflow instead of minting cash', () => {
    const state = bot('industrialRobot'), robot = state.robots[0], first = state.buildings[0];
    const second = connectedRemote(state, 34, 24);
    const capacity = engine.getReceiverCapacity(state);
    first.buffer = capacity - 50; second.buffer = capacity - 100; first.cooldown = second.cooldown = 100;
    robot.bag = 200; robot.mode = 'returning';
    const initial = heldMaterial(state);
    tick(state, 0.1);
    expect(first.buffer).toBe(capacity); expect(second.buffer).toBe(capacity);
    expect(robot.bag).toBe(50); expect(state.credits).toBe(0); expect(heldMaterial(state)).toBe(initial);
    first.buffer -= 50;
    tick(state, 1.2);
    expect(robot.bag).toBe(0); expect(first.buffer).toBe(capacity); expect(state.credits).toBe(0);
  });
  it('shares a PRO shipment across two open factory inputs rather than starving the later receiver', () => {
    const state = bot('industrialRobot'), first = state.buildings[0], second = connectedRemote(state, 34, 24);
    first.cooldown = second.cooldown = 100;
    state.robots[0].bag = 120; state.robots[0].mode = 'returning';
    tick(state, .1);
    expect(first.buffer).toBe(60); expect(second.buffer).toBe(60);
    expect(state.robots[0].bag).toBe(0); expect(heldMaterial(state)).toBe(120); expect(state.credits).toBe(0);
  });
  it('pauses all global collection while inputs are full or disconnected and resumes without losing carried material', () => {
    const state = bot('industrialRobot'), robot = state.robots[0], receiver = state.buildings[0];
    robot.bag = 50; receiver.buffer = engine.getReceiverCapacity(state); receiver.cooldown = 100;
    const dirt = pile(state, 2000, 1200, 5);
    tick(state, 2); expect(robot.bag).toBe(50); expect(state.dust[dirt]).toBe(5);
    receiver.buffer = 0;
    const link = state.buildings[1]; state.buildings = state.buildings.filter(building => building !== link);
    tick(state, 2); expect(robot.bag).toBe(50); expect(state.dust[dirt]).toBe(5);
    state.buildings.push(link);
    tick(state, 12);
    expect(state.dust[dirt]).toBe(0); expect(robot.bag).toBe(0); expect(heldMaterial(state)).toBe(55);
    expect(state.credits).toBe(0);
  });
  it('keeps cargo safe after receiver demolition, then delivers when a replacement reconnects', () => {
    const state = bot('industrialRobot'), robot = state.robots[0]; robot.bag = 90; robot.mode = 'returning';
    expect(removeBuilding(state, 28, 24).ok).toBe(true);
    tick(state, 2); expect(robot.bag).toBe(90); expect(state.credits).toBe(0);
    addMachine(state, 'receiver', 28, 24).cooldown = 100;
    tick(state, 1.2); expect(robot.bag).toBe(0); expect(heldMaterial(state)).toBe(90);
  });
  it('shares the global dirty index across five idle robots and refreshes it when a fresh dust array arrives', () => {
    const state = bot();
    state.robots = Array.from({ length: 5 }, (_, index) => ({ ...state.robots[0], id: state.nextId++, path: [] }));
    let reads = 0;
    state.dust = new Proxy(state.dust, { get(target, property, receiver) { if (typeof property === 'string' && /^\d+$/.test(property)) reads++; return Reflect.get(target, property, receiver); } });
    tick(state, 0.1); reads = 0;
    tick(state, 5); expect(reads).toBeLessThan(1000);
    expect(state.robots.every(robot => robot.target === null && robot.path.length === 0)).toBe(true);
    state.dust = state.dust.slice(); const far = pile(state, 2000, 1200, 5);
    tick(state, 5); expect(state.dust[far]).toBe(0); expect(state.stats.robotCleaned).toBe(5);
  });
});

describe('fully spaced material-processing routes', () => {
  function spaced(state: GameState, gy: number, amount: number) {
    const receiver = addMachine(state, 'receiver', 26, gy, 2); receiver.buffer = amount;
    addMachine(state, 'belt', 27, gy, 3);
    const analyzer = addMachine(state, 'analyzer', 28, gy, 2);
    addMachine(state, 'belt', 29, gy, 1);
    const tester = addMachine(state, 'tester', 30, gy, 2);
    addMachine(state, 'belt', 31, gy, 0);
    if (gy !== 24) {
      addMachine(state, 'belt', 32, gy, 2);
      for (let y = gy + Math.sign(24 - gy); y !== 24; y += Math.sign(24 - gy)) addMachine(state, 'belt', 32, y, 2);
    }
    return { receiver, analyzer, tester };
  }
  function drain(state: GameState, amount: number, seconds = 60) {
    for (let i = 0; i < seconds * 10; i++) {
      updateGame(state, 0.1, idle);
      expect(heldMaterial(state) + state.stats.delivered).toBe(amount);
      expect(new Set(state.capsules.map(capsule => `${capsule.gx}:${capsule.gy}`)).size).toBe(state.capsules.length);
    }
    expect(state.stats.rawSold).toBe(0); expect(state.stats.reportsSold).toBe(0);
    expect(state.stats.testsSold).toBe(amount); expect(state.credits).toBe(amount * 7);
    expect(heldMaterial(state)).toBe(0);
  }
  it('delivers every unit through receiver, belt, analyzer, belt, tester, belt and terminal despite misleading rotations', () => {
    const state = factory(); spaced(state, 24, 256); drain(state, 256);
  });
  it('drains two separated parallel processing lines without backward stranded stock or downgraded sales', () => {
    const state = factory(); spaced(state, 22, 256); spaced(state, 26, 384); drain(state, 640, 100);
  });
  it('does not strand finished goods in the raw input stem while a live spaced line is extended', () => {
    const state = factory();
    addMachine(state, 'receiver', 26, 24, 2).buffer = 64;
    addMachine(state, 'belt', 27, 24, 0);
    addMachine(state, 'analyzer', 28, 24, 2);
    tick(state, 3);
    expect(heldMaterial(state)).toBe(64); expect(state.credits).toBe(0);
    addMachine(state, 'belt', 29, 24, 2);
    addMachine(state, 'tester', 30, 24, 2);
    tick(state, 3);
    expect(heldMaterial(state)).toBe(64); expect(state.credits).toBe(0);
    addMachine(state, 'belt', 31, 24, 2);
    drain(state, 64);
  });
});

describe('fractional-frame robot navigation', () => {
  it.each([0.016, 0.05])('delivers PRO cargo through the real local network at dt=%s without resetting its cargo age on waypoint residue', dt => {
    const state = createGame(42);
    Object.assign(state.player, STATIONS.garage);
    state.ownedTools.push('handbrush'); state.player.capacityLevel = 1;
    state.vehicles.push({ kind: 'vehicle', x: STATIONS.garage.x + 24, y: STATIONS.garage.y + 24, heading: Math.PI / 2, speed: 0 });
    state.stats.testsSold = 256; state.stats.reportsSold = 32; state.stats.delivered = 288;
    state.credits = ROBOTS.industrialRobot.price;
    const terminal = state.buildings[0];
    addMachine(state, 'receiver', terminal.gx - 4, terminal.gy, 0);
    for (let gx = terminal.gx - 3; gx < terminal.gx; gx++) addMachine(state, 'belt', gx, terminal.gy, 0);
    expect(engine.buyUpgrade(state, 'industrialRobot').ok).toBe(true);
    const budget = state.dust.reduce((sum, amount) => sum + amount, 0) + heldMaterial(state) + state.stats.delivered;
    while (state.time < 20 - 1e-9) updateGame(state, dt, idle);
    expect(state.stats.robotCleaned).toBeGreaterThan(0);
    expect(state.stats.rawSold).toBeGreaterThan(0);
    expect(state.dust.reduce((sum, amount) => sum + amount, 0) + heldMaterial(state) + state.stats.delivered).toBe(budget);
  });
});

describe('one receiver supplying parallel processing branches', () => {
  function network(branches: number) {
    const state = createGame(42); state.obstacles = []; state.landmarks = []; state.dust.fill(0); state.totalDirt = 0;
    const center = { gx: Math.floor(HUB.x / 24), gy: Math.floor(HUB.y / 24) };
    const cell = (kind: BuildKind, gx: number, gy: number) => state.buildings.find(building => building.gx === gx && building.gy === gy) ?? addMachine(state, kind, gx, gy, 2);
    const receiver = cell('receiver', center.gx, center.gy - 8);
    for (let y = center.gy - 7; y <= center.gy; y++) cell('belt', center.gx, y);
    for (const [offset, direction] of [[-10, -1], [-10, 1], [10, -1], [10, 1]].slice(0, branches)) {
      for (let x = center.gx + Math.sign(offset); x !== center.gx + offset; x += Math.sign(offset)) cell('belt', x, center.gy);
      const x = center.gx + offset; cell('belt', x, center.gy);
      for (let index = 1; index <= 5; index++) cell('belt', x, center.gy + direction * index);
      cell('analyzer', x, center.gy + direction * 6);
      cell('belt', x, center.gy + direction * 7);
      cell('tester', x, center.gy + direction * 8);
      cell('belt', x, center.gy + direction * 9);
    }
    return { state, receiver };
  }
  function saturated(branches: number) {
    const { state, receiver } = network(branches);
    let supplied = 0, warmSales = 0;
    for (let step = 0; step < 2400; step++) {
      const units = engine.getReceiverCapacity(state) - receiver.buffer;
      supplied += units; receiver.buffer += units;
      updateGame(state, .05, idle);
      if (step === 799) warmSales = state.stats.testsSold;
      expect(heldMaterial(state) + state.stats.delivered).toBe(supplied);
      expect(new Set(state.capsules.map(capsule => `${capsule.gx}:${capsule.gy}`)).size).toBe(state.capsules.length);
    }
    expect(state.buildings.filter(building => building.kind === 'receiver')).toHaveLength(1);
    expect(state.stats.rawSold).toBe(0); expect(state.stats.reportsSold).toBe(0);
    expect(state.credits).toBe(state.stats.testsSold * 7);
    return (state.stats.testsSold - warmSales) / 80;
  }
  it('makes four branches carry over 3.5 times one branch through the same eight-belt raw trunk', () => {
    const one = saturated(1), two = saturated(2), four = saturated(4);
    expect(two).toBeGreaterThan(one * 1.8);
    expect(four).toBeGreaterThan(two * 1.8);
    expect(four).toBeGreaterThan(one * 3.5);
    expect(four).toBeGreaterThan(55);
  });
  it.each([3, 8, 16, 31, 32, 64])('packs a raw load of %i without losing partial cargo or forcing large packets for small loads', units => {
    const state = factory(), receiver = addMachine(state, 'receiver', 36, 28);
    receiver.buffer = units;
    updateGame(state, .1, idle);
    expect(state.capsules).toHaveLength(1);
    expect(state.capsules[0].units).toBe(units >= 32 ? 32 : Math.min(8, units));
    expect(receiver.buffer + state.capsules[0].units).toBe(units);
  });
  it('cannot turn an input-limited shipment into extra material or credits by adding branches', () => {
    for (const branches of [1, 4]) {
      const { state, receiver } = network(branches);
      let accumulator = 0, supplied = 0;
      for (let frame = 0; frame < 2000; frame++) {
        accumulator += .05 * 6;
        const units = Math.floor(accumulator + 1e-9); accumulator -= units;
        receiver.buffer += units; supplied += units;
        updateGame(state, .05, idle);
        expect(heldMaterial(state) + state.stats.delivered).toBe(supplied);
      }
      tick(state, 120);
      expect(supplied).toBe(600); expect(state.stats.testsSold).toBe(supplied);
      expect(state.stats.rawSold + state.stats.reportsSold).toBe(0);
      expect(state.credits).toBe(supplied * 7); expect(heldMaterial(state)).toBe(0);
    }
  });
});

describe('large raw batches on a shared processor input and output stem', () => {
  function sharedStem(units: number, initialInput = 0) {
    const state = createGame(42);
    state.obstacles = []; state.landmarks = []; state.dust.fill(0); state.totalDirt = 0;
    const terminal = state.buildings[0], { gx, gy } = terminal;
    addMachine(state, 'receiver', gx + 3, gy, 0).buffer = units;
    addMachine(state, 'belt', gx + 2, gy, 0);
    const tester = addMachine(state, 'tester', gx + 1, gy, 0);
    addMachine(state, 'belt', gx + 2, gy + 1, 0);
    const analyzer = addMachine(state, 'analyzer', gx + 2, gy + 2, 0);
    analyzer.buffer = initialInput;
    return { state, analyzer, tester };
  }
  function drainSharedStem(state: GameState, units: number, seconds = 800) {
    for (let step = 0; step < seconds * 10 && state.stats.testsSold < units; step++) {
      updateGame(state, .1, idle);
      expect(heldMaterial(state) + state.stats.delivered).toBe(units);
      expect(new Set(state.capsules.map(capsule => `${capsule.gx}:${capsule.gy}`)).size).toBe(state.capsules.length);
      for (const building of state.buildings) {
        if (building.kind !== 'analyzer' && building.kind !== 'tester') continue;
        expect(building.buffer).toBeLessThanOrEqual(32);
        expect(building.outputBuffer + (building.processing?.units ?? 0)).toBeLessThanOrEqual(32);
        const packet = state.capsules.find(capsule => capsule.gx === building.gx && capsule.gy === building.gy);
        // Intake requires a free cell or an exchange that departs the old packet.
        // Repacking can redistribute these 64 units, but never add a third store.
        expect(building.buffer + building.outputBuffer + (building.processing?.units ?? 0) + (packet?.units ?? 0)).toBeLessThanOrEqual(64);
      }
    }
    expect(state.stats.rawSold + state.stats.reportsSold).toBe(0);
    expect(state.stats.testsSold).toBe(units);
    expect(state.credits).toBe(units * 7);
    expect(heldMaterial(state)).toBe(0);
  }
  it.each([24, 4096, 4099])('drains %i raw units through a one-port analyzer without a permanently trapped large packet', units => {
    const { state } = sharedStem(units);
    drainSharedStem(state, units);
  });
  it.each([3, 5, 32])('drains large raw batches after the analyzer begins with %i units of uneven input', initialInput => {
    const { state } = sharedStem(256, initialInput);
    drainSharedStem(state, 256 + initialInput);
  });
  it.each(['analyzer', 'tester'] as const)('consolidates blocked %s output only after its transfer has stopped', kind => {
    const state = factory(), source = addMachine(state, kind, 36, 28, 0);
    source.outputBuffer = 24;
    const packet = { id: state.nextId++, gx: source.gx, gy: source.gy, dir: 0 as Direction, progress: .5, units: 8, material: PROCESSING[kind].output };
    state.capsules.push(packet);
    updateGame(state, .01, idle);
    expect(packet.units).toBe(8);
    expect(packet.progress).toBe(0);
    expect(source.outputBuffer).toBe(24);
    updateGame(state, .01, idle);
    expect(packet.units).toBe(32);
    expect(source.outputBuffer).toBe(0);
    expect(state.capsules).toEqual([packet]);
    expect(heldMaterial(state)).toBe(32);
    tick(state, 5);
    expect(heldMaterial(state)).toBe(32);
    expect(state.credits).toBe(0);
  });
  it('preserves consolidated output across a real save and resumes after the missing consumer is rebuilt', () => {
    const { state, analyzer, tester } = sharedStem(259);
    Object.assign(state.player, { x: tester.gx * 24 + 12, y: tester.gy * 24 + 12 });
    expect(removeBuilding(state, tester.gx, tester.gy).ok).toBe(true);
    const constructionRefund = state.credits;
    tick(state, 5);
    const consolidated = state.capsules.find(capsule => capsule.gx === analyzer.gx && capsule.gy === analyzer.gy);
    expect(consolidated?.units).toBe(32);
    expect(consolidated?.progress).toBe(0);
    expect(heldMaterial(state)).toBe(259);
    const restored = deserializeGame(serializeGame(state));
    expect(restored).not.toBeNull();
    const savedPacket = { ...consolidated! };
    for (const world of [state, restored!]) {
      expect(world.capsules.find(capsule => capsule.id === savedPacket.id)).toEqual(savedPacket);
      addMachine(world, 'tester', tester.gx, tester.gy, 2);
      world.credits -= constructionRefund;
      drainSharedStem(world, 259);
    }
    expect(restored!.buildings).toEqual(state.buildings);
    expect(restored!.capsules).toEqual(state.capsules);
    expect(restored!.stats).toEqual(state.stats);
  });
});
