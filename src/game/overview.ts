import './overview.css';
import { renderMinimap } from './renderer';
import { BASE_HALF_SIZE, HUB, STATIONS, TERMINALS, WORLD_H, WORLD_W, type GameState } from './types';

const numbers = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const number = (value: number): string => numbers.format(Math.floor(value));

function playTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60).toString().padStart(2, '0');
  const remainder = (total % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

function stats(state: GameState): Record<string, string> {
  const percent = Math.max(0, Math.min(100, state.cleaned / Math.max(1, state.totalDirt) * 100));
  return {
    time: playTime(state.time), percent: percent.toFixed(1).replace('.', ','), cleaned: number(state.cleaned),
    processed: number(state.stats.processed), tested: number(state.stats.tested), earned: number(state.earned),
  };
}

export function overviewContent(state: GameState): string {
  const values = stats(state);
  return `<div class="overview-layout">
    <div class="overview-map-column">
      <div class="overview-map-heading"><span>PROD / КАРТА МИРА</span><span class="overview-live"><i></i>МИР ИДЁТ · ESC — ПАУЗА</span></div>
      <canvas id="overview-map" width="960" height="720" aria-label="Большая карта мира PROD"></canvas>
      <div class="overview-legend" aria-label="Обозначения карты"><span><i class="overview-key-lotti"></i>Лотти</span><span><i class="overview-key-base"></i>Терминал</span><span><i class="overview-key-robot"></i>Робот</span><span><i class="overview-key-pro"></i>PRO</span><span><i class="overview-key-vehicle"></i>Техника</span><span><i class="overview-key-place"></i>Открытое место</span><span><i class="overview-key-dust"></i>Баги</span></div>
    </div>
    <dl class="overview-stats" aria-label="Прогресс за всё время">
      <div><dt>Время игры</dt><dd data-testid="overview-time">${values.time}</dd></div>
      <div class="overview-mint"><dt>Очищено мира</dt><dd><span data-testid="overview-percent">${values.percent}%</span></dd></div>
      <div class="overview-coral"><dt>Багов собрано</dt><dd data-testid="overview-cleaned">${values.cleaned}</dd></div>
      <div class="overview-cyan"><dt>Отчётов создано</dt><dd data-testid="overview-processed">${values.processed}</dd></div>
      <div class="overview-yellow"><dt>Автотестов создано</dt><dd data-testid="overview-tested">${values.tested}</dd></div>
      <div class="overview-mint"><dt>Заработано всего, кр.</dt><dd data-testid="overview-earned">${values.earned}</dd></div>
    </dl>
  </div>`;
}

export function updateOverview(root: ParentNode, state: GameState): void {
  for (const [name, value] of Object.entries(stats(state))) {
    const element = root.querySelector<HTMLElement>(`[data-testid="overview-${name}"]`);
    if (element) element.textContent = name === 'percent' ? `${value}%` : value;
  }
  const canvas = root.querySelector<HTMLCanvasElement>('#overview-map');
  if (canvas) drawOverviewMap(canvas.getContext('2d')!, state);
}

interface Bounds { x: number; y: number; w: number; h: number }

export function drawOverviewMap(ctx: CanvasRenderingContext2D, state: GameState): void {
  renderMinimap(ctx, state);
  const width = ctx.canvas.width, height = ctx.canvas.height;
  const scale = Math.min((width - 8) / WORLD_W, (height - 8) / WORLD_H);
  const ox = Math.round((width - WORLD_W * scale) / 2), oy = Math.round((height - WORLD_H * scale) / 2);
  const point = (x: number, y: number) => ({ x: Math.round(ox + x * scale), y: Math.round(oy + y * scale) });
  const ratio = width / (ctx.canvas.clientWidth || width);
  const markerSize = Math.max(4, Math.round(4 * ratio));
  const labelSize = Math.max(14, Math.round(10 * ratio));
  const occupied: Bounds[] = [];
  const reserve = (x: number, y: number, size: number) => occupied.push({ x: x - size - 3, y: y - size - 3, w: size * 2 + 6, h: size * 2 + 6 });
  const overlaps = (a: Bounds, b: Bounds) => a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 4 && a.y + a.h + 4 > b.y;

  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.font = `600 ${labelSize}px ProdMono, "Courier New", monospace`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const marker = (x: number, y: number, color: string, size = markerSize, shape: 'square' | 'diamond' | 'cross' = 'square') => {
    ctx.fillStyle = '#092d25';
    ctx.fillRect(x - size - 2, y - size - 2, size * 2 + 4, size * 2 + 4);
    ctx.fillStyle = color;
    if (shape === 'diamond') {
      ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y); ctx.closePath(); ctx.fill();
    } else if (shape === 'cross') {
      ctx.fillRect(x - 2, y - size, 4, size * 2); ctx.fillRect(x - size, y - 2, size * 2, 4);
    } else ctx.fillRect(x - size + 1, y - size + 1, size * 2 - 2, size * 2 - 2);
    reserve(x, y, size);
  };
  const base = point(HUB.x, HUB.y), halfBase = BASE_HALF_SIZE * scale;
  ctx.strokeStyle = '#81e9a6aa'; ctx.lineWidth = 1;
  ctx.strokeRect(base.x - halfBase, base.y - halfBase, halfBase * 2, halfBase * 2);
  occupied.push({ x: base.x - halfBase, y: base.y - halfBase, w: halfBase * 2, h: halfBase * 2 });
  for (const terminal of TERMINALS) {
    const p = point(terminal.x, terminal.y); marker(p.x, p.y, '#81e9a6', markerSize - 1);
  }
  for (const [kind, station] of Object.entries(STATIONS)) {
    const p = point(station.x, station.y); marker(p.x, p.y, kind === 'workshop' ? '#d9eab2' : '#e9bc78', markerSize - 1);
  }
  for (const landmark of state.landmarks) {
    if (!state.discoveries.includes(landmark.id)) continue;
    const p = point(landmark.x, landmark.y); marker(p.x, p.y, landmark.color, markerSize - 1, 'diamond');
  }
  for (const vehicle of state.vehicles) {
    const p = point(vehicle.x, vehicle.y); marker(p.x, p.y, '#e9bc78', markerSize - 1);
  }
  for (const robot of state.robots) {
    const p = point(robot.x, robot.y);
    marker(p.x, p.y, robot.kind === 'industrialRobot' ? '#69d9ff' : '#cdb4ff', markerSize + (robot.kind === 'industrialRobot' ? 1 : 0), robot.kind === 'industrialRobot' ? 'square' : 'diamond');
  }
  const player = point(state.player.x, state.player.y); marker(player.x, player.y, '#ffffff', markerSize + 2, 'cross');

  const mapLabel = (text: string, x: number, y: number, color: string, preferAbove = false) => {
    const w = Math.ceil(ctx.measureText(text).width) + 14, h = labelSize + 10, gap = markerSize + 8;
    const vertical = [{ x: x - w / 2, y: y - h - gap, w, h }, { x: x - w / 2, y: y + gap, w, h }];
    const horizontal = [{ x: x + gap, y: y - h / 2, w, h }, { x: x - w - gap, y: y - h / 2, w, h }];
    const choices = preferAbove ? [...vertical, ...horizontal] : [...horizontal, ...vertical];
    const fit = choices.find(b => b.x >= 8 && b.y >= 8 && b.x + b.w <= width - 8 && b.y + b.h <= height - 8 && !occupied.some(other => overlaps(b, other)));
    if (!fit) return;
    occupied.push(fit);
    ctx.fillStyle = '#092d25ee'; ctx.fillRect(Math.round(fit.x), Math.round(fit.y), w, h);
    ctx.fillStyle = color; ctx.fillText(text, Math.round(fit.x + 7), Math.round(fit.y + h / 2));
  };
  mapLabel('БАЗА', base.x, base.y - halfBase, '#81e9a6', true);
  if (Math.abs(state.player.x - HUB.x) > BASE_HALF_SIZE || Math.abs(state.player.y - HUB.y) > BASE_HALF_SIZE) mapLabel('ЛОТТИ', player.x, player.y, '#ffffff');
  for (const landmark of state.landmarks) {
    if (!state.discoveries.includes(landmark.id)) continue;
    const p = point(landmark.x, landmark.y); mapLabel(landmark.name, p.x, p.y, landmark.color);
  }
  ctx.restore();
}
