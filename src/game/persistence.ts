import { BUILD_CELL, GRID_H, GRID_W, MATERIALS, PROCESSING, ROBOTS, STRUCTURES, TERMINALS, TOOLS, VEHICLES, WORLD_H, WORLD_W, type GameState } from './types';
export const SAVE_KEY = 'prod-sweepers:save:v1';
const record = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown, max = 1e12): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const integer = (v: unknown, max = 1e12): v is number => number(v, max) && Number.isInteger(v);
const list = (v: unknown): v is any[] => Array.isArray(v) && v.length <= GRID_W * GRID_H;
const point = (v: unknown) => record(v) && number(v.x, WORLD_W) && number(v.y, WORLD_H);
const gridPoint = (v: unknown) => record(v) && integer(v.gx, WORLD_W / BUILD_CELL - 1) && integer(v.gy, WORLD_H / BUILD_CELL - 1) && integer(v.dir, 3);
const strings = (v: unknown) => list(v) && v.every(x => typeof x === 'string' && x.length < 200);
const ownKey = <T extends object>(table: T, key: unknown): key is keyof T => typeof key === 'string' && Object.hasOwn(table, key);
function validRobot(robot: unknown) {
  return record(robot) && point(robot) && number(robot.bag) && number(robot.capacity) && robot.bag <= robot.capacity
    && ['cleaning', 'returning'].includes(robot.mode) && (robot.target === null || point(robot.target))
    && list(robot.path) && robot.path.every(p => point(p))
    && Number.isFinite(robot.timer) && robot.timer >= -1 && robot.timer <= 1e12 && number(robot.cleanAccumulator);
}
function validVehicle(vehicle: unknown) {
  if (!record(vehicle) || !point(vehicle) || !ownKey(VEHICLES, vehicle.kind)) return false;
  return Number.isFinite(vehicle.heading) && Number.isFinite(vehicle.speed) && Math.abs(vehicle.speed) <= VEHICLES[vehicle.kind].speed;
}
function validFleets(state: Record<string, any>) {
  if (!Array.isArray(state.vehicles) || state.vehicles.length > 2
    || !state.vehicles.every(validVehicle)
    || new Set(state.vehicles.map(v => v.kind)).size !== state.vehicles.length) return false;
  if (!Array.isArray(state.robots) || state.robots.length > 5 || !state.robots.every(r => validRobot(r) && ownKey(ROBOTS, r.kind) && integer(r.id) && r.id < state.nextId)
    || new Set(state.robots.map(r => r.id)).size !== state.robots.length) return false;
  const selected = state.player.vehicleKind;
  return state.player.riding ? ownKey(VEHICLES, selected) && state.vehicles.some(v => v.kind === selected) : selected === null;
}
function validProduction(building: Record<string, any>) {
  if (!number(building.outputBuffer)) return false;
  if (!ownKey(PROCESSING, building.kind)) {
    return building.processing === null && building.outputBuffer === 0 && (building.kind === 'receiver' || building.buffer === 0);
  }
  if (building.processing === null) return true;
  const recipe = PROCESSING[building.kind], job = building.processing;
  return record(job) && integer(job.units, recipe.batch) && job.units > 0 && number(job.remaining, recipe.cycle);
}
export function serializeGame(state: GameState): string {
  return JSON.stringify({ ...state, events: [] });
}
export function deserializeGame(raw: string | null): GameState | null {
  if (!raw || raw.length > 4_000_000) return null;
  try {
    const s = JSON.parse(raw);
    if (!record(s) || s.version !== 5 || !integer(s.seed, 0xffffffff) || !number(s.time)) return null;
    const p = s.player;
    if (!record(p) || !point(p) || !number(p.bag) || !integer(p.capacityLevel, 3) || !integer(p.speedLevel, 2)
      || typeof p.riding !== 'boolean' || !ownKey(TOOLS, p.tool) || !Number.isFinite(p.facingX) || !Number.isFinite(p.facingY)) return null;
    if (!list(s.dust) || s.dust.length !== GRID_W * GRID_H || !s.dust.every(v => integer(v, 8))) return null;
    if (![s.credits, s.earned, s.totalDirt, s.cleaned, s.cleanAccumulator].every(v => number(v)) || !integer(s.nextId)) return null;
    if (s.cleaned + s.dust.reduce((a: number, b: number) => a + b, 0) !== s.totalDirt) return null;
    if (!strings(s.ownedTools) || !s.ownedTools.every((t: string) => ownKey(TOOLS, t)) || !s.ownedTools.includes(p.tool)) return null;
    if (!list(s.buildings) || !s.buildings.every(b => gridPoint(b) && ownKey(STRUCTURES, b.kind) && integer(b.id) && number(b.buffer) && number(b.cooldown)
      && (!Object.hasOwn(b, 'outputCursor') || integer(b.outputCursor, 3)))) return null;
    if (new Set(s.buildings.map(b => `${b.gx},${b.gy}`)).size !== s.buildings.length) return null;
    if (!list(s.capsules) || !s.capsules.every(c => gridPoint(c) && integer(c.id) && number(c.units) && c.units > 0 && number(c.progress, 1)
      && (!Object.hasOwn(c, 'from') || integer(c.from, 3)))) return null;
    if (!list(s.obstacles) || !s.obstacles.every(o => point(o) && number(o.w, WORLD_W) && number(o.h, WORLD_H) && ['rock', 'tree', 'server', 'water'].includes(o.kind))) return null;
    if (!list(s.landmarks) || !s.landmarks.every(l => point(l) && typeof l.name === 'string' && typeof l.id === 'string' && typeof l.color === 'string')) return null;
    if (!strings(s.discoveries) || !strings(s.milestones) || typeof s.completed !== 'boolean') return null;
    if (Object.hasOwn(s, 'vehicle') || Object.hasOwn(s, 'robot') || !validFleets(s)) return null;
    const terminals = s.buildings.filter((b: Record<string, any>) => b.kind === 'uplink');
    if (terminals.length !== TERMINALS.length || !TERMINALS.every(t => terminals.some(b => b.gx === Math.floor(t.x / BUILD_CELL)
      && b.gy === Math.floor(t.y / BUILD_CELL) && b.starter === true))) return null;
    if (!s.buildings.every(validProduction) || !s.capsules.every((c: Record<string, any>) => ownKey(MATERIALS, c.material))) return null;
    if (!record(s.stats) || !['delivered', 'capsules', 'built', 'robotCleaned', 'distance', 'processed', 'tested', 'rawSold', 'reportsSold', 'testsSold'].every(k => number(s.stats[k]))) return null;
    if (!number(s.stats.rawReclaimed, s.stats.rawSold)) return null;
    if (!record(s.recovered) || Object.keys(s.recovered).length !== 3
      || !Object.keys(MATERIALS).every(material => number(s.recovered[material]))) return null;
    s.events = [];
    return s as unknown as GameState;
  } catch { return null; }
}
export function saveToStorage(storage: Pick<Storage, 'setItem'>, state: GameState): boolean {
  try { storage.setItem(SAVE_KEY, serializeGame(state)); return true; } catch { return false; }
}
export function loadFromStorage(storage: Pick<Storage, 'getItem'>): GameState | null {
  try { return deserializeGame(storage.getItem(SAVE_KEY)); } catch { return null; }
}
