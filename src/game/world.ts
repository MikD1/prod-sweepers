import {
  BASE_HALF_SIZE, CELL, DIRECTIONS, GRID_H, GRID_W, HUB, LEGACY_GRID_H, LEGACY_GRID_W, SPAWN, STATIONS,
  WORLD_H, WORLD_W, type GameState, type Landmark, type Obstacle,
} from './types';

type WorldData = Pick<GameState, 'dust' | 'totalDirt' | 'obstacles' | 'landmarks'>;
const cache = new Map<number, WorldData>();

function randomGenerator(seed: number) {
  let value = seed | 0 || 1;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

/** Rasterize scenery once; path searches then examine four inexpensive grid neighbours. */
export function buildWalkability(obstacles: Obstacle[]): Uint8Array {
  const walkable = new Uint8Array(GRID_W * GRID_H).fill(1);
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
    const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
    if (px < 8 || py < 8 || px > WORLD_W - 8 || py > WORLD_H - 8) walkable[y * GRID_W + x] = 0;
  }
  for (const o of obstacles) {
    const x0 = Math.max(0, Math.floor((o.x - 8) / CELL)), x1 = Math.min(GRID_W - 1, Math.floor((o.x + o.w + 8) / CELL));
    const y0 = Math.max(0, Math.floor((o.y - 8) / CELL)), y1 = Math.min(GRID_H - 1, Math.floor((o.y + o.h + 8) / CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
      if (Math.hypot(px - Math.max(o.x, Math.min(px, o.x + o.w)), py - Math.max(o.y, Math.min(py, o.y + o.h))) < 8) walkable[y * GRID_W + x] = 0;
    }
  }
  return walkable;
}

function copyWorld(world: WorldData): WorldData {
  return { dust: world.dust.slice(), totalDirt: world.totalDirt, obstacles: world.obstacles.map(o => ({ ...o })), landmarks: world.landmarks.map(l => ({ ...l })) };
}

export function generateWorld(seed: number): WorldData {
  const existing = cache.get(seed);
  if (existing) return copyWorld(existing);
  const random = randomGenerator(seed);
  const obstacles: Obstacle[] = [
    { x: 144, y: 132, w: 48, h: 84, kind: 'server' },
    { x: 216, y: 132, w: 48, h: 84, kind: 'server' },
    { x: 288, y: 132, w: 48, h: 84, kind: 'server' },
    { x: 1140, y: 132, w: 144, h: 36, kind: 'server' },
    { x: 1284, y: 168, w: 36, h: 120, kind: 'server' },
    { x: 1068, y: 432, w: 192, h: 132, kind: 'water' },
    { x: 192, y: 840, w: 72, h: 48, kind: 'rock' },
    { x: 288, y: 912, w: 48, h: 60, kind: 'rock' },
    { x: 1164, y: 864, w: 48, h: 96, kind: 'server' },
    { x: 1236, y: 864, w: 48, h: 96, kind: 'server' },
    { x: 1308, y: 864, w: 48, h: 96, kind: 'server' },
  ];
  const landmarks: Landmark[] = [
    { id: 'legacy', x: 252, y: 264, name: 'Лес легаси', color: '#a7d596' },
    { id: 'deploy', x: 1224, y: 240, name: 'Пятничный деплой', color: '#eaa874' },
    { id: 'cache', x: 1190, y: 612, name: 'Озеро кэша', color: '#76c6d5' },
    { id: 'backlog', x: 300, y: 852, name: 'Горы бэклога', color: '#c5aad8' },
    { id: 'prod', x: 1260, y: 1008, name: 'Продакшен', color: '#ebc46e' },
    { id: 'forest', x: 408, y: 540, name: 'Тихий стенд', color: '#94cbb0' },
  ];
  const names = [
    ['Очередь событий', 'Склад логов'], ['Квартал микросервисов', 'Архив инцидентов'],
    ['Болото регрессий', 'Долина тестов'], ['Серверные сады', 'Парк рефакторинга'],
    ['Облачный порт', 'Шлюз данных'], ['Кратер дедлайнов', 'Плато релизов'],
    ['Хребет интеграций', 'Озеро метрик'], ['Ядро PROD', 'Полигон нагрузок'],
    ['Дельта запросов', 'Архипелаг очередей'], ['Поля компиляции', 'Склад артефактов'],
    ['Залив синхронизации', 'Берег протоколов'], ['Пустыня таймаутов', 'Оазис ретраев'],
    ['Северный кластер', 'Южный кластер'], ['Хранилище снапшотов', 'Плато миграций'],
    ['Дальний прод', 'Терминал пакетов'],
  ];
  let region = 0;
  for (let sy = 0; sy < Math.ceil(GRID_H / LEGACY_GRID_H); sy++) for (let sx = 0; sx < Math.ceil(GRID_W / LEGACY_GRID_W); sx++) {
    const ox = sx * LEGACY_GRID_W * CELL, oy = sy * LEGACY_GRID_H * CELL;
    const tileWidth = Math.min(LEGACY_GRID_W * CELL, WORLD_W - ox), tileHeight = Math.min(LEGACY_GRID_H * CELL, WORLD_H - oy);
    if (sx || sy) {
      const pair = names[region++];
      landmarks.push(
        { id: `district-${sx}-${sy}-a`, x: ox + Math.min(336, tileWidth - 60), y: oy + Math.min(324, tileHeight - 60), name: pair[0], color: ['#94cbb0', '#76c6d5', '#eaa874'][sx % 3] },
        { id: `district-${sx}-${sy}-b`, x: ox + Math.min(1152, tileWidth - 120), y: oy + Math.min(852, tileHeight - 120), name: pair[1], color: ['#ebc46e', '#c5aad8', '#a7d596'][sy % 3] },
      );
      obstacles.push(
        { x: ox + Math.min(912, tileWidth - 216), y: oy + Math.min(408, tileHeight - 168), w: 168, h: 120, kind: (sx + sy) % 2 ? 'water' : 'rock' },
        { x: ox + 168, y: oy + Math.min(600, tileHeight - 144), w: 48, h: 96, kind: 'server' },
        { x: ox + 240, y: oy + Math.min(600, tileHeight - 144), w: 48, h: 96, kind: 'server' },
      );
    }
    // Leave district edges open so extending production lines does not require a maze.
    for (let i = 0; i < (sx || sy ? 42 : 52); i++) {
      const x = ox + 60 + Math.floor(random() * Math.max(1, Math.floor((tileWidth - 120) / CELL))) * CELL;
      const y = oy + 60 + Math.floor(random() * Math.max(1, Math.floor((tileHeight - 120) / CELL))) * CELL;
      const kind = random() > .32 ? 'tree' : 'rock';
      const size = kind === 'tree' ? 24 : 24 + Math.floor(random() * 2) * CELL;
      if (Math.hypot(x - HUB.x, y - HUB.y) < 180 || landmarks.some(l => Math.hypot(l.x - x, l.y - y) < 66)) continue;
      if (Object.values(STATIONS).some(s => x < s.x + 56 && x + size > s.x - 56 && y < s.y + 56 && y + size > s.y - 56)) continue;
      if (obstacles.some(o => x < o.x + o.w + 24 && x + size + 24 > o.x && y < o.y + o.h + 24 && y + size + 24 > o.y)) continue;
      obstacles.push({ x, y, w: size, h: size, kind });
    }
  }
  // The whole logistics yard stays clear, including room outside every terminal.
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i], edge = BASE_HALF_SIZE + 32;
    if (o.x < HUB.x + edge && o.x + o.w > HUB.x - edge && o.y < HUB.y + edge && o.y + o.h > HUB.y - edge) obstacles.splice(i, 1);
  }
  const walkable = buildWalkability(obstacles);
  const reachable = new Uint8Array(GRID_W * GRID_H);
  const queue = new Int32Array(GRID_W * GRID_H);
  const start = Math.floor(SPAWN.y / CELL) * GRID_W + Math.floor(SPAWN.x / CELL);
  queue[0] = start; reachable[start] = 1;
  let head = 0, tail = 1;
  while (head < tail) {
    const index = queue[head++], x = index % GRID_W, y = Math.floor(index / GRID_W);
    for (const direction of DIRECTIONS) {
      const nx = x + direction.x, ny = y + direction.y, next = ny * GRID_W + nx;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H || reachable[next] || !walkable[next]) continue;
      reachable[next] = 1; queue[tail++] = next;
    }
  }
  const dust = Array<number>(GRID_W * GRID_H).fill(0);
  let totalDirt = 0;
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
    const index = y * GRID_W + x, px = x * CELL + 6, py = y * CELL + 6;
    if (!reachable[index] || Math.abs(px - HUB.x) <= BASE_HALF_SIZE && Math.abs(py - HUB.y) <= BASE_HALF_SIZE) continue;
    if (Object.values(STATIONS).some(s => Math.hypot(px - s.x, py - s.y) < 56)) continue;
    const distanceFromBase = Math.max(Math.abs(px - HUB.x) / (WORLD_W / 2), Math.abs(py - HUB.y) / (WORLD_H / 2));
    const depth = Math.min(3, Math.floor(distanceFromBase * 4));
    dust[index] = 1 + depth + Math.floor(random() * 3);
    totalDirt += dust[index];
  }
  const world = { dust, totalDirt, obstacles, landmarks };
  cache.set(seed, world);
  if (cache.size > 5) cache.delete(cache.keys().next().value!);
  return copyWorld(world);
}
