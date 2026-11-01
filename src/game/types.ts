export const CELL = 12;
export const LEGACY_GRID_W = 128;
export const LEGACY_GRID_H = 96;
export const GRID_W = 448;
export const GRID_H = 336;
export const WORLD_W = CELL * GRID_W;
export const WORLD_H = CELL * GRID_H;
export const BUILD_CELL = 24;
export const HUB = { x: WORLD_W / 2 + BUILD_CELL / 2, y: WORLD_H / 2 + BUILD_CELL / 2 };
export const BASE_HALF_SIZE = 264;
export const SPAWN = { x: HUB.x, y: HUB.y + 96 };
export const TERMINALS = [
  { id: 'nw', x: HUB.x - 240, y: HUB.y - 240 },
  { id: 'ne', x: HUB.x + 240, y: HUB.y - 240 },
  { id: 'sw', x: HUB.x - 240, y: HUB.y + 240 },
  { id: 'se', x: HUB.x + 240, y: HUB.y + 240 },
] as const;
export type Direction = 0 | 1 | 2 | 3;
export const DIRECTIONS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
export type ToolId = 'toothbrush' | 'handbrush' | 'broom' | 'widebrush';
export type UpgradeId = ToolId | 'capacity' | 'speed' | 'compact' | 'vehicle' | 'robot' | 'industrialRobot';
export type VehicleKind = 'compact' | 'vehicle';
export type RobotKind = 'robot' | 'industrialRobot';
export type StationKind = 'workshop' | 'garage';
export const STATIONS = {
  workshop: { x: HUB.x - 108, y: HUB.y, name: 'Мастерская щёток' },
  garage: { x: HUB.x + 108, y: HUB.y, name: 'Гараж' },
} as const;
export const ECONOMY = {
  capacity: [300, 1200, 4200],
  capacityMultipliers: [1, 1.5, 2, 2.5],
  speed: [350, 1800],
  compact: 2200,
  vehicle: 12000,
  robot: 1800,
  industrialRobot: 75000,
  maxRobots: 5,
  robotPriceMultiplier: 1.2,
  compactReports: 32,
  robotReports: 16,
  testerReports: 64,
  vehicleTests: 128,
  robotTests: 256,
  reclaimPrice: 2,
  reclaimBatch: 64,
  vehicleCapacity: 5000,
  vehicleSpeed: 180,
  vehicleRate: 110,
} as const;
export const VEHICLES = {
  compact: { name: 'Мини-уборщик', price: ECONOMY.compact, capacity: 1200, speed: 145, cleanSpeed: 80, rate: 55, width: 40, depth: 20, reach: 25, turnRate: 1.9, acceleration: 120, braking: 240 },
  vehicle: { name: 'Уборочная машина', price: ECONOMY.vehicle, capacity: 5000, speed: 180, cleanSpeed: 95, rate: 110, width: 64, depth: 24, reach: 30, turnRate: 1.45, acceleration: 95, braking: 200 },
} as const;
export const ROBOTS = {
  robot: { name: 'Робот-пылесос', price: ECONOMY.robot, capacity: 180, speed: 100, rate: 18, radius: 24, remoteDelivery: false },
  industrialRobot: { name: 'Лоттик PRO', price: ECONOMY.industrialRobot, capacity: 1200, speed: 175, rate: 60, radius: 40, remoteDelivery: true },
} as const;
export const TOOLS: Record<ToolId, { name: string; price: number; radius: number; rate: number; capacity: number; description: string }> = {
  toothbrush: { name: 'Зубная щётка', price: 0, radius: 15, rate: 12, capacity: 120, description: 'Большой мир. Очень маленькая щётка.' },
  handbrush: { name: 'Ручная щётка', price: 400, radius: 24, rate: 25, capacity: 300, description: 'Вдвое быстрее. Уже серьёзный подход.' },
  broom: { name: 'Большая щётка', price: 1800, radius: 36, rate: 45, capacity: 600, description: 'Широкий чистый след за каждый проход.' },
  widebrush: { name: 'Турбощётка', price: 6000, radius: 49, rate: 80, capacity: 1000, description: 'Для багов, которые видели всё.' }
};
export const BUILDINGS = {
  belt: { name: 'Конвейер', price: 10, description: 'Передаёт капсулы между соседними постройками.' },
  receiver: { name: 'Приёмник', price: 100, description: 'Упаковывает баги. Вместимость растёт вместе с улучшением контейнеров.' },
  analyzer: { name: 'Анализатор', price: 600, description: '8 багов → 8 отчётов за 0,2 с. Отчёт стоит 3 кредита.' },
  tester: { name: 'Тестовый стенд', price: 3600, description: '8 отчётов → 8 автотестов за 0,4 с. Автотест стоит 7 кредитов.' }
} as const;
export type BuildKind = keyof typeof BUILDINGS;
export type StructureKind = BuildKind | 'uplink';
export const STRUCTURES = { ...BUILDINGS, uplink: { name: 'Терминал продажи', price: 0, description: 'Покупает сырьё и готовую продукцию. Находится только на базе.' } } as const;
export const MATERIALS = {
  raw: { name: 'Баги', value: 1, color: '#ff785f' },
  report: { name: 'Отчёты', value: 3, color: '#65dce8' },
  test: { name: 'Автотесты', value: 7, color: '#e9db82' },
} as const;
export type MaterialKind = keyof typeof MATERIALS;
export const RECEIVER_CAPACITY = 4096;
export const LOGISTICS = { hopDuration: 0.18, emissionInterval: 0.2, capsuleUnits: 8, rawCapsuleUnits: 32 } as const;
export const PROCESSING = {
  analyzer: { input: 'raw', output: 'report', cycle: 0.2, batch: 8, capacity: 32 },
  tester: { input: 'report', output: 'test', cycle: 0.4, batch: 8, capacity: 32 },
} as const;
export interface Vec { x: number; y: number }
export interface Obstacle { x: number; y: number; w: number; h: number; kind: 'rock' | 'tree' | 'server' | 'water' }
export interface Landmark extends Vec { id: string; name: string; color: string }
export interface ProcessingJob { units: number; remaining: number }
export interface Building { id: number; kind: StructureKind; gx: number; gy: number; dir: Direction; outputCursor?: Direction; buffer: number; cooldown: number; outputBuffer: number; processing: ProcessingJob | null; starter?: boolean }
export interface Capsule { id: number; gx: number; gy: number; dir: Direction; from?: Direction; progress: number; units: number; material: MaterialKind }
export interface Vehicle extends Vec { kind: VehicleKind; heading: number; speed: number }
export interface Robot extends Vec { id: number; kind: RobotKind; bag: number; capacity: number; mode: 'cleaning' | 'returning'; target: Vec | null; path: Vec[]; timer: number; cleanAccumulator: number }
export interface Player extends Vec { facingX: number; facingY: number; tool: ToolId; bag: number; capacityLevel: number; speedLevel: number; riding: boolean; vehicleKind: VehicleKind | null }
export interface GameEvent extends Vec { id: number; kind: 'clean' | 'credit' | 'purchase' | 'notice' | 'discover'; text: string; amount?: number; time: number }
export interface GameState {
  version: 5; seed: number; time: number; player: Player; credits: number; earned: number;
  dust: number[]; totalDirt: number; cleaned: number; obstacles: Obstacle[]; landmarks: Landmark[];
  ownedTools: ToolId[]; vehicles: Vehicle[]; robots: Robot[];
  buildings: Building[]; capsules: Capsule[]; discoveries: string[]; milestones: string[];
  recovered: Record<MaterialKind, number>;
  events: GameEvent[]; nextId: number; cleanAccumulator: number;
  stats: { delivered: number; capsules: number; built: number; robotCleaned: number; distance: number; processed: number; tested: number; rawSold: number; reportsSold: number; testsSold: number; rawReclaimed: number };
  completed: boolean;
}
export interface GameInput { dx: number; dy: number; clean: boolean; aimX?: number; aimY?: number }
export interface ActionResult { ok: boolean; message: string }
export interface RenderOptions {
  camera: Vec; pointer: Vec | null; cleaning: boolean; build: { kind: BuildKind | 'remove'; dir: Direction } | null;
  showGrid: boolean; paused: boolean;
}
