import * as engine from './engine';
import { BUILD_CELL, BUILDINGS, CELL, DIRECTIONS, ECONOMY, GRID_H, GRID_W, HUB, SPAWN, STATIONS, TERMINALS, TOOLS, VEHICLES, WORLD_H, WORLD_W,
  type ActionResult, type BuildKind, type Building, type Direction, type GameState, type RobotKind, type UpgradeId, type Vec } from './types';

const DT = .1;
const idle = { dx: 0, dy: 0, clean: false };
const position = (b: Pick<Building, 'gx' | 'gy'>): Vec => ({ x: b.gx * BUILD_CELL + BUILD_CELL / 2, y: b.gy * BUILD_CELL + BUILD_CELL / 2 });
const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const round = (value: number): number => Math.round(value * 100) / 100;
type DustTarget = Vec & { index: number };
type PilotTarget = Vec & { index?: number };
type Route<T> = { path: Vec[]; found: T };
interface Pathfinder { <T>(goal: (point: Vec, index: number) => T | null | false): Route<T> | null; walkable: Uint8Array }
export interface PilotMetrics {
  gatherSeconds: number; returnTravelSeconds: number; depositSeconds: number; blockedDepositSeconds: number;
  productionIdleSeconds: number; forcedTravelSeconds: number; forcedWaitSeconds: number; vehicleRecoveries: number;
  fullBagTrips: number; stationVisits: number; unloadedUnits: number;
}
export interface MetricsSnapshot extends PilotMetrics { unloadActions: number; returnTravelPercentOfGatherAndTravel: number }
export interface Pilot {
  state: GameState; findPath: Pathfinder; station: Building; path: Vec[]; target: PilotTarget | null;
  returning: boolean; atDelivery: boolean; stalled: number; deliveries: number; carRecovery: number; carRecoverySteer: number;
  metrics: PilotMetrics;
}
export function progressionSnapshot(state: GameState) {
  return { seconds: round(state.time), credits: state.credits, earned: state.earned, collected: state.cleaned, sold: state.stats.delivered,
    rawSold: state.stats.rawSold, reportsSold: state.stats.reportsSold, testsSold: state.stats.testsSold, rawReclaimed: state.stats.rawReclaimed,
    playerBag: state.player.bag, robotBag: state.robots.reduce((sum, robot) => sum + robot.bag, 0) };
}
export type BuildPlan = [BuildKind, number, number, Direction][];
/** Reserve the tester cell from the first build; machines always have intervening belts. */
export function progressionLayouts() {
  const nw = { gx: Math.floor(TERMINALS[0].x / BUILD_CELL), gy: Math.floor(TERMINALS[0].y / BUILD_CELL) };
  const ne = { gx: Math.floor(TERMINALS[1].x / BUILD_CELL), gy: Math.floor(TERMINALS[1].y / BUILD_CELL) };
  const plan = (terminal: typeof nw, side: number): BuildPlan => [
    ['receiver', terminal.gx + side * 6, terminal.gy + 2, 0],
    ['belt', terminal.gx + side * 5, terminal.gy + 2, 0],
    ['analyzer', terminal.gx + side * 4, terminal.gy + 2, 0],
    ['belt', terminal.gx + side * 3, terminal.gy + 2, 0],
    ['belt', terminal.gx + side * 2, terminal.gy + 2, 0],
    ['belt', terminal.gx + side, terminal.gy + 2, 0],
    ['belt', terminal.gx, terminal.gy + 2, 0],
    ['belt', terminal.gx, terminal.gy + 1, 0],
  ];
  // Point inward so every construction tile and walking anchor stays on the
  // guaranteed clear base, independently of the requested world's scenery.
  return { nw, ne, analysisLayout: plan(nw, 1), secondLayout: plan(ne, -1),
    analysisAnchor: position({ gx: nw.gx + 3, gy: nw.gy + 1 }), secondAnchor: position({ gx: ne.gx - 3, gy: ne.gy + 1 }) };
}
function placePlan(state: GameState, plan: BuildPlan): ActionResult {
  for (const [kind, gx, gy, dir] of plan) {
    if (state.buildings.some(b => b.gx === gx && b.gy === gy && b.kind === kind)) continue;
    const action = engine.placeBuilding(state, kind, gx, gy, dir); if (!action.ok) return action;
  }
  return { ok: true, message: '' };
}

export interface NetworkCell { gx: number; gy: number }
export interface IndustrialLane {
  analyzer: NetworkCell; tester: NetworkCell; input: NetworkCell; output: NetworkCell;
  terminal: NetworkCell; outputPath: NetworkCell[];
}
export interface IndustrialNetworkPlan {
  plan: BuildPlan; receiver: NetworkCell; receivers: NetworkCell[];
  rawTrunk: NetworkCell[]; lanes: IndustrialLane[];
}
const replayParking = { x: HUB.x + 84, y: HUB.y + 96 };

/** One source, one shared raw spine and independently routed finished products. */
export function createIndustrialNetworkPlan(state: GameState, options: {
  lanes?: 1 | 2 | 4; remoteDistance?: number; additionalReceiver?: boolean;
} = {}): IndustrialNetworkPlan {
  const laneCount = options.lanes ?? 4, remoteDistance = options.remoteDistance ?? 1560;
  if (![1,2,4].includes(laneCount) || !Number.isFinite(remoteDistance) || remoteDistance < 300 || remoteDistance > 1800) throw Error('Invalid industrial network options.');
  const hx = Math.floor(HUB.x / BUILD_CELL), hy = Math.floor(HUB.y / BUILD_CELL);
  const width = WORLD_W / BUILD_CELL, height = WORLD_H / BUILD_CELL;
  const plan: BuildPlan = [], occupied = new Set(state.buildings.map(b => b.gy * width + b.gx));
  const rawTrunk: NetworkCell[] = [], lanes: IndustrialLane[] = [];
  const add = (kind: BuildKind, gx: number, gy: number) => {
    const index = gy * width + gx;
    if (occupied.has(index)) throw Error(`Industrial plan overlaps an existing cell ${gx},${gy}.`);
    occupied.add(index); plan.push([kind,gx,gy,0]);
  };
  const clearTerrain = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false;
    const left = x * BUILD_CELL, top = y * BUILD_CELL;
    if (state.obstacles.some(o => left < o.x + o.w && left + BUILD_CELL > o.x && top < o.y + o.h && top + BUILD_CELL > o.y)) return false;
    const reserved = [...Object.values(STATIONS).map(s=>({...s,radius:32})), {...SPAWN,radius:36}, {...replayParking,radius:48}];
    return !reserved.some(s => Math.hypot(s.x - Math.max(left, Math.min(s.x, left + BUILD_CELL)), s.y - Math.max(top, Math.min(s.y, top + BUILD_CELL))) < s.radius);
  };
  const route = (source: NetworkCell | NetworkCell[], goal: (cell: NetworkCell) => boolean, terminal?: NetworkCell): NetworkCell[] => {
    const anchors = Array.isArray(source) ? source : [source];
    const anchorIndices = new Set(anchors.map(anchor=>anchor.gy*width+anchor.gx));
    const terminalIndex = terminal ? terminal.gy * width + terminal.gx : -1;
    const free = (x: number, y: number) => {
      const index = y * width + x;
      if (occupied.has(index) || !clearTerrain(x,y)) return false;
      const isGoal = goal({gx:x,gy:y});
      return !DIRECTIONS.some(d => {
        const neighbor=(y+d.y)*width+x+d.x;
        return occupied.has(neighbor) && !anchorIndices.has(neighbor) && !(isGoal && neighbor===terminalIndex);
      });
    };
    const previous=new Int32Array(width*height).fill(-2),queue=new Int32Array(width*height);
    let head=0,tail=0,end=-1;
    for(const anchor of anchors)for(const d of DIRECTIONS) {
      const x=anchor.gx+d.x,y=anchor.gy+d.y,index=y*width+x;
      if(previous[index]===-2&&free(x,y)){queue[tail++]=index;previous[index]=-1;}
    }
    while(head<tail) {
      const index=queue[head++],x=index%width,y=Math.floor(index/width);
      if(goal({gx:x,gy:y})){end=index;break;}
      for(const d of DIRECTIONS) {
        const nx=x+d.x,ny=y+d.y,next=ny*width+nx;
        if(nx<0||ny<0||nx>=width||ny>=height||previous[next]!==-2||!free(nx,ny))continue;
        previous[next]=index;queue[tail++]=next;
      }
    }
    if(end<0)throw Error(`No independent industrial conveyor route in seed ${state.seed} from ${anchors[0].gx},${anchors[0].gy}.`);
    const path:NetworkCell[]=[];
    for(let index=end;index!==-1;index=previous[index])path.push({gx:index%width,gy:Math.floor(index/width)});
    return path.reverse();
  };
  for(let y=hy+1;y<=hy+11;y++) {
    add('belt',hx-8,y);rawTrunk.push({gx:hx-8,gy:y});
  }
  const terminalOrder=[0,1,3,2];
  for(let row=0;row<laneCount;row++) {
    const y=hy+2+row*3;
    const analyzer={gx:hx-6,gy:y},tester={gx:hx-3,gy:y},input={gx:hx-7,gy:y},output={gx:hx-2,gy:y};
    add('belt',input.gx,y);add('analyzer',analyzer.gx,y);
    add('belt',hx-5,y);add('belt',hx-4,y);add('tester',tester.gx,y);add('belt',output.gx,y);
    const terminal={gx:Math.floor(TERMINALS[terminalOrder[row]].x/BUILD_CELL),gy:Math.floor(TERMINALS[terminalOrder[row]].y/BUILD_CELL)};
    lanes.push({analyzer,tester,input,output,terminal,outputPath:[output]});
  }
  for(let row=0;row<lanes.length;row++) {
    const lane=lanes[row],target={gx:lane.terminal.gx,gy:lane.terminal.gy+(row<2?-1:1)};
    const path=route(lane.output,c=>c.gx===target.gx&&c.gy===target.gy,lane.terminal);
    for(const cell of path)add('belt',cell.gx,cell.gy);
    lane.outputPath.push(...path);
  }
  const primaryPath=route(rawTrunk[0],cell=>{
    const point=position(cell);
    return point.x<=HUB.x-remoteDistance && Math.abs(point.y-(HUB.y+180))<=240;
  });
  const receiver=primaryPath[primaryPath.length-1];
  for(let index=0;index<primaryPath.length;index++) {
    const cell=primaryPath[index];add(index===primaryPath.length-1?'receiver':'belt',cell.gx,cell.gy);
  }
  rawTrunk.push(...primaryPath.slice(0,-1));
  const receivers=[receiver];
  if(options.additionalReceiver) {
    const path=route(rawTrunk.slice(0,11),cell=>{
      const point=position(cell);
      return point.x>=HUB.x+1200 && point.y>=HUB.y+600 && distance(point,HUB)>=1380;
    });
    for(let index=0;index<path.length;index++) {
      const cell=path[index];add(index===path.length-1?'receiver':'belt',cell.gx,cell.gy);
    }
    rawTrunk.push(...path.slice(0,-1));receivers.push(path[path.length-1]);
  }
  return {plan,receiver,receivers,rawTrunk,lanes};
}

function canStand(state: GameState, x: number, y: number) {
  // Navigation mirrors the current eight-pixel actor footprint. Engine movement
  // remains authoritative: route drift/stalls are detected rather than teleported.
  if (x < 8 || y < 8 || x > WORLD_W - 8 || y > WORLD_H - 8) return false;
  return !state.obstacles.some(obstacle => Math.hypot(x - Math.max(obstacle.x, Math.min(x, obstacle.x + obstacle.w)), y - Math.max(obstacle.y, Math.min(y, obstacle.y + obstacle.h))) < 8);
}

function navigator(state: GameState): Pathfinder {
  const walkable = new Uint8Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) walkable[gy * GRID_W + gx] = Number(canStand(state, gx * CELL + CELL / 2, gy * CELL + CELL / 2));
  const previous = new Int32Array(GRID_W * GRID_H), visited = new Uint32Array(GRID_W * GRID_H), queue = new Int32Array(GRID_W * GRID_H);
  let stamp = 0;
  const search = <T>(goal: (point: Vec, index: number) => T | null | false): Route<T> | null => {
    const start = Math.floor(state.player.y / CELL) * GRID_W + Math.floor(state.player.x / CELL);
    if (++stamp >= 0xffffffff) { visited.fill(0); stamp = 1; }
    let head = 0, tail = 1; queue[0] = start; previous[start] = -1; visited[start] = stamp;
    while (head < tail) {
      const index = queue[head++], gx = index % GRID_W, gy = Math.floor(index / GRID_W);
      const point = { x: gx * CELL + CELL / 2, y: gy * CELL + CELL / 2 };
      const found = goal(point, index);
      if (found) {
        const path = [];
        for (let cursor = index; cursor !== -1; cursor = previous[cursor]) path.push({ x: cursor % GRID_W * CELL + CELL / 2, y: Math.floor(cursor / GRID_W) * CELL + CELL / 2 });
        path.reverse(); if (!walkable[start]) path.shift(); return { path, found };
      }
      for (const direction of DIRECTIONS) {
        const nx = gx + direction.x, ny = gy + direction.y, next = ny * GRID_W + nx;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H || !walkable[next] || visited[next] === stamp) continue;
        visited[next] = stamp; previous[next] = index; queue[tail++] = next;
      }
    }
    return null;
  };
  search.walkable = walkable;
  return search;
}

function cleanerTarget(state: GameState, point: Vec): DustTarget | null {
  const radius = TOOLS[state.player.tool].radius;
  const offset = 20;
  const maximum = radius + offset - 0.2;
  const minimum = Math.max(0, offset - radius + 0.2);
  let best = null;
  let bestDistance = Infinity;
  for (let gy = Math.max(0, Math.floor((point.y - maximum) / CELL)); gy <= Math.min(GRID_H - 1, Math.floor((point.y + maximum) / CELL)); gy++) {
    for (let gx = Math.max(0, Math.floor((point.x - maximum) / CELL)); gx <= Math.min(GRID_W - 1, Math.floor((point.x + maximum) / CELL)); gx++) {
      const index = gy * GRID_W + gx;
      if (!state.dust[index]) continue;
      const target = { x: gx * CELL + CELL / 2, y: gy * CELL + CELL / 2, index };
      const range = distance(point, target);
      if (range < minimum || range > maximum || range >= bestDistance) continue;
      best = target;
      bestDistance = range;
    }
  }
  return best;
}

export function createPilot(state: GameState, initialStation: Building): Pilot {
  const findPath = navigator(state);
  return {
    state, findPath, station: initialStation, path: [], target: null, returning: false, atDelivery: false, stalled: 0, deliveries: 0, carRecovery: 0, carRecoverySteer: 0,
    metrics: { gatherSeconds: 0, returnTravelSeconds: 0, depositSeconds: 0, blockedDepositSeconds: 0, productionIdleSeconds: 0, forcedTravelSeconds: 0, forcedWaitSeconds: 0, vehicleRecoveries: 0, fullBagTrips: 0, stationVisits: 0, unloadedUnits: 0 },
  };
}

export function metricsSnapshot(controller: Pilot, before: Partial<MetricsSnapshot> | null = null): MetricsSnapshot {
  const values = Object.fromEntries(Object.entries(controller.metrics).map(([key, value]) => [key, round(value - (before?.[key as keyof PilotMetrics] ?? 0))])) as unknown as PilotMetrics;
  const active = values.gatherSeconds + values.returnTravelSeconds;
  return { ...values, unloadActions: controller.deliveries - (before?.unloadActions ?? 0), returnTravelPercentOfGatherAndTravel: active > 0 ? round(values.returnTravelSeconds / active * 100) : 0 };
}

function driveCar(controller: Pilot, forcedDestination: Vec | null, forcedReach: number) {
  const state = controller.state, player = state.player, vehicle = engine.getVehicle(state)!, config = VEHICLES[vehicle.kind];
  if (controller.carRecovery > 0) {
    controller.carRecovery -= DT; controller.metrics.forcedTravelSeconds += DT;
    engine.updateGame(state, DT, { dx: controller.carRecoverySteer, dy: 1, clean: false });
    if (controller.carRecovery <= 0) { controller.path = []; controller.target = null; }
    return;
  }
  if (!forcedDestination && !controller.returning && player.bag >= engine.getCapacity(state)) { controller.returning = true; controller.metrics.fullBagTrips++; }
  const destination = forcedDestination ?? (controller.returning ? position(controller.station) : null);
  let clean = !destination;
  if (destination && distance(player, destination) < (forcedDestination ? Math.max(24, forcedReach) : 42)) {
    if (!controller.atDelivery) { controller.metrics.stationVisits++; controller.atDelivery = true; }
    const beforeBag = player.bag;
    if (player.bag > 0 || engine.getNearestTerminal(state) && Object.values(state.recovered).some(Boolean)) {
      const delivered = engine.interact(state); if (delivered.ok) controller.deliveries++;
    }
    controller.metrics.unloadedUnits += beforeBag - player.bag;
    if (beforeBag > player.bag) controller.metrics.depositSeconds += DT;
    else if (beforeBag) controller.metrics.blockedDepositSeconds += DT;
    else controller.metrics.forcedWaitSeconds += DT;
    if (!forcedDestination && player.bag === 0) controller.returning = false;
    controller.path = []; controller.target = null; engine.updateGame(state, DT, idle); return;
  }
  if (destination) {
    if (!controller.target || distance(controller.target, destination) > 30 || !controller.path.length) {
      const route = controller.findPath(point => distance(point, destination) < 20);
      if (!route) throw Error(`No car route to ${JSON.stringify(destination)}`);
      controller.path = route.path; controller.target = destination;
    }
  } else {
    controller.atDelivery = false;
    if (!controller.target || (controller.target.index === undefined || !state.dust[controller.target.index]) || !controller.path.length || distance(player, controller.target) < 30) {
      const route = controller.findPath((point, index) => state.dust[index] > 0 && distance(point, player) > 60 ? { ...point, index } : null);
      controller.path = route?.path ?? []; controller.target = route?.found ?? null;
    }
    if (!controller.target) {
      if (player.bag) controller.returning = true;
      else controller.metrics.productionIdleSeconds += DT;
      engine.updateGame(state, DT, idle); return;
    }
  }
  let closest = 0;
  for (let i = 1; i < Math.min(16, controller.path.length); i++) if (distance(player, controller.path[i]) < distance(player, controller.path[closest])) closest = i;
  if (closest) controller.path.splice(0, closest);
  while (controller.path.length > 1 && distance(player, controller.path[0]) < 30) controller.path.shift();
  const lookahead = vehicle.kind === 'vehicle' ? 60 : 48;
  let next = controller.path[0] ?? controller.target;
  const clear = (target: Vec) => {
    const length = distance(player, target), steps = Math.max(1, Math.ceil(length / 4));
    for (let i = 1; i <= steps; i++) {
      const x = player.x + (target.x - player.x) * i / steps, y = player.y + (target.y - player.y) * i / steps;
      if (!controller.findPath.walkable[Math.floor(y / CELL) * GRID_W + Math.floor(x / CELL)]) return false;
    }
    return true;
  };
  for (const point of controller.path) { if (!clear(point)) break; next = point; if (distance(player, point) >= lookahead) break; }
  const desired = Math.atan2(next.y - player.y, next.x - player.x);
  const error = Math.atan2(Math.sin(desired - vehicle.heading), Math.cos(desired - vehicle.heading));
  const steer = Math.max(-1, Math.min(1, error * 3));
  const limit = clean ? config.cleanSpeed : config.speed;
  let speed = Math.abs(error) > 1 ? 22 : Math.abs(error) > .5 ? Math.min(45, limit) : limit;
  if (destination && distance(player, destination) < 120) speed = Math.min(speed, 32);
  const before = { x: player.x, y: player.y };
  engine.updateGame(state, DT, { dx: steer, dy: -speed / limit, clean });
  if (forcedDestination) controller.metrics.forcedTravelSeconds += DT;
  else if (controller.returning) controller.metrics.returnTravelSeconds += DT;
  else controller.metrics.gatherSeconds += DT;
  if (distance(before, player) < .05) controller.stalled += DT; else controller.stalled = 0;
  if (controller.stalled > .8) {
    controller.carRecovery = 1; controller.carRecoverySteer = -Math.sign(error || 1); controller.stalled = 0; controller.metrics.vehicleRecoveries++;
    if (controller.metrics.vehicleRecoveries > 300) throw Error(`Car navigation could not recover near ${player.x},${player.y}`);
  }
}

export function drivePilot(controller: Pilot, forcedDestination: Vec | null = null, forcedReach = 24): void {
  const state = controller.state;
  const player = state.player;
  if (player.riding) return driveCar(controller, forcedDestination, forcedReach);
  if (!forcedDestination && !controller.returning && player.bag === 0 && state.cleaned >= state.totalDirt) {
    controller.metrics.productionIdleSeconds += DT;
    engine.updateGame(state, DT, idle);
    return;
  }
  let aim = null;
  let clean = !forcedDestination;
  if (forcedDestination || controller.returning || player.bag >= engine.getCapacity(state)) {
    if (!forcedDestination && !controller.returning && player.bag >= engine.getCapacity(state)) controller.metrics.fullBagTrips++;
    controller.returning = !forcedDestination;
    const destination = forcedDestination ?? position(controller.station);
    if (distance(player, destination) < (forcedDestination ? forcedReach : 24)) {
      if (!controller.atDelivery) { controller.metrics.stationVisits++; controller.atDelivery = true; }
      const beforeBag = player.bag;
      if (player.bag > 0 || engine.getNearestTerminal(state) && Object.values(state.recovered).some(Boolean)) {
        const delivered = engine.interact(state);
        if (delivered.ok) controller.deliveries++;
      }
      const unloaded = beforeBag - player.bag;
      controller.metrics.unloadedUnits += unloaded;
      if (unloaded > 0) controller.metrics.depositSeconds += DT;
      else if (beforeBag > 0) controller.metrics.blockedDepositSeconds += DT;
      else controller.metrics.forcedWaitSeconds += DT;
      if (!forcedDestination && player.bag === 0) controller.returning = false;
      controller.path = [];
      controller.target = null;
      engine.updateGame(state, DT, idle);
      return;
    }
    if (!controller.target || distance(controller.target, destination) > 30 || controller.path.length === 0) {
      const route = controller.findPath(point => distance(point, destination) < (forcedDestination ? forcedReach : 20));
      if(!route) throw Error(`No navigable path to ${JSON.stringify(destination)}`);
      controller.path = route?.path ?? [];
      controller.target = destination;
    }
    clean = false;
  } else {
    controller.atDelivery = false;
    const nearby = cleanerTarget(state, player);
    if (nearby) {
      controller.path = [];
      controller.target = nearby;
      aim = nearby;
    } else {
      if (!controller.target || (controller.target.index === undefined || state.dust[controller.target.index] === 0) || controller.path.length === 0) {
        const route = controller.findPath(point => cleanerTarget(state, point));
        controller.path = route?.path ?? [];
        controller.target = route?.found ?? null;
      }
      aim = controller.target;
      if (!aim && player.bag > 0) { controller.returning = true; controller.path = []; }
    }
  }
  while (controller.path.length && distance(player, controller.path[0]) < 0.01) controller.path.shift();
  const next = controller.path[0];
  const range = next ? distance(player, next) : 0;
  const dt = next ? Math.min(DT, range / engine.getSpeed(state)) : DT;
  if (forcedDestination) controller.metrics.forcedTravelSeconds += dt;
  else if (!clean) controller.metrics.returnTravelSeconds += dt;
  else controller.metrics.gatherSeconds += dt;
  const before = { x: player.x, y: player.y };
  engine.updateGame(state, Math.max(0.00001, dt), { dx: next ? next.x - player.x : 0, dy: next ? next.y - player.y : 0, clean, ...(aim ? { aimX: aim.x, aimY: aim.y } : {}) });
  if (next && distance(before, player) < 0.001) controller.stalled += dt;
  else controller.stalled = 0;
  if (controller.stalled > 3) throw Error(`Player navigation stalled at ${player.x},${player.y} toward ${JSON.stringify(next)}`);
}

export interface ProgressionReplayOptions { parallelFactories?: 1 | 2; layoutStrategy?: 'parallel' | 'network'; maxSeconds?: number; stopAtFirstPro?: boolean; safeHandoff?: boolean; robotFleet?: Partial<Record<RobotKind, number>> }
export type ProgressionMilestone = { id: string } & ReturnType<typeof progressionSnapshot>;
export interface ProgressionReplay {
  state: GameState; readonly done: boolean; readonly goal: string | null; readonly frames: number;
  readonly lastBlockedReason: string; milestones: ProgressionMilestone[];
  step(): void; metricsSnapshot(): MetricsSnapshot;
}
/** Only engine actions mutate the fresh world. Planning never finances or rewrites progress. */
export function createProgressionReplay(seed: number, options: ProgressionReplayOptions = {}): ProgressionReplay {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('Invalid replay seed.');
  const parallelFactories = options.parallelFactories ?? 2, maxSeconds = options.maxSeconds ?? 75 * 60;
  const stopAtFirstPro = options.stopAtFirstPro ?? false;
  const network = options.layoutStrategy === 'network';
  const fleet = { robot: 1, industrialRobot: 1, ...options.robotFleet };
  if (![1, 2].includes(parallelFactories) || !Number.isFinite(maxSeconds) || maxSeconds <= 0) throw Error('Invalid replay options.');
  if (Object.values(fleet).some(count => !Number.isInteger(count) || count < 1)
    || fleet.robot + fleet.industrialRobot > ECONOMY.maxRobots) throw Error('Invalid replay robot fleet.');
  const state = engine.createGame(seed), controller = createPilot(state, state.buildings.find(b => b.kind === 'uplink')!);
  const { analysisLayout, secondLayout, analysisAnchor, secondAnchor } = progressionLayouts();
  type Goal = [string, 'upgrade' | 'factory' | 'capacity' | 'speed' | 'network' | 'handoff'];
  const goals: Goal[] = [
    ['handbrush', 'upgrade'], ['analysis', 'factory'], ['capacity1', 'capacity'], ['robot', 'upgrade'],
    ['compact', 'upgrade'], ['broom', 'upgrade'], ['capacity2', 'capacity'], ['speed1', 'speed'],
    ...(parallelFactories === 2 ? [['analysis2', 'factory'] as Goal] : []),
    ['tester', 'factory'], ...(parallelFactories === 2 ? [['tester2', 'factory'] as Goal] : []),
    ...(network ? [['frontierNetwork', 'network'] as Goal] : []),
    ['widebrush', 'upgrade'], ['vehicle', 'upgrade'], ['industrialRobot', 'upgrade'],
    ...Array.from({ length: fleet.robot - 1 }, (_, index) => [`robot${index + 2}`, 'upgrade'] as Goal),
    ...Array.from({ length: fleet.industrialRobot - 1 }, (_, index) => [`industrialRobot${index + 2}`, 'upgrade'] as Goal),
    ...(options.safeHandoff ? [['handoff', 'handoff'] as Goal] : []),
    ...(!stopAtFirstPro ? ECONOMY.capacity.slice(2).map((_, index) => [`capacity${index + 3}`, 'capacity'] as Goal) : []),
    ...(!stopAtFirstPro ? ECONOMY.speed.slice(1).map((_, index) => [`speed${index + 2}`, 'speed'] as Goal) : []),
  ];
  const milestones: ProgressionMilestone[] = [];
  let goalIndex = 0, frames = 0, lastBlockedReason = '', lastProgressTime = state.time, progressSignature = '';
  let frontier: BuildPlan | null = null, frontierIndex = 0, frontierStarted = false, frontierPrimed = 0;
  let handoffStation: Building | null = null;
  const done = () => goalIndex >= goals.length;
  return {
    state, milestones, get done() { return done(); }, get goal() { return goals[goalIndex]?.[0] ?? null; },
    get frames() { return frames; }, get lastBlockedReason() { return lastBlockedReason; },
    metricsSnapshot: () => metricsSnapshot(controller),
    step() {
      if (done()) return;
      if (state.time >= maxSeconds) throw Error(`Replay exceeded its time budget before ${goals[goalIndex][0]}.`);
      const [id, kind] = goals[goalIndex];
      let forcedDestination: Vec | null = null, forcedReach = 24, action: ActionResult | null = null;
      if (kind === 'handoff') {
        if (state.player.bag > 0) {
          handoffStation ??= state.buildings.filter(b => b.kind === 'receiver' && engine.getReceiverCapacity(state) - b.buffer >= state.player.bag)
            .sort((a,b) => distance(state.player,position(a))-distance(state.player,position(b)))[0]
            ?? state.buildings.filter(b => b.kind === 'uplink').sort((a,b) => distance(state.player,position(a))-distance(state.player,position(b)))[0];
          forcedDestination = position(handoffStation);
        } else if (state.player.riding && distance(state.player, replayParking) >= 24) {
          forcedDestination = replayParking;
        } else if (state.player.riding) {
          const exited = engine.toggleVehicle(state);
          if (!exited.ok) throw Error(`Could not park the replay vehicle: ${exited.message}`);
          controller.path = []; controller.target = null;
          forcedDestination = SPAWN;
        } else if (distance(state.player, SPAWN) >= 20) forcedDestination = SPAWN;
        else action = { ok: true, message: '' };
      } else if (kind === 'network') {
        frontier ??= createIndustrialNetworkPlan(state, { additionalReceiver: true }).plan;
        const budget = frontier.reduce((sum, [name]) => sum + BUILDINGS[name].price, 0);
        frontierStarted ||= state.credits >= budget;
        if (frontierStarted) {
          if (state.player.riding) {
            const exit = engine.toggleVehicle(state);
            if (!exit.ok) forcedDestination = position(controller.station);
            else { controller.path = []; controller.target = null; }
          }
          if (!state.player.riding) {
            if (frontierIndex < frontier.length) {
              const [name, gx, gy, dir] = frontier[frontierIndex], target = position({ gx, gy });
              if (distance(state.player, target) > 110) forcedDestination = target;
              else {
                const placed = engine.placeBuilding(state, name, gx, gy, dir);
                if (!placed.ok) throw Error(`Frontier construction failed: ${placed.message}`);
                frontierIndex++; forcedDestination = target;
                controller.path = []; controller.target = null;
              }
            } else {
              const [, gx, gy] = frontier[frontier.length - 1];
              controller.station = state.buildings.find(b => b.gx === gx && b.gy === gy)!;
              if (frontierPrimed >= 256) action = { ok: true, message: '' };
              else if (state.player.bag >= 256) forcedDestination = position(controller.station);
              // Actual hand cleaning supplies the first distant capsules. The
              // construction walk itself leaves the generated dust untouched.
            }
          }
        }
      } else if (kind === 'factory') {
        const isAnalysis = id.startsWith('analysis'), isSecond = id.endsWith('2');
        const plan = isSecond ? secondLayout : analysisLayout;
        const [, gx, gy, dir] = plan[4];
        const needed = isAnalysis ? plan.reduce((sum, [name]) => sum + BUILDINGS[name].price, 0) : BUILDINGS.tester.price;
        if (state.credits >= needed) {
          const anchor = isSecond ? secondAnchor : analysisAnchor;
          if (distance(state.player, anchor) > 24) forcedDestination = anchor;
          else if (isAnalysis) action = placePlan(state, plan);
          else {
            const oldBelt = state.buildings.find(b => b.gx === gx && b.gy === gy && b.kind === 'belt');
            const removed = oldBelt ? engine.removeBuilding(state, gx, gy) : { ok: true };
            if (removed.ok) action = placePlan(state, [['tester', gx, gy, dir]]);
          }
        }
      } else {
        const upgrade = (kind === 'capacity' || kind === 'speed' ? kind : id.startsWith('industrialRobot') ? 'industrialRobot' : id.startsWith('robot') ? 'robot' : id) as UpgradeId;
        const requirement = engine.getUpgradeRequirement(state, upgrade);
        if (requirement) lastBlockedReason = requirement;
        else if (state.credits >= engine.upgradePrice(state, upgrade)) {
          const station = ['compact', 'vehicle', 'robot', 'industrialRobot'].includes(upgrade) ? STATIONS.garage : STATIONS.workshop;
          if (distance(state.player, station) > 50) forcedDestination = station;
          else action = engine.buyUpgrade(state, upgrade);
        }
      }
      if (action?.ok) {
        milestones.push({ id, ...progressionSnapshot(state) }); goalIndex++; lastBlockedReason = '';
        if (id.startsWith('analysis')) controller.station = state.buildings.find(b => b.kind === 'receiver' && b.gx === analysisLayout[0][1] && b.gy === analysisLayout[0][2])!;
        controller.path = []; controller.target = null;
        if (stopAtFirstPro && id === 'industrialRobot' && !options.safeHandoff) { frames++; return; }
        if (id === 'handoff') { frames++; return; }
      } else if (action) lastBlockedReason = action.message;
      const desiredVehicle = state.vehicles.find(v => v.kind === 'vehicle') ?? state.vehicles[0];
      const buildingFrontier = kind === 'network' && frontierStarted && !action?.ok;
      if (kind !== 'handoff' && !buildingFrontier && desiredVehicle && (!state.player.riding || state.player.vehicleKind !== desiredVehicle.kind)) {
        if (state.player.riding && !engine.toggleVehicle(state).ok) forcedDestination = position(controller.station);
        if (!state.player.riding) {
          const nearest = [...state.vehicles].sort((a, b) => distance(state.player, a) - distance(state.player, b))[0];
          if (nearest === desiredVehicle && distance(state.player, desiredVehicle) < 60) engine.toggleVehicle(state);
          else { forcedDestination = desiredVehicle; forcedReach = 12; }
        }
      }
      if (kind !== 'handoff' && !buildingFrontier && !controller.returning) {
        const receiverPositions = [analysisLayout[0], ...(parallelFactories === 2 ? [secondLayout[0]] : [])];
        const candidates = state.buildings.filter(b => b.kind === 'receiver' && (network || receiverPositions.some(([, gx, gy]) => b.gx === gx && b.gy === gy)));
        if (candidates.length) controller.station = candidates.sort((a, b) => network
          ? distance(state.player, position(a)) + a.buffer / engine.getReceiverCapacity(state) * 240 - distance(state.player, position(b)) - b.buffer / engine.getReceiverCapacity(state) * 240
          : a.buffer - b.buffer || distance(state.player, position(a)) - distance(state.player, position(b)))[0];
      }
      const bagBefore = state.player.bag;
      drivePilot(controller, forcedDestination, forcedReach);
      if (buildingFrontier && frontier && frontierIndex === frontier.length && !state.player.riding) frontierPrimed += Math.max(0, bagBefore - state.player.bag);
      const currentProgress = `${goalIndex}:${state.cleaned}:${state.stats.delivered}:${state.earned}`;
      if (currentProgress !== progressSignature) { progressSignature = currentProgress; lastProgressTime = state.time; }
      else if (state.time - lastProgressTime > 180) throw Error(`Replay made no collection, sale or purchase progress for 180s toward ${goals[goalIndex]?.[0]}.`);
      if (++frames > 1000000) throw Error('Replay exceeded its navigation iteration limit.');
    },
  };
}
