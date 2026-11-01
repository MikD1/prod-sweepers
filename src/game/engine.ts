import {
  BUILDINGS, BUILD_CELL, CELL, DIRECTIONS, ECONOMY, GRID_H, GRID_W, HUB, LOGISTICS, MATERIALS, PROCESSING, RECEIVER_CAPACITY, ROBOTS, SPAWN, STATIONS, STRUCTURES, TERMINALS, TOOLS, VEHICLES, WORLD_H, WORLD_W,
  type ActionResult, type BuildKind, type Building, type Capsule, type Direction, type GameEvent,
  type GameInput, type GameState, type MaterialKind, type Obstacle, type Robot, type StationKind, type StructureKind, type ToolId, type UpgradeId, type Vec, type Vehicle,
} from './types';
import { buildWalkability, generateWorld } from './world';

const PLAYER_RADIUS = 8;
const TOOL_ORDER: ToolId[] = ['toothbrush', 'handbrush', 'broom', 'widebrush'];
const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const buildingPosition = (b: Pick<Building, 'gx' | 'gy'>): Vec => ({ x: b.gx * BUILD_CELL + 12, y: b.gy * BUILD_CELL + 12 });
const result = (ok: boolean, message: string): ActionResult => ({ ok, message });

export function getNearbyStation(state: GameState): StationKind | null {
  const stations = Object.keys(STATIONS) as StationKind[];
  return stations.find(kind => distance(state.player, STATIONS[kind]) <= 64) ?? null;
}

export function getVehicle(state: GameState): Vehicle | null {
  return state.player.riding ? state.vehicles.find(vehicle => vehicle.kind === state.player.vehicleKind) ?? null : null;
}

// Scene arrays change on load/reset; a changed length also invalidates test/editor additions.
// Buckets keep movement local while reusable raster/scratch arrays make fleet BFS inexpensive.
const BUCKET_SIZE = 96;
interface Navigation {
  count: number;
  buckets: Map<string, Obstacle[]>;
  walkable: Uint8Array;
  previous: Int32Array;
  visited: Uint32Array;
  queue: Int32Array;
  stamp: number;
}
const navigationCache = new WeakMap<Obstacle[], Navigation>();
function navigation(state: Pick<GameState, 'obstacles'>): Navigation {
  const existing = navigationCache.get(state.obstacles);
  if (existing && existing.count === state.obstacles.length) return existing;
  const buckets = new Map<string, Obstacle[]>();
  for (const obstacle of state.obstacles) {
    for (let y = Math.floor(obstacle.y / BUCKET_SIZE); y <= Math.floor((obstacle.y + obstacle.h) / BUCKET_SIZE); y++) {
      for (let x = Math.floor(obstacle.x / BUCKET_SIZE); x <= Math.floor((obstacle.x + obstacle.w) / BUCKET_SIZE); x++) {
        const key = `${x},${y}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(obstacle); buckets.set(key, bucket);
      }
    }
  }
  const count = GRID_W * GRID_H;
  const cache = { count: state.obstacles.length, buckets, walkable: buildWalkability(state.obstacles), previous: new Int32Array(count), visited: new Uint32Array(count), queue: new Int32Array(count), stamp: 0 };
  navigationCache.set(state.obstacles, cache);
  return cache;
}

function collides(obstacle: Obstacle, x: number, y: number, radius: number) {
  const nearX = Math.max(obstacle.x, Math.min(x, obstacle.x + obstacle.w));
  const nearY = Math.max(obstacle.y, Math.min(y, obstacle.y + obstacle.h));
  return Math.hypot(x - nearX, y - nearY) < radius;
}

function canStand(state: Pick<GameState, 'obstacles'>, x: number, y: number, radius = PLAYER_RADIUS) {
  if (x < radius || y < radius || x > WORLD_W - radius || y > WORLD_H - radius) return false;
  const { buckets } = navigation(state);
  for (let by = Math.floor((y - radius) / BUCKET_SIZE); by <= Math.floor((y + radius) / BUCKET_SIZE); by++) {
    for (let bx = Math.floor((x - radius) / BUCKET_SIZE); bx <= Math.floor((x + radius) / BUCKET_SIZE); bx++) {
      if (buckets.get(`${bx},${by}`)?.some(obstacle => collides(obstacle, x, y, radius))) return false;
    }
  }
  return true;
}

function move(state: GameState, actor: Vec, dx: number, dy: number) {
  // Small independent axis steps allow sliding along scenery without tunnelling.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 4));
  for (let step = 0; step < steps; step++) {
    const x = Math.max(PLAYER_RADIUS, Math.min(WORLD_W - PLAYER_RADIUS, actor.x + dx / steps));
    const y = Math.max(PLAYER_RADIUS, Math.min(WORLD_H - PLAYER_RADIUS, actor.y + dy / steps));
    if (canStand(state, x, actor.y)) actor.x = x;
    if (canStand(state, actor.x, y)) actor.y = y;
  }
}

function event(state: GameState, kind: GameEvent['kind'], position: Vec, text: string, amount?: number) {
  state.events.push({ id: state.nextId++, kind, x: position.x, y: position.y, text, amount, time: state.time });
  if (state.events.length > 90) state.events.splice(0, state.events.length - 90);
}

function pay(state: GameState, units: number, position: Vec, material: MaterialKind = 'raw') {
  const credits = units * MATERIALS[material].value;
  state.credits += credits;
  state.earned += credits;
  state.stats.delivered += units;
  if (material === 'raw') state.stats.rawSold += units;
  else if (material === 'report') state.stats.reportsSold += units;
  else state.stats.testsSold += units;
  if (units > 0) event(state, 'credit', position, `+${credits} ¤`, credits);
}

/** Search uses the movement collision radius; all persistent paths remain plain JSON. */
function findPath(state: GameState, start: Vec, isGoal: (index: number, position: Vec) => boolean): Vec[] | null {
  const startX = Math.max(0, Math.min(GRID_W - 1, Math.floor(start.x / CELL)));
  const startY = Math.max(0, Math.min(GRID_H - 1, Math.floor(start.y / CELL)));
  const startIndex = startY * GRID_W + startX;
  const cache = navigation(state);
  const { previous, queue, visited, walkable } = cache;
  if (++cache.stamp >= 0xffffffff) { visited.fill(0); cache.stamp = 1; }
  const stamp = cache.stamp;
  let head = 0;
  let tail = 1;
  queue[0] = startIndex;
  previous[startIndex] = -1;
  visited[startIndex] = stamp;
  while (head < tail) {
    const index = queue[head++];
    const gx = index % GRID_W;
    const gy = Math.floor(index / GRID_W);
    const position = { x: gx * CELL + 6, y: gy * CELL + 6 };
    if (isGoal(index, position)) {
      const path: Vec[] = [];
      let cursor = index;
      while (cursor !== -1) {
        path.push({ x: (cursor % GRID_W) * CELL + 6, y: Math.floor(cursor / GRID_W) * CELL + 6 });
        cursor = previous[cursor];
      }
      path.reverse();
      // An actor can stand beside a wall while its containing cell center lies inside it.
      if (!canStand(state, path[0].x, path[0].y)) path.shift();
      return path;
    }
    for (const direction of DIRECTIONS) {
      const nx = gx + direction.x;
      const ny = gy + direction.y;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      const next = ny * GRID_W + nx;
      if (visited[next] === stamp || !walkable[next]) continue;
      visited[next] = stamp;
      previous[next] = index;
      queue[tail++] = next;
    }
  }
  return null;
}

export function createGame(seed = 42): GameState {
  return {
    version: 5, seed, time: 0,
    player: { ...SPAWN, facingX: 0, facingY: 1, tool: 'toothbrush', bag: 0, capacityLevel: 0, speedLevel: 0, riding: false, vehicleKind: null },
    credits: 0, earned: 0, ...generateWorld(seed), cleaned: 0,
    ownedTools: ['toothbrush'], vehicles: [], robots: [],
    buildings: TERMINALS.map((terminal, index) => ({ id: index + 5, kind: 'uplink', gx: Math.floor(terminal.x / BUILD_CELL), gy: Math.floor(terminal.y / BUILD_CELL), dir: 0, outputCursor: 0, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0, starter: true })),
    capsules: [], recovered: { raw: 0, report: 0, test: 0 }, discoveries: [], milestones: [], events: [], nextId: 9, cleanAccumulator: 0,
    stats: { delivered: 0, capsules: 0, built: 0, robotCleaned: 0, distance: 0, processed: 0, tested: 0, rawSold: 0, reportsSold: 0, testsSold: 0, rawReclaimed: 0 }, completed: false,
  };
}

function capacityMultiplier(state: GameState): number {
  return ECONOMY.capacityMultipliers[Math.max(0, Math.min(3, Math.floor(state.player.capacityLevel)))];
}

export function getWalkingCapacity(state: GameState): number {
  const base = state.ownedTools.reduce((largest, tool) => Math.max(largest, TOOLS[tool].capacity), TOOLS.toothbrush.capacity);
  return Math.floor(base * capacityMultiplier(state));
}

export function getCapacity(state: GameState): number {
  const vehicle = getVehicle(state);
  return vehicle ? Math.floor(VEHICLES[vehicle.kind].capacity * capacityMultiplier(state)) : getWalkingCapacity(state);
}

export function getSpeed(state: GameState, cleaning = false): number {
  const vehicle = getVehicle(state);
  return vehicle ? VEHICLES[vehicle.kind][cleaning ? 'cleanSpeed' : 'speed'] : 110 + state.player.speedLevel * 24;
}

export function getReceiverCapacity(state: GameState): number {
  return RECEIVER_CAPACITY * 2 ** Math.max(0, Math.min(3, state.player.capacityLevel));
}

function ownsAtLeast(state: GameState, tool: ToolId): boolean {
  const rank = TOOL_ORDER.indexOf(tool);
  return state.ownedTools.some(owned => TOOL_ORDER.indexOf(owned) >= rank);
}

export function getUpgradeRequirement(state: GameState, id: UpgradeId): string | null {
  if ((id === 'vehicle' || id === 'compact') && state.vehicles.some(vehicle => vehicle.kind === id)
    || TOOL_ORDER.includes(id as ToolId) && state.ownedTools.includes(id as ToolId)) return null;
  if (id === 'broom' && !ownsAtLeast(state, 'handbrush')) return `Сначала купите ${TOOLS.handbrush.name}.`;
  if (id === 'widebrush' && !ownsAtLeast(state, 'broom')) return `Сначала купите ${TOOLS.broom.name}.`;
  if (id === 'capacity' && state.player.capacityLevel === 1 && !ownsAtLeast(state, 'broom')) return `Нужна ${TOOLS.broom.name}.`;
  if (id === 'capacity' && state.player.capacityLevel === 2 && !ownsAtLeast(state, 'widebrush')) return `Нужна ${TOOLS.widebrush.name}.`;
  if (id === 'speed' && state.player.speedLevel === 1 && !ownsAtLeast(state, 'broom')) return `Нужна ${TOOLS.broom.name}.`;
  const sold = state.stats.reportsSold + state.stats.testsSold;
  if (id === 'compact') {
    if (!ownsAtLeast(state, 'handbrush')) return `Нужна ${TOOLS.handbrush.name}.`;
    if (state.player.capacityLevel < 1) return 'Нужны контейнеры I.';
    if (sold < ECONOMY.compactReports) return `Продайте отчёты или автотесты: ${sold}/${ECONOMY.compactReports}.`;
  }
  if (id === 'vehicle') {
    if (!ownsAtLeast(state, 'broom')) return `Нужна ${TOOLS.broom.name}.`;
    if (state.player.capacityLevel < 2) return 'Нужны контейнеры II: купите второй уровень вместимости.';
    if (state.stats.testsSold < ECONOMY.vehicleTests) return `Продайте автотесты: ${state.stats.testsSold}/${ECONOMY.vehicleTests}.`;
  }
  if (id === 'robot') {
    if (!ownsAtLeast(state, 'handbrush')) return `Нужна ${TOOLS.handbrush.name}.`;
    if (sold < ECONOMY.robotReports) return `Продайте отчёты или автотесты: ${sold}/${ECONOMY.robotReports}.`;
    if (!state.buildings.some(building => building.kind === 'receiver' && receiverHasRoute(state, building))) return 'Нужен приёмник с линией до терминала.';
  }
  if (id === 'industrialRobot') {
    if (!state.vehicles.some(vehicle => vehicle.kind === 'vehicle')) return 'Сначала купите уборочную машину.';
    if (state.stats.testsSold < ECONOMY.robotTests) return `Продайте автотесты: ${state.stats.testsSold}/${ECONOMY.robotTests}.`;
  }
  return null;
}

export function getBuildRequirement(state: GameState, kind: BuildKind): string | null {
  if (kind === 'analyzer' && !ownsAtLeast(state, 'handbrush')) return `Нужна ${TOOLS.handbrush.name}.`;
  if (kind === 'tester') {
    const sold = state.stats.reportsSold + state.stats.testsSold;
    if (sold < ECONOMY.testerReports) return `Продайте отчёты или автотесты: ${sold}/${ECONOMY.testerReports}.`;
  }
  return null;
}

export function upgradePrice(state: GameState, id: UpgradeId): number {
  if (id === 'capacity') return ECONOMY.capacity[state.player.capacityLevel] ?? Infinity;
  if (id === 'speed') return ECONOMY.speed[state.player.speedLevel] ?? Infinity;
  if (id === 'vehicle' || id === 'compact') return state.vehicles.some(vehicle => vehicle.kind === id) ? Infinity : VEHICLES[id].price;
  if (id === 'robot' || id === 'industrialRobot') {
    if (state.robots.length >= ECONOMY.maxRobots
      && !(id === 'industrialRobot' && state.robots.some(robot => robot.kind === 'robot'))) return Infinity;
    const count = state.robots.filter(robot => robot.kind === id).length;
    return Math.round(ROBOTS[id].price * ECONOMY.robotPriceMultiplier ** count / 100) * 100;
  }
  return state.ownedTools.includes(id) ? Infinity : TOOLS[id].price;
}

function garageParking(state: GameState): Vec | null {
  const center = STATIONS.garage;
  for (const radius of [34, 64, 94]) {
    for (let index = 0; index < 12; index++) {
      const angle = Math.PI / 4 + index * Math.PI / 6;
      const position = { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
      if (canStand(state, position.x, position.y) && state.vehicles.every(vehicle => distance(vehicle, position) >= 28)) return position;
    }
  }
  return null;
}

export function buyUpgrade(state: GameState, id: UpgradeId): ActionResult {
  const price = upgradePrice(state, id);
  if (!Number.isFinite(price)) return result(false, 'Уже куплено или достигнут максимум.');
  const requirement = getUpgradeRequirement(state, id);
  if (requirement) return result(false, requirement);
  const station = ['compact', 'vehicle', 'robot', 'industrialRobot'].includes(id) ? 'garage' : 'workshop';
  if (getNearbyStation(state) !== station) return result(false, `Покупка доступна рядом: ${STATIONS[station].name}.`);
  if (state.credits < price) return result(false, `Нужно ещё ${price - state.credits} ¤.`);
  const parking = id === 'compact' || id === 'vehicle' ? garageParking(state) : null;
  if ((id === 'compact' || id === 'vehicle') && !parking) return result(false, 'Нет свободного места у гаража.');
  state.credits -= price;
  let name: string;
  if (id === 'capacity') {
    state.player.capacityLevel++;
    name = `Контейнеры: +50% базовой вместимости за уровень. Рюкзак: ${getWalkingCapacity(state)}, приёмники: ${getReceiverCapacity(state)} багов.`;
  } else if (id === 'speed') {
    state.player.speedLevel++;
    name = 'Скорость увеличена';
  } else if (id === 'vehicle' || id === 'compact') {
    state.vehicles.push({ kind: id, ...parking!, heading: Math.PI / 2, speed: 0 });
    name = `${VEHICLES[id].name} ждёт у базы, возле гаража. Подойди и нажми V.`;
  } else if (id === 'robot' || id === 'industrialRobot') {
    const config = ROBOTS[id];
    const replacement = id === 'industrialRobot' && state.robots.length >= ECONOMY.maxRobots ? state.robots.find(robot => robot.kind === 'robot') : undefined;
    if (replacement) {
      replacement.kind = id; replacement.capacity = Math.max(replacement.capacity, config.capacity);
      name = `${config.name}: обычный робот модернизирован, груз и маршрут сохранены.`;
    } else {
      state.robots.push({ id: state.nextId++, kind: id, x: state.player.x, y: state.player.y, bag: 0, capacity: config.capacity, mode: 'cleaning', target: null, path: [], timer: 0, cleanAccumulator: 0 });
      name = `${config.name} приступил к уборке`;
    }
  } else {
    state.ownedTools.push(id);
    state.player.tool = id;
    name = TOOLS[id].name;
  }
  event(state, 'purchase', state.player, name);
  return result(true, name);
}

export function equipTool(state: GameState, id: ToolId): ActionResult {
  if (!state.ownedTools.includes(id)) return result(false, 'Сначала купите этот инструмент.');
  state.player.tool = id;
  state.cleanAccumulator = 0;
  return result(true, TOOLS[id].name);
}

export function toggleVehicle(state: GameState): ActionResult {
  const current = getVehicle(state);
  if (state.player.riding && current) {
    const walkingCapacity = getWalkingCapacity(state);
    if (state.player.bag > walkingCapacity) return result(false, `Сначала сдай ${state.player.bag} багов на станции: пеший рюкзак вмещает ${walkingCapacity}.`);
    current.x = state.player.x; current.y = state.player.y; current.speed = 0;
    state.player.riding = false; state.player.vehicleKind = null;
    return result(true, 'Вы вышли из машины.');
  }
  const nearest = state.vehicles.reduce<Vehicle | null>((best, vehicle) => !best || distance(state.player, vehicle) < distance(state.player, best) ? vehicle : best, null);
  if (!nearest) return result(false, 'Транспорт пока не куплен.');
  if (distance(state.player, nearest) > 65) return result(false, 'Подойдите к припаркованной машине.');
  state.player.riding = true; state.player.vehicleKind = nearest.kind; nearest.speed = 0;
  state.player.x = nearest.x; state.player.y = nearest.y;
  state.cleanAccumulator = 0;
  return result(true, 'За рулём. Пробел — уборка, V — выйти.');
}

export function getNearestTerminal(state: GameState, position: Vec = state.player, reach = 80): Building | undefined {
  let nearest: Building | undefined;
  let nearestDistance = reach;
  for (const building of state.buildings) {
    if (building.kind !== 'uplink') continue;
    const range = distance(position, buildingPosition(building));
    if (range <= nearestDistance) { nearest = building; nearestDistance = range; }
  }
  return nearest;
}

export function getVehicleSweep(state: GameState): { x: number; y: number; forwardX: number; forwardY: number; width: number; depth: number } | null {
  const vehicle = getVehicle(state);
  if (!vehicle) return null;
  const config = VEHICLES[vehicle.kind];
  const forwardX = Math.cos(vehicle.heading), forwardY = Math.sin(vehicle.heading);
  return { x: vehicle.x + forwardX * config.reach, y: vehicle.y + forwardY * config.reach, forwardX, forwardY, width: config.width, depth: config.depth };
}

function nearestDelivery(state: GameState, position: Vec, reach = 80, kind?: StructureKind): Building | undefined {
  let nearest: Building | undefined;
  let nearestDistance = reach;
  for (const building of state.buildings) {
    if ((building.kind !== 'receiver' && building.kind !== 'uplink') || (kind && building.kind !== kind)) continue;
    const range = distance(position, buildingPosition(building));
    if (range <= nearestDistance) { nearest = building; nearestDistance = range; }
  }
  return nearest;
}

export function interact(state: GameState): ActionResult {
  const building = nearestDelivery(state, state.player);
  if (!building) return result(false, 'Подойдите к приёмнику или терминалу продажи.');
  if (state.player.bag === 0 && (building.kind !== 'uplink' || recoveredUnits(state) === 0)) return result(false, 'Рюкзак пуст. Самое время найти баги.');
  if (building.kind === 'uplink') {
    const units = state.player.bag;
    const creditsBefore = state.credits;
    state.player.bag = 0;
    state.cleanAccumulator = 0;
    if (units) pay(state, units, buildingPosition(building));
    if (recoveredUnits(state)) sellRecovered(state);
    return result(true, `Продано: +${state.credits - creditsBefore} ¤.`);
  }
  const units = Math.min(state.player.bag, building.kind === 'receiver' ? Math.max(0, getReceiverCapacity(state) - building.buffer) : state.player.bag);
  if (units === 0) return result(false, 'Приёмник заполнен. Освободите выход конвейера или найдите другой приёмник.');
  state.player.bag -= units;
  state.cleanAccumulator = 0;
  if (building.kind === 'receiver') {
    building.buffer += units;
    event(state, 'notice', buildingPosition(building), `В конвейер: ${units}`, units);
    return result(true, `${units} багов отправлено на конвейер.${state.player.bag ? ` В рюкзаке осталось ${state.player.bag}.` : ''}`);
  }
  pay(state, units, buildingPosition(building));
  return result(true, `Сдано ${units} багов: +${units} ¤.`);
}

export function reclaimBugs(state: GameState): ActionResult {
  const terminal = getNearestTerminal(state);
  if (!terminal) return result(false, 'Вернитесь к любому терминалу продажи на базе.');
  const stock = Math.max(0, state.stats.rawSold - state.stats.rawReclaimed);
  if (stock === 0) return result(false, 'Нет проданных багов для возврата. Отчёты и автотесты не возвращаются.');
  const space = Math.max(0, getCapacity(state) - state.player.bag);
  if (space === 0) return result(false, 'Рюкзак заполнен: сначала освободите место.');
  const price = ECONOMY.reclaimPrice;
  const affordable = Math.floor(state.credits / price);
  if (affordable < 1) return result(false, `Возврат стоит ${price} ¤ за бага. Нужно хотя бы ${price} ¤.`);
  const units = Math.min(ECONOMY.reclaimBatch, stock, space, affordable);
  state.credits -= units * price;
  state.player.bag += units;
  state.stats.rawReclaimed += units;
  const message = `Возвращено ${units} багов за ${units * price} ¤. Отправьте их в производство.`;
  event(state, 'purchase', buildingPosition(terminal), message, units);
  return result(true, message);
}

export function getContextAction(state: GameState): string {
  const building = nearestDelivery(state, state.player);
  const recovered = recoveredUnits(state);
  if (building?.kind === 'uplink' && recovered > 0) return `E · Продать склад: ${recovered}${state.player.bag ? ` + рюкзак ${state.player.bag}` : ''}`;
  if (building) return state.player.bag ? `E · Сдать ${state.player.bag} багов` : 'E · Рюкзак пуст';
  const station = getNearbyStation(state);
  if (station) return `E · ${STATIONS[station].name}`;
  if (state.player.riding) return 'V · Выйти из машины';
  if (state.vehicles.some(vehicle => distance(state.player, vehicle) <= 65)) return 'V · Сесть в машину';
  return '';
}

function recipeFor(building: Building) {
  return building.kind === 'analyzer' || building.kind === 'tester' ? PROCESSING[building.kind] : null;
}

const MATERIAL_KINDS: MaterialKind[] = ['raw', 'report', 'test'];
const opposite = (direction: Direction): Direction => ((direction + 2) % 4) as Direction;

function emissionUnits(building: Building, available: number): number {
  const packet = building.kind === 'receiver' && available >= LOGISTICS.rawCapsuleUnits ? LOGISTICS.rawCapsuleUnits : LOGISTICS.capsuleUnits;
  return Math.min(packet, available);
}

function recoveredUnits(state: GameState): number {
  return MATERIAL_KINDS.reduce((sum, material) => sum + (state.recovered?.[material] ?? 0), 0);
}

export function sellRecovered(state: GameState): ActionResult {
  const terminal = getNearestTerminal(state);
  if (!terminal) return result(false, 'Продайте склад у любого терминала на базе.');
  if (recoveredUnits(state) === 0) return result(false, 'Склад после разборки пуст.');
  const creditsBefore = state.credits;
  for (const material of MATERIAL_KINDS) {
    const units = state.recovered[material];
    if (!units) continue;
    state.recovered[material] = 0;
    pay(state, units, buildingPosition(terminal), material);
  }
  return result(true, `Склад продан: +${state.credits - creditsBefore} ¤.`);
}

function acceptsMaterial(target: Building, material: MaterialKind): boolean {
  if (target.kind === 'receiver') return false;
  const recipe = recipeFor(target);
  return !recipe || recipe.input === material;
}

function outputMaterials(building: Building): MaterialKind[] {
  if (building.kind === 'uplink') return [];
  if (building.kind === 'receiver') return ['raw'];
  const recipe = recipeFor(building);
  return recipe ? [recipe.output] : MATERIAL_KINDS;
}

/** Physical compatible ports, independent of transient queues and ghost membership. */
export function getBuildingConnections(state: GameState, building: Building): Direction[] {
  const connections: Direction[] = [];
  for (let side = 0; side < 4; side++) {
    const direction = DIRECTIONS[side];
    const neighbor = state.buildings.find(item => item.gx === building.gx + direction.x && item.gy === building.gy + direction.y);
    if (!neighbor) continue;
    if (outputMaterials(building).some(material => acceptsMaterial(neighbor, material))
      || outputMaterials(neighbor).some(material => acceptsMaterial(building, material))) connections.push(side as Direction);
  }
  return connections;
}

const routeCache = new WeakMap<GameState, { signature: string; connected: Set<Building> }>();

/** Search compatible physical links and material transformations, including branches and cycles. */
export function receiverHasRoute(state: GameState, receiver: Building): boolean {
  if (receiver.kind !== 'receiver') return false;
  const signature = state.buildings.map(b => `${b.id}:${b.kind}:${b.gx}:${b.gy}`).join('|');
  const cached = routeCache.get(state);
  if (cached?.signature === signature) return cached.connected.has(receiver);
  const byCell = new Map(state.buildings.map(b => [`${b.gx},${b.gy}`, b]));
  const connected = new Set<Building>();
  for (const candidate of state.buildings) {
    if (candidate.kind !== 'receiver') continue;
    const queue: { building: Building; material: MaterialKind; from?: Direction }[] = [{ building: candidate, material: 'raw' }];
    const visited = new Set<string>();
    for (let head = 0; head < queue.length && !connected.has(candidate); head++) {
      const current = queue[head];
      const key = `${current.building.id}:${current.material}:${current.from ?? '-'}`;
      if (visited.has(key)) continue;
      visited.add(key);
      for (let side = 0; side < 4; side++) {
        if (current.building.kind === 'belt' && side === current.from) continue;
        const direction = DIRECTIONS[side];
        const next = byCell.get(`${current.building.gx + direction.x},${current.building.gy + direction.y}`);
        if (!next || !acceptsMaterial(next, current.material)) continue;
        if (next.kind === 'uplink') {
          connected.add(candidate);
          continue;
        }
        const recipe = recipeFor(next);
        queue.push({ building: next, material: recipe?.output ?? current.material, ...(next.kind === 'belt' ? { from: opposite(side as Direction) } : {}) });
      }
    }
  }
  routeCache.set(state, { signature, connected });
  return connected.has(receiver);
}

export function getRobotReceivers(state: GameState, availableOnly = false): Building[] {
  const capacity = getReceiverCapacity(state);
  return state.buildings.filter(building => building.kind === 'receiver' && (!availableOnly || building.buffer < capacity) && receiverHasRoute(state, building));
}

interface WorkPlan {
  terrain: Navigation;
  dust: number[];
  dirty: Set<number>;
  revision: number;
  cleaned: number;
}
const workPlans = new WeakMap<GameState, WorkPlan>();
const failedWorkSearches = new WeakMap<Robot, { plan: WorkPlan; revision: number }>();
function workPlan(state: GameState): WorkPlan {
  const terrain = navigation(state);
  const existing = workPlans.get(state);
  if (existing && existing.terrain === terrain && existing.dust === state.dust && existing.cleaned === state.cleaned) return existing;
  const dirty = new Set<number>();
  if (!(state.totalDirt > 0 && state.cleaned >= state.totalDirt)) {
    for (let index = 0; index < state.dust.length; index++) if (terrain.walkable[index] && state.dust[index] > 0) dirty.add(index);
  }
  const plan = { terrain, dust: state.dust, dirty, cleaned: state.cleaned, revision: 0 };
  workPlans.set(state, plan);
  return plan;
}

export function getRobotStatus(state: GameState): string {
  if (!state.robots.length) return 'Роботы не куплены';
  const pro = state.robots.filter(robot => robot.kind === 'industrialRobot').length;
  const connected = getRobotReceivers(state), available = connected.some(receiver => receiver.buffer < getReceiverCapacity(state));
  let cleaning = 0, returning = 0, waiting = 0, exhausted = 0;
  if (available) {
    const plan = workPlan(state);
    for (const robot of state.robots) {
      if (robot.mode === 'returning') returning++;
      else if (!plan.dirty.size) exhausted++;
      else if (robot.timer < 0 && !robot.target) waiting++;
      else cleaning++;
    }
  }
  const activity = !connected.length ? 'ждут связанную линию'
    : !available ? 'приёмники полны — ждут разгрузку'
      : [cleaning && `убирают ${cleaning}`, returning && `доставка ${returning}`, waiting && `ожидают маршрут ${waiting}`, exhausted && `мир очищен ${exhausted}`].filter(Boolean).join(' · ');
  return `${state.robots.length}/${ECONOMY.maxRobots} · обычных ${state.robots.length - pro}, PRO ${pro} · ${activity}`;
}

function intakeBlock(target: Building | undefined, material: MaterialKind, units: number): string | null {
  if (!target || target.kind === 'receiver') return 'Нет линии';
  const recipe = recipeFor(target);
  if (recipe && recipe.input !== material) return `Нужны ${MATERIALS[recipe.input].name.toLowerCase()}`;
  if (recipe && target.buffer + units > recipe.capacity) return 'Вход заполнен';
  return null;
}

export function getBuildingStatus(state: GameState, building: Building): string {
  if (building.kind === 'uplink') return 'Продажа · 1 / 3 / 7 ¤';
  if (building.kind === 'receiver' && !receiverHasRoute(state, building)) return 'Нет пути к терминалу';
  const recipe = recipeFor(building);
  if (recipe && building.processing) {
    const progress = Math.max(0, Math.min(99, Math.floor((1 - building.processing.remaining / recipe.cycle) * 100)));
    return `Работа · ${progress}%`;
  }
  const capsule = state.capsules.find(item => item.gx === building.gx && item.gy === building.gy);
  const stored = building.kind === 'receiver' ? building.buffer : building.outputBuffer;
  const units = capsule?.units ?? emissionUnits(building, stored);
  if (units > 0) {
    const byCell = transportBuildings(state);
    const occupied = new Set(state.capsules.map(item => `${item.gx},${item.gy}`));
    const outgoing = capsule ?? { id: -1, gx: building.gx, gy: building.gy, dir: building.dir, progress: 0, units, material: recipe?.output ?? 'raw' };
    if (availableOutputs(building, outgoing, byCell, occupied).length === 0) return 'Все выходы заблокированы';
  }
  if (building.kind === 'receiver') return `Приём · ${building.buffer}/${getReceiverCapacity(state)}`;
  if (recipe) {
    if (building.outputBuffer >= recipe.capacity) return 'Выход заблокирован';
    if (building.buffer > 0) return `В очереди · ${building.buffer}`;
    if (building.outputBuffer > 0 || capsule) return 'Отправка продукции';
    return `Нужны ${MATERIALS[recipe.input].name.toLowerCase()}`;
  }
  return capsule ? MATERIALS[capsule.material].name : 'Линия пуста';
}

export function getBuildPlacementError(state: GameState, kind: BuildKind, gx: number, gy: number): string | null {
  if (!Object.prototype.hasOwnProperty.call(BUILDINGS, kind)) return 'Терминал продажи находится только на базе.';
  const requirement = getBuildRequirement(state, kind);
  if (requirement) return requirement;
  if (!Number.isInteger(gx) || !Number.isInteger(gy) || gx < 0 || gy < 0 || gx >= WORLD_W / BUILD_CELL || gy >= WORLD_H / BUILD_CELL) return 'Клетка за пределами мира.';
  if (distance(state.player, buildingPosition({ gx, gy })) > 150) return 'Подойди ближе к клетке: строить можно рядом с Лотти.';
  const existing = state.buildings.find(building => building.gx === gx && building.gy === gy);
  if (existing) return `Здесь ${STRUCTURES[existing.kind].name}. ${kind === 'belt' ? 'Поставь конвейер в соседнюю свободную клетку: соседние постройки соединятся автоматически.' : 'Выбери соседнюю свободную клетку.'}`;
  const x = gx * BUILD_CELL;
  const y = gy * BUILD_CELL;
  const station = Object.values(STATIONS).find(item => collides({ x, y, w: BUILD_CELL, h: BUILD_CELL, kind: 'server' }, item.x, item.y, 32));
  if (station) return `Здесь ${station.name}. Оставьте место для подхода.`;
  if (state.obstacles.some(obstacle => x < obstacle.x + obstacle.w && x + BUILD_CELL > obstacle.x && y < obstacle.y + obstacle.h && y + BUILD_CELL > obstacle.y)) return 'Здесь препятствие. Обойди его конвейером.';
  const price = BUILDINGS[kind].price;
  if (state.credits < price) return `Нужно ещё ${price - state.credits} кр. (${BUILDINGS[kind].name}: ${price} кр.).`;
  return null;
}

export function canPlaceBuilding(state: GameState, kind: BuildKind, gx: number, gy: number): boolean {
  return getBuildPlacementError(state, kind, gx, gy) === null;
}

export function placeBuilding(state: GameState, kind: BuildKind, gx: number, gy: number, dir: Direction): ActionResult {
  const error = getBuildPlacementError(state, kind, gx, gy);
  if (error) return result(false, error);
  const price = BUILDINGS[kind].price;
  state.credits -= price;
  state.buildings.push({ id: state.nextId++, kind, gx, gy, dir, outputCursor: dir, buffer: 0, outputBuffer: 0, processing: null, cooldown: 0 });
  state.stats.built++;
  event(state, 'purchase', buildingPosition({ gx, gy }), BUILDINGS[kind].name);
  return result(true, `${BUILDINGS[kind].name} построен.`);
}

export function removeBuilding(state: GameState, gx: number, gy: number): ActionResult {
  const building = state.buildings.find(item => item.gx === gx && item.gy === gy);
  if (!building) return result(false, 'Здесь нет постройки.');
  if (distance(state.player, buildingPosition(building)) > 150) return result(false, 'Подойдите ближе к постройке.');
  if (building.kind === 'uplink') return result(false, 'Терминал продажи нельзя разобрать.');
  state.recovered ??= { raw: 0, report: 0, test: 0 };
  const recipe = recipeFor(building);
  state.recovered[recipe?.input ?? 'raw'] += building.buffer + (building.processing?.units ?? 0);
  state.recovered[recipe?.output ?? 'raw'] += building.outputBuffer;
  state.capsules = state.capsules.filter(capsule => {
    if (capsule.gx !== gx || capsule.gy !== gy) return true;
    state.recovered[capsule.material] += capsule.units;
    return false;
  });
  state.buildings = state.buildings.filter(item => item !== building);
  const refund = building.starter ? 0 : Math.floor(STRUCTURES[building.kind].price / 2);
  state.credits += refund;
  return result(true, `Постройка разобрана. Возврат: ${refund} ¤. Материалы сохранены на складе базы.`);
}

export function rotateBuilding(state: GameState, gx: number, gy: number): ActionResult {
  const building = state.buildings.find(item => item.gx === gx && item.gy === gy);
  if (!building) return result(false, 'Здесь нет постройки.');
  if (distance(state.player, buildingPosition(building)) > 150) return result(false, 'Подойдите ближе к постройке.');
  if (building.kind === 'uplink') return result(false, 'Терминал продажи не требует поворота.');
  building.dir = ((building.dir + 1) % 4) as Direction;
  building.outputCursor = building.dir;
  for (const capsule of state.capsules) {
    if (capsule.gx !== gx || capsule.gy !== gy) continue;
    capsule.dir = building.dir;
    capsule.progress = 0;
  }
  return result(true, 'Постройка повёрнута.');
}

function collectDust(state: GameState, center: Vec, radius: number, budget: number, eligible?: (index: number, position: Vec) => boolean) {
  if (budget < 1) return 0;
  const candidates: { index: number; range: number }[] = [];
  const minX = Math.max(0, Math.floor((center.x - radius) / CELL));
  const maxX = Math.min(GRID_W - 1, Math.floor((center.x + radius) / CELL));
  const minY = Math.max(0, Math.floor((center.y - radius) / CELL));
  const maxY = Math.min(GRID_H - 1, Math.floor((center.y + radius) / CELL));
  for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
    const index = gy * GRID_W + gx;
    if (state.dust[index] < 1 || eligible && !eligible(index, { x: gx * CELL + 6, y: gy * CELL + 6 })) continue;
    const range = Math.hypot(gx * CELL + 6 - center.x, gy * CELL + 6 - center.y);
    if (range <= radius) candidates.push({ index, range });
  }
  candidates.sort((a, b) => a.range - b.range);
  let count = 0;
  for (const candidate of candidates) {
    const taken = Math.min(state.dust[candidate.index], budget - count);
    state.dust[candidate.index] -= taken;
    count += taken;
    if (count >= budget) break;
  }
  if (count) {
    state.cleaned += count;
    const plan = workPlans.get(state);
    if (plan && plan.dust === state.dust) {
      for (const candidate of candidates) if (!state.dust[candidate.index] && plan.dirty.delete(candidate.index)) plan.revision++;
      plan.cleaned = state.cleaned;
    }
    event(state, 'clean', center, '', count);
  }
  return count;
}

interface TransportTopology { signature: string; members: Building[]; buildings: Map<string, Building> }
const transportTopologies = new WeakMap<GameState, TransportTopology>();
const preferredPortCache = new WeakMap<Map<string, Building>, Map<string, Direction[]>>();
function transportBuildings(state: GameState): Map<string, Building> {
  const signature = state.buildings.map(building => `${building.id}:${building.kind}:${building.gx}:${building.gy}`).join('|');
  const existing = transportTopologies.get(state);
  if (existing?.signature === signature && existing.members === state.buildings) return existing.buildings;
  const buildings = new Map(state.buildings.map(building => [`${building.gx},${building.gy}`, building]));
  transportTopologies.set(state, { signature, members: state.buildings, buildings });
  preferredPortCache.set(buildings, new Map());
  return buildings;
}

/** Prefer static consumer routes before checking queues; full outlets must not spill upstream. */
function preferredOutputs(source: Building, capsule: Capsule, buildings: Map<string, Building>): Direction[] {
  const cache = preferredPortCache.get(buildings);
  const cacheKey = `${source.id}:${source.kind}:${source.gx}:${source.gy}:${capsule.material}:${source.kind === 'belt' ? capsule.from ?? '-' : '-'}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const physical: Direction[] = [], viable: Direction[] = [], inputStems = new Set<Direction>();
  if (source.kind === 'uplink') return physical;
  const input = recipeFor(source)?.input;
  for (let side = 0; side < 4; side++) {
    if (source.kind === 'belt' && side === capsule.from) continue;
    const direction = DIRECTIONS[side];
    const target = buildings.get(`${source.gx + direction.x},${source.gy + direction.y}`);
    if (!target || !acceptsMaterial(target, capsule.material)) continue;
    physical.push(side as Direction);
    const queue: { building: Building; from: Direction }[] = [{ building: target, from: opposite(side as Direction) }];
    const visited = new Set<string>();
    let reachesConsumer = false;
    for (let head = 0; head < queue.length && !reachesConsumer; head++) {
      const current = queue[head];
      if (current.building.gx === source.gx && current.building.gy === source.gy) continue;
      const visitKey = `${current.building.id}:${current.from}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      if (current.building.kind !== 'belt') { reachesConsumer = true; break; }
      for (let onward = 0; onward < 4; onward++) {
        if (onward === current.from) continue;
        const step = DIRECTIONS[onward];
        const next = buildings.get(`${current.building.gx + step.x},${current.building.gy + step.y}`);
        if (!next || next === source) continue;
        // During construction, an input belt may be the only physical outlet.
        // Keep finished product at its machine until an actual product outlet exists.
        if (input && next.kind !== 'belt' && outputMaterials(next).includes(input)) inputStems.add(side as Direction);
        if (acceptsMaterial(next, capsule.material)) queue.push({ building: next, from: opposite(onward as Direction) });
      }
    }
    if (reachesConsumer) viable.push(side as Direction);
  }
  const preferred = viable.length ? viable : physical.filter(side => !inputStems.has(side));
  cache?.set(cacheKey, preferred);
  return preferred;
}

function availableOutputs(source: Building, capsule: Capsule, buildings: Map<string, Building>, occupied: Set<string>): Direction[] {
  return preferredOutputs(source, capsule, buildings).filter(side => {
    const direction = DIRECTIONS[side];
    const key = `${source.gx + direction.x},${source.gy + direction.y}`;
    return !occupied.has(key) && !intakeBlock(buildings.get(key), capsule.material, capsule.units);
  });
}

function chooseOutput(source: Building, capsule: Capsule, buildings: Map<string, Building>, occupied: Set<string>): Direction | null {
  const available = availableOutputs(source, capsule, buildings, occupied);
  if (capsule.progress > 0 && available.includes(capsule.dir)) return capsule.dir;
  const cursor = source.outputCursor ?? source.dir ?? 0;
  for (let offset = 0; offset < 4; offset++) {
    const side = ((cursor + offset) % 4) as Direction;
    if (available.includes(side)) return side;
  }
  return null;
}

function chooseExchange(source: Building, capsule: Capsule, buildings: Map<string, Building>, occupied: Set<string>, capsules: Map<string, Capsule>, handled: Set<number>) {
  const preferred = preferredOutputs(source, capsule, buildings);
  const eligible = (side: Direction) => {
    if (!preferred.includes(side)) return null;
    if (source.kind === 'belt' && capsule.from === side) return null;
    const direction = DIRECTIONS[side];
    const key = `${source.gx + direction.x},${source.gy + direction.y}`;
    const otherSource = buildings.get(key);
    const other = capsules.get(key);
    if (!otherSource || !other || handled.has(other.id)) return null;
    if (otherSource.kind === 'belt' && other.from === opposite(side)) return null;
    if (!preferredOutputs(otherSource, other, buildings).includes(opposite(side))) return null;
    if (intakeBlock(otherSource, capsule.material, capsule.units) || intakeBlock(source, other.material, other.units)) return null;
    if (availableOutputs(otherSource, other, buildings, occupied).length > 0) return null;
    return { side, otherSource, other };
  };
  if (capsule.progress > 0) {
    const current = eligible(capsule.dir);
    if (current) return current;
  }
  const cursor = source.outputCursor ?? source.dir ?? 0;
  for (let offset = 0; offset < 4; offset++) {
    const pair = eligible(((cursor + offset) % 4) as Direction);
    if (pair) return pair;
  }
  return null;
}

function updateConveyors(state: GameState, dt: number) {
  const occupied = new Set(state.capsules.map(capsule => `${capsule.gx},${capsule.gy}`));
  const buildings = transportBuildings(state);
  const capsulesByCell = new Map(state.capsules.map(capsule => [`${capsule.gx},${capsule.gy}`, capsule]));
  const delivered = new Set<number>();
  const handled = new Set<number>();
  const commit = (capsule: Capsule, source: Building, target: Building, side: Direction) => {
    source.outputCursor = ((side + 1) % 4) as Direction;
    if (target.kind === 'uplink') {
      pay(state, capsule.units, buildingPosition(target), capsule.material);
      delivered.add(capsule.id);
    } else if (recipeFor(target)) {
      target.buffer += capsule.units;
      delivered.add(capsule.id);
    } else {
      capsule.gx = target.gx; capsule.gy = target.gy;
      capsule.dir = target.outputCursor ?? target.dir;
      capsule.from = opposite(side); capsule.progress = 0;
      const key = `${capsule.gx},${capsule.gy}`;
      occupied.add(key);
      capsulesByCell.set(key, capsule);
    }
  };
  for (const building of state.buildings) {
    const recipe = recipeFor(building);
    if (!recipe) continue;
    const waiting = capsulesByCell.get(`${building.gx},${building.gy}`);
    if (waiting?.material === recipe.output && waiting.progress === 0
      && availableOutputs(building, waiting, buildings, occupied).length === 0) {
      // A shared input/output port must not trap input behind its own output.
      // Consolidate only stationary stock, keeping one bounded physical packet.
      const units = Math.min(building.outputBuffer, recipe.capacity - waiting.units);
      if (units > 0) { waiting.units += units; building.outputBuffer -= units; }
    }
    if (building.processing) {
      building.processing.remaining = Math.max(0, building.processing.remaining - dt);
      if (building.processing.remaining < 0.000001) {
        const units = building.processing.units;
        building.outputBuffer += units;
        if (building.kind === 'analyzer') state.stats.processed += units;
        else state.stats.tested += units;
        building.processing = null;
      }
    }
    const units = Math.min(recipe.batch, building.buffer);
    // Reserve output space with the job, so completion can never discard product.
    if (!building.processing && units > 0 && building.outputBuffer + units <= recipe.capacity) {
      building.buffer -= units;
      building.processing = { units, remaining: recipe.cycle };
    }
  }
  for (const capsule of state.capsules) {
    const source = buildings.get(`${capsule.gx},${capsule.gy}`);
    if (!source) continue;
    const side = chooseOutput(source, capsule, buildings, occupied);
    if (side === null) continue;
    handled.add(capsule.id);
    if (capsule.dir !== side) capsule.progress = 0;
    capsule.dir = side;
    const direction = DIRECTIONS[side];
    const nextX = capsule.gx + direction.x;
    const nextY = capsule.gy + direction.y;
    const nextKey = `${nextX},${nextY}`;
    const target = buildings.get(nextKey);
    if (!target || intakeBlock(target, capsule.material, capsule.units) || occupied.has(nextKey)) { capsule.progress = 0; continue; }
    capsule.progress += dt / LOGISTICS.hopDuration;
    if (capsule.progress < 1) continue;
    const previousKey = `${capsule.gx},${capsule.gy}`;
    occupied.delete(previousKey);
    capsulesByCell.delete(previousKey);
    commit(capsule, source, target, side);
  }
  // Ordinary traffic gets first use of free outlets. Remaining blocked reciprocal
  // handoffs can share a port without one input capsule trapping its output.
  for (const capsule of state.capsules) {
    if (handled.has(capsule.id) || delivered.has(capsule.id)) continue;
    const source = buildings.get(`${capsule.gx},${capsule.gy}`);
    if (!source || availableOutputs(source, capsule, buildings, occupied).length > 0) continue;
    const pair = chooseExchange(source, capsule, buildings, occupied, capsulesByCell, handled);
    if (!pair) { capsule.progress = 0; continue; }
    const { other, otherSource, side } = pair;
    const reverse = opposite(side);
    if (capsule.dir !== side) capsule.progress = 0;
    if (other.dir !== reverse) other.progress = 0;
    capsule.dir = side; other.dir = reverse;
    const progress = Math.min(1, Math.min(capsule.progress, other.progress) + dt / LOGISTICS.hopDuration);
    capsule.progress = progress; other.progress = progress;
    handled.add(capsule.id); handled.add(other.id);
    if (progress < 1) continue;
    const firstKey = `${capsule.gx},${capsule.gy}`;
    const secondKey = `${other.gx},${other.gy}`;
    occupied.delete(firstKey); occupied.delete(secondKey);
    capsulesByCell.delete(firstKey); capsulesByCell.delete(secondKey);
    commit(capsule, source, otherSource, side);
    commit(other, otherSource, source, reverse);
  }
  if (delivered.size) state.capsules = state.capsules.filter(capsule => !delivered.has(capsule.id));
  for (const building of state.buildings) {
    const recipe = recipeFor(building);
    if (building.kind !== 'receiver' && !recipe) continue;
    building.cooldown = Math.max(0, building.cooldown - dt);
    const key = `${building.gx},${building.gy}`;
    const available = recipe ? building.outputBuffer : building.buffer;
    if (available < 1 || building.cooldown > 0 || occupied.has(key)) continue;
    const units = emissionUnits(building, available);
    if (recipe) building.outputBuffer -= units;
    else building.buffer -= units;
    building.cooldown = LOGISTICS.emissionInterval;
    state.capsules.push({ id: state.nextId++, gx: building.gx, gy: building.gy, dir: building.outputCursor ?? building.dir, progress: 0, units, material: recipe?.output ?? 'raw' });
    state.stats.capsules++;
    occupied.add(key);
  }
}

function updateRobot(state: GameState, robot: Robot, dt: number) {
  const config = ROBOTS[robot.kind];
  const destinations = getRobotReceivers(state, true);
  if (!destinations.length) { robot.path = []; robot.target = null; robot.timer = -1; robot.cleanAccumulator = 0; return; }
  const plan = workPlan(state);
  if (robot.timer < 0) {
    robot.timer = Math.min(0, robot.timer + dt);
    if (robot.timer < 0) return;
  } else if (robot.bag > 0) robot.timer += dt;
  if (robot.mode === 'cleaning' && (robot.bag >= robot.capacity || robot.bag > 0 && (robot.timer >= 8 || !plan.dirty.size))) {
    robot.mode = 'returning'; robot.target = null; robot.path = [];
  }
  if (robot.mode === 'returning') {
    const capacity = getReceiverCapacity(state);

    if (config.remoteDelivery) {
      // Allocate against real free input space, sharing load among available lines.
      const ordered = [...destinations].sort((left, right) => left.buffer - right.buffer || left.id - right.id);
      let free = ordered.reduce((sum, receiver) => sum + capacity - receiver.buffer, 0);
      for (const destination of ordered) {
        const room = capacity - destination.buffer;
        const units = Math.min(room, Math.ceil(robot.bag * room / free));
        destination.buffer += units; robot.bag -= units; free -= room;
        if (units) event(state, 'notice', buildingPosition(destination), `PRO: ${units} багов`, units);
        if (!robot.bag) break;
      }
      robot.target = null; robot.path = []; robot.cleanAccumulator = 0;
      if (!robot.bag) { robot.mode = 'cleaning'; robot.timer = 0; }
      else robot.timer = -1;
      return;
    }
    const reach = 12;
    if (robot.target && !destinations.some(building => distance(robot.target!, buildingPosition(building)) < reach)) {
      robot.path = []; robot.target = null;
    }
    if (!robot.target) {
      const positions = destinations.map(buildingPosition);
      robot.path = positions.length ? findPath(state, robot, (_index, position) => positions.some(point => distance(position, point) < reach)) ?? [] : [];
      robot.target = robot.path.at(-1) ?? null;
      if (!robot.target) { robot.timer = -1; return; }
    }
    if (!config.remoteDelivery) {
      const destination = distance(robot, robot.target) < 12 ? destinations.find(building => distance(robot.target!, buildingPosition(building)) < 12) : undefined;
      if (destination) {
        const units = Math.min(robot.bag, capacity - destination.buffer);
        destination.buffer += units; robot.bag -= units;
        if (units) event(state, 'notice', robot, `Робот: ${units} багов`, units);
        robot.target = null; robot.path = []; robot.cleanAccumulator = 0;
        if (!robot.bag) { robot.mode = 'cleaning'; robot.timer = 0; }
      }
    }
  } else {
    if (!plan.dirty.size) { robot.target = null; robot.path = []; robot.timer = -1; robot.cleanAccumulator = 0; return; }
    {
      robot.cleanAccumulator = Math.min(config.rate * 0.2, robot.cleanAccumulator + dt * config.rate);
      const collected = collectDust(state, robot, config.radius, Math.min(Math.floor(robot.cleanAccumulator), robot.capacity - robot.bag));
      robot.bag += collected; state.stats.robotCleaned += collected; robot.cleanAccumulator -= collected;
    }
    if (!plan.dirty.size) {
      robot.target = null; robot.path = [];
      if (robot.bag) robot.mode = 'returning';
      else robot.timer = -1;
      return;
    }
    if (robot.target) {
      const index = Math.floor(robot.target.y / CELL) * GRID_W + Math.floor(robot.target.x / CELL);
      if (!state.dust[index]) { robot.target = null; robot.path = []; }
    }
    if (!robot.target) {
      const failed = failedWorkSearches.get(robot);
      if (failed?.plan === plan && failed.revision === plan.revision) { robot.timer = -1; return; }
      const reservations = state.robots.filter(other => other !== robot && other.mode === 'cleaning' && other.target).map(other => ({ target: other.target!, radius: Math.max(config.radius, ROBOTS[other.kind].radius) * 1.5 }));
      robot.path = findPath(state, robot, (index, position) => plan.dirty.has(index) && reservations.every(other => distance(position, other.target) >= other.radius)) ?? [];
      if (!robot.path.length && reservations.length) robot.path = findPath(state, robot, index => plan.dirty.has(index)) ?? [];
      robot.target = robot.path.at(-1) ?? null;
      if (!robot.target) { failedWorkSearches.set(robot, { plan, revision: plan.revision }); robot.timer = -1; return; }
    }
  }
  let movement = dt * config.speed;
  while (robot.path.length && movement > 1e-8) {
    const next = robot.path[0], range = distance(robot, next), step = Math.min(range, movement);
    if (range > 0.1) {
      const before = { x: robot.x, y: robot.y };
      move(state, robot, (next.x - robot.x) / range * step, (next.y - robot.y) / range * step);
      if (distance(before, robot) < Math.min(0.01, step * 0.1)) { robot.path = []; robot.target = null; robot.timer = -1; break; }
    }
    movement -= step;
    if (distance(robot, next) < 1) robot.path.shift();
    else break;
  }
}

function driveVehicle(state: GameState, vehicle: Vehicle, dt: number, input: GameInput) {
  const config = VEHICLES[vehicle.kind];
  const steer = Math.max(-1, Math.min(1, Number.isFinite(input.dx) ? input.dx : 0));
  const throttle = -Math.max(-1, Math.min(1, Number.isFinite(input.dy) ? input.dy : 0));
  const limit = input.clean ? config.cleanSpeed : config.speed;
  const desired = throttle >= 0 ? throttle * limit : throttle * limit * 0.45;
  const reversing = vehicle.speed * desired < 0;
  const target = reversing ? 0 : desired;
  const accelerating = !reversing && Math.abs(target) > Math.abs(vehicle.speed);
  const change = (accelerating ? config.acceleration : config.braking) * dt;
  vehicle.speed += Math.sign(target - vehicle.speed) * Math.min(Math.abs(target - vehicle.speed), change);
  const turnFactor = Math.min(1, Math.abs(vehicle.speed) / 35);
  vehicle.heading += steer * config.turnRate * dt * turnFactor * Math.sign(vehicle.speed);
  state.player.facingX = Math.cos(vehicle.heading); state.player.facingY = Math.sin(vehicle.heading);
  const before = { x: state.player.x, y: state.player.y };
  move(state, state.player, state.player.facingX * vehicle.speed * dt, state.player.facingY * vehicle.speed * dt);
  // A valid acceleration step can be below 0.01px on high refresh rate displays.
  if (Math.abs(vehicle.speed) > 0.1 && distance(before, state.player) < Math.min(0.01, Math.abs(vehicle.speed * dt) * 0.1)) vehicle.speed = 0;
  vehicle.x = state.player.x; vehicle.y = state.player.y;
}

export function updateGame(state: GameState, elapsed: number, input: GameInput): void {
  if (!Number.isFinite(elapsed) || elapsed <= 0) return;
  const dt = Math.min(elapsed, 0.1);
  state.time += dt;
  state.events = state.events.filter(item => state.time - item.time < (item.kind === 'clean' ? 1.1 : 3));
  const player = state.player;
  const inputX = Number.isFinite(input.dx) ? input.dx : 0;
  const inputY = Number.isFinite(input.dy) ? input.dy : 0;
  const magnitude = Math.hypot(inputX, inputY);
  const oldPosition = { x: player.x, y: player.y };
  const vehicle = getVehicle(state);
  if (vehicle) driveVehicle(state, vehicle, dt, input);
  else {
    if (magnitude > 0) {
      player.facingX = inputX / magnitude; player.facingY = inputY / magnitude;
      move(state, player, player.facingX * getSpeed(state) * dt, player.facingY * getSpeed(state) * dt);
    }
    if (input.aimX !== undefined && input.aimY !== undefined && Number.isFinite(input.aimX) && Number.isFinite(input.aimY)) {
      const aimX = input.aimX - player.x, aimY = input.aimY - player.y, aimMagnitude = Math.hypot(aimX, aimY);
      if (aimMagnitude > 1) { player.facingX = aimX / aimMagnitude; player.facingY = aimY / aimMagnitude; }
    }
  }
  state.stats.distance += distance(oldPosition, player);
  const cleaningReady = !vehicle || Math.abs(vehicle.speed) <= VEHICLES[vehicle.kind].cleanSpeed + 1e-9;
  if (input.clean && cleaningReady && player.bag < getCapacity(state)) {
    const tool = TOOLS[player.tool];
    const rate = vehicle ? VEHICLES[vehicle.kind].rate : tool.rate;
    state.cleanAccumulator = Math.min(rate * 0.2, state.cleanAccumulator + dt * rate);
    const budget = Math.min(Math.floor(state.cleanAccumulator), Math.max(0, getCapacity(state) - player.bag));
    let collected: number;
    const sweep = getVehicleSweep(state);
    if (sweep) {
      collected = collectDust(state, sweep, Math.hypot(sweep.width, sweep.depth) / 2, budget, (_index, point) => {
        const dx = point.x - sweep.x, dy = point.y - sweep.y;
        return Math.abs(dx * sweep.forwardX + dy * sweep.forwardY) <= sweep.depth / 2
          && Math.abs(-dx * sweep.forwardY + dy * sweep.forwardX) <= sweep.width / 2;
      });
    } else {
      const center = { x: player.x + player.facingX * 20, y: player.y + player.facingY * 20 };
      collected = collectDust(state, center, tool.radius, budget);
    }
    player.bag += collected; state.cleanAccumulator -= collected;
  } else state.cleanAccumulator = 0;
  for (const robot of state.robots) updateRobot(state, robot, dt);
  updateConveyors(state, dt);
  for (const landmark of state.landmarks) {
    if (state.discoveries.includes(landmark.id) || distance(player, landmark) > 90) continue;
    state.discoveries.push(landmark.id);
    state.credits += 25; state.earned += 25;
    event(state, 'discover', landmark, `${landmark.name} · +25 ¤`, 25);
  }
  for (const percent of [10, 25, 50, 75, 100]) {
    const id = `clean-${percent}`;
    if (state.totalDirt > 0 && state.cleaned / state.totalDirt >= percent / 100 && !state.milestones.includes(id)) {
      state.milestones.push(id);
      event(state, 'notice', player, `Чистота мира: ${percent}%`);
    }
  }
  if (state.totalDirt > 0 && state.cleaned >= state.totalDirt) state.completed = true;
}
