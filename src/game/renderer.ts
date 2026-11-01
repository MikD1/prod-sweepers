import {
  BASE_HALF_SIZE, BUILD_CELL, CELL, DIRECTIONS, GRID_H, GRID_W, HUB, MATERIALS, PROCESSING,
  STATIONS, TERMINALS, TOOLS, VEHICLES, WORLD_H, WORLD_W,
  type Building, type Direction, type GameState, type Obstacle, type RenderOptions, type Robot, type StationKind, type VehicleKind, type Vec,
} from './types';
import { canPlaceBuilding, getBuildingConnections, getCapacity, getReceiverCapacity, getVehicle, getVehicleSweep } from './engine';

const C = {
  void: '#081d1c', deep: '#0a2925', ground: '#174d3b', ground2: '#194f3d',
  mint: '#81e9a6', pale: '#d9ffe7', white: '#ffffff', ink: '#123b31',
  coral: '#ff785f', rust: '#a6503e', muted: '#548c6d', tile: '#285c47',
};

const motion = new WeakMap<GameState, { x: number; y: number; until: number }>();

function hash(x: number, y: number, salt = 0): number {
  let n = Math.imul(x + 137, 374761393) ^ Math.imul(y + 79, 668265263) ^ salt;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function box(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function poly(ctx: CanvasRenderingContext2D, color: string, points: number[]): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.closePath();
  ctx.fill();
}

function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, color = C.pale, size = 9): void {
  ctx.font = `600 ${size}px "IBM Plex Mono", "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = Math.ceil(ctx.measureText(value).width);
  box(ctx, '#0a2925e8', x - width / 2 - 6, y - 7, width + 12, 14);
  ctx.fillStyle = color;
  ctx.fillText(value, Math.round(x), Math.round(y + 0.5));
}

function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  box(ctx, '#082d24', x - w / 2 + 3, y - h / 2, w - 6, h);
  box(ctx, '#082d24', x - w / 2, y - h / 2 + 2, w, h - 4);
}

/** White, frilled Lotti. Coordinates mark the centre of the character's feet. */
export function drawLotti(
  ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1,
  time = 0, facingX = 1, moving = false,
): void {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(scale, scale);
  const step = moving ? Math.round(Math.sin(time * 13) * 2) : 0;
  const bob = moving ? Math.abs(step) - 1 : Math.round(Math.sin(time * 2) * 0.6);
  const tail = Math.round(Math.sin(time * (moving ? 10 : 2.4)) * (moving ? 3 : 1));
  // A little paddle tail, separate feet, and a backpack give the silhouette direction.
  poly(ctx, '#aedbbd', [4, -4, 11 + tail, 0, 9 + tail, 5, 4, 7, 1, 2]);
  box(ctx, '#d5f5dc', -8, -1 + step, 6, 5);
  box(ctx, '#ffffff', 3, -1 - step, 6, 5);
  box(ctx, '#bddfc9', facingX >= 0 ? -10 : 7, -15 + bob, 5, 12);
  box(ctx, '#81e9a6', facingX >= 0 ? -10 : 8, -13 + bob, 3, 5);
  box(ctx, '#e3f5e8', -8, -15 + bob, 17, 14);
  box(ctx, '#ffffff', -6, -18 + bob, 14, 16);
  box(ctx, '#ffffff', -10, -13 + bob, 5, 8);
  box(ctx, '#ffffff', 7, -13 + bob, 5, 8);
  ctx.translate(0, bob);
  const gill = Math.round(Math.sin(time * 3.4) * 0.8);
  // The six branching white gills are the distinctive official PROD mascot shape.
  box(ctx, '#d5f5dc', -15, -25, 8, 12);
  box(ctx, '#ffffff', -17, -33 - gill, 4, 7);
  box(ctx, '#ffffff', -15, -28 - gill, 6, 5);
  box(ctx, '#ffffff', -21, -25, 6, 4);
  box(ctx, '#ffffff', -19, -22, 10, 5);
  box(ctx, '#ffffff', -20, -17 + gill, 10, 4);
  box(ctx, '#ffffff', -15, -19 + gill, 6, 7);
  box(ctx, '#ffffff', 9, -25, 7, 12);
  box(ctx, '#ffffff', 13, -33 + gill, 4, 7);
  box(ctx, '#ffffff', 9, -28 + gill, 6, 5);
  box(ctx, '#ffffff', 15, -25, 6, 4);
  box(ctx, '#ffffff', 9, -22, 10, 5);
  box(ctx, '#d5f5dc', 10, -17 - gill, 10, 4);
  box(ctx, '#ffffff', 9, -19 - gill, 6, 7);
  box(ctx, '#e4f5e8', -11, -27, 23, 15);
  box(ctx, '#ffffff', -11, -28, 22, 12);
  box(ctx, '#ffffff', -8, -30, 17, 17);
  const look = facingX >= 0 ? 1 : -1;
  box(ctx, C.ink, -7 + look, -23, 3, 2);
  box(ctx, C.ink, 5 + look, -25, 3, 4);
  box(ctx, C.ink, -3 + look, -20, 2, 2);
  box(ctx, C.ink, 2 + look, -20, 2, 2);
  box(ctx, C.ink, -1 + look, -18, 4, 2);
  box(ctx, '#b4e6c4', -7, -16, 3, 1);
  ctx.restore();
}

function terrain(ctx: CanvasRenderingContext2D, state: GameState, view: { x: number; y: number; w: number; h: number }): void {
  const left = Math.max(0, Math.floor(view.x / CELL));
  const top = Math.max(0, Math.floor(view.y / CELL));
  const right = Math.min(GRID_W, Math.ceil((view.x + view.w) / CELL));
  const bottom = Math.min(GRID_H, Math.ceil((view.y + view.h) / CELL));
  box(ctx, C.ground, Math.max(0, view.x), Math.max(0, view.y), Math.min(WORLD_W, view.x + view.w) - Math.max(0, view.x), Math.min(WORLD_H, view.y + view.h) - Math.max(0, view.y));
  for (let gy = top; gy < bottom; gy++) {
    for (let gx = left; gx < right; gx++) {
      const h = hash(gx, gy, state.seed);
      const x = gx * CELL;
      const y = gy * CELL;
      if (h > 0.65) box(ctx, h > 0.84 ? '#1d5440' : C.ground2, x, y, CELL, CELL);
      if (h < 0.18) {
        box(ctx, '#256547', x + 2, y + 7, 3, 1);
        box(ctx, '#307754', x + 3, y + 5, 1, 3);
      } else if (h > 0.8) {
        box(ctx, '#337753', x + 4, y + 4, 2, 1);
        box(ctx, '#205b42', x + 9, y + 9, 2, 2);
      }
      if (gx < 2 || gy < 2 || gx >= GRID_W - 2 || gy >= GRID_H - 2) {
        box(ctx, h > 0.3 ? '#0d362b' : '#103c2e', x, y, CELL, CELL);
        if (h > 0.5) box(ctx, '#366a48', x + 3, y + 1, 4, 2);
      }
    }
  }
  // A stepped coastline and vertical cliff face frame the playable green world.
  box(ctx, '#061e1c', 0, WORLD_H - 6, WORLD_W, 6);
  box(ctx, '#061e1c', WORLD_W - 6, 0, 6, WORLD_H);
  for (let x = Math.max(0, Math.floor(view.x / 24) * 24); x < Math.min(WORLD_W, view.x + view.w); x += 24) {
    box(ctx, '#0a2923', x, 0, 24, 4 + hash(x, 0) * 6);
    box(ctx, '#143c2c', x, WORLD_H - 11, 17, 5);
  }
  for (let y = Math.max(0, Math.floor(view.y / 24) * 24); y < Math.min(WORLD_H, view.y + view.h); y += 24) {
    box(ctx, '#0a2923', 0, y, 4 + hash(0, y) * 6, 24);
  }
}

function hub(ctx: CanvasRenderingContext2D, time: number, view: { x: number; y: number; w: number; h: number }): void {
  const x = HUB.x - BASE_HALF_SIZE;
  const y = HUB.y - BASE_HALF_SIZE;
  const size = BASE_HALF_SIZE * 2;
  box(ctx, '#0c352a', x - 5, y - 5, size + 10, size + 10);
  box(ctx, '#285a44', x, y, size, size);
  const firstX = Math.max(0, Math.floor((view.x - x) / BUILD_CELL));
  const firstY = Math.max(0, Math.floor((view.y - y) / BUILD_CELL));
  const lastX = Math.min(size / BUILD_CELL, Math.ceil((view.x + view.w - x) / BUILD_CELL));
  const lastY = Math.min(size / BUILD_CELL, Math.ceil((view.y + view.h - y) / BUILD_CELL));
  for (let row = firstY; row < lastY; row++) for (let col = firstX; col < lastX; col++) {
    box(ctx, (row + col) % 2 ? '#25543f' : '#285a44', x + col * BUILD_CELL + 1, y + row * BUILD_CELL + 1, 22, 22);
    box(ctx, '#33674d', x + col * BUILD_CELL + 2, y + row * BUILD_CELL + 2, 3, 1);
  }
  // Four independent entrances share a low, walkable service yard.
  const roadInset = BASE_HALF_SIZE - 24;
  const roadX = HUB.x - roadInset;
  const roadY = HUB.y - roadInset;
  const roadLength = roadInset * 2;
  for (const edgeY of [roadY, roadY + roadLength]) box(ctx, '#1b4837', roadX - 18, edgeY - 18, roadLength + 36, 36);
  for (const edgeX of [roadX, roadX + roadLength]) box(ctx, '#1b4837', edgeX - 18, roadY - 18, 36, roadLength + 36);
  box(ctx, '#204b38', HUB.x - 18, roadY, 36, roadLength);
  box(ctx, '#204b38', roadX, HUB.y - 18, roadLength, 36);
  for (let i = -roadInset + 36; i < roadInset; i += 30) {
    for (const edgeY of [roadY, roadY + roadLength]) box(ctx, '#69825b', HUB.x + i, edgeY, 11, 2);
    for (const edgeX of [roadX, roadX + roadLength]) box(ctx, '#69825b', edgeX, HUB.y + i, 2, 11);
  }
  ctx.strokeStyle = '#4d7956';
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + size, y, -1, 1], [x, y + size, 1, -1], [x + size, y + size, -1, -1]]) {
    box(ctx, C.mint, cx + (sx < 0 ? -20 : 0), cy - 1, 20, 3);
    box(ctx, C.mint, cx - 1, cy + (sy < 0 ? -20 : 0), 3, 20);
  }
  for (const kind of Object.keys(STATIONS) as StationKind[]) {
    const place = STATIONS[kind];
    box(ctx, '#1d4734', place.x - 51, place.y - 59, 102, 88);
    ctx.strokeStyle = kind === 'garage' ? '#65dce845' : '#b8d89445';
    ctx.strokeRect(place.x - 51.5, place.y - 59.5, 103, 89);
  }
  ctx.save();
  ctx.globalAlpha = 0.46;
  ctx.font = 'bold 25px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#b2dba3';
  ctx.fillText('PROD', HUB.x, HUB.y + 75);
  ctx.font = '8px "Courier New", monospace';
  ctx.fillText('БАЗА КОНТРОЛЯ КАЧЕСТВА', HUB.x, HUB.y + 90);
  ctx.restore();
  const corners = { nw: 'СЗ · 01', ne: 'СВ · 02', sw: 'ЮЗ · 03', se: 'ЮВ · 04' };
  for (const terminal of TERMINALS) {
    const inward = terminal.x < HUB.x ? 1 : -1;
    const tx = terminal.x + inward * 69;
    label(ctx, corners[terminal.id], tx, terminal.y - 4, '#a3c39d', 8);
    ctx.font = '7px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7eaa88';
    ctx.fillText('ТЕРМИНАЛ', tx, terminal.y + 13);
    box(ctx, '#123c2c', terminal.x - inward * 16 - 3, terminal.y + 15, 6, 6);
    box(ctx, Math.sin(time * 2 + inward) > 0 ? C.mint : '#548c6d', terminal.x - inward * 16 - 1, terminal.y + 15, 2, 2);
  }
}

function station(ctx: CanvasRenderingContext2D, kind: StationKind): void {
  const { x, y } = STATIONS[kind];
  shadow(ctx, x + 2, y + 15, kind === 'garage' ? 94 : 78, 16);
  if (kind === 'workshop') {
    box(ctx, '#0b3026', x - 35, y - 41, 70, 52);
    box(ctx, '#547f5b', x - 31, y - 34, 62, 43);
    box(ctx, '#d0dcb0', x - 37, y - 46, 74, 8);
    for (let i = 0; i < 7; i++) box(ctx, i % 2 ? '#9ed29b' : '#557f58', x - 35 + i * 10, y - 38, 10, 7);
    box(ctx, '#153d2e', x - 24, y - 28, 48, 20);
    for (let i = 0; i < 4; i++) {
      box(ctx, '#d1dcb0', x - 18 + i * 11, y - 20, 2, 11);
      box(ctx, i === 3 ? C.coral : C.mint, x - 21 + i * 11, y - 25, 8, 6);
    }
    box(ctx, '#a6c28f', x - 34, y - 7, 68, 8);
    box(ctx, '#527653', x - 30, y + 1, 60, 11);
    box(ctx, '#385b40', x - 24, y + 5, 14, 4);
    box(ctx, '#e8e5b8', x + 12, y - 5, 12, 4);
    box(ctx, C.mint, x + 25, y - 5, 3, 3);
    label(ctx, 'МАСТЕРСКАЯ ЩЁТОК', x, y - 51, '#d8eab8', 8);
  } else {
    box(ctx, '#0b3028', x - 44, y - 48, 88, 61);
    box(ctx, '#4b7160', x - 40, y - 42, 80, 51);
    box(ctx, '#8cac91', x - 44, y - 50, 88, 7);
    box(ctx, '#1b4135', x - 31, y - 35, 62, 42);
    box(ctx, '#294e3d', x - 28, y - 32, 56, 34);
    for (let i = 0; i < 5; i++) box(ctx, '#3d6350', x - 28, y - 31 + i * 7, 56, 2);
    box(ctx, '#172f28', x - 20, y - 5, 40, 14);
    for (let i = 0; i < 5; i++) box(ctx, i % 2 ? '#d7ce8e' : '#6e8c67', x - 38 + i * 16, y + 9, 9, 4);
    box(ctx, '#a9c399', x - 38, y - 36, 5, 35);
    box(ctx, '#a9c399', x + 33, y - 36, 5, 35);
    box(ctx, '#65dce8', x + 34, y - 31, 3, 7);
    box(ctx, '#65dce8', x - 37, y - 31, 3, 7);
    label(ctx, 'ГАРАЖ', x, y - 56, '#a8e8de', 9);
  }
}

function dust(ctx: CanvasRenderingContext2D, state: GameState, view: { x: number; y: number; w: number; h: number }): void {
  const x0 = Math.max(0, Math.floor(view.x / CELL) - 1);
  const y0 = Math.max(0, Math.floor(view.y / CELL) - 1);
  const x1 = Math.min(GRID_W, Math.ceil((view.x + view.w) / CELL) + 1);
  const y1 = Math.min(GRID_H, Math.ceil((view.y + view.h) / CELL) + 1);
  for (let gy = y0; gy < y1; gy++) {
    for (let gx = x0; gx < x1; gx++) {
      const amount = state.dust[gy * GRID_W + gx];
      if (!amount) continue;
      const h = hash(gx, gy, state.seed + 231);
      const x = gx * CELL;
      const y = gy * CELL;
      const density = Math.min(1, 0.4 + amount * 0.2);
      ctx.globalAlpha = density;
      box(ctx, h > 0.5 ? '#5b5338' : '#5a5237', x, y, CELL, CELL);
      // Each grain has its own position: dust reads as a loose surface, not a tile.
      const grains = amount > 2 ? 5 : amount > 1 ? 4 : 2;
      for (let n = 0; n < grains; n++) {
        const hx = hash(gx * 7 + n, gy, state.seed + 17);
        const hy = hash(gx, gy * 7 + n, state.seed + 31);
        box(ctx, n === 0 ? '#ec9270' : n < 3 ? '#ba7951' : '#8f6d43', x + hx * 10, y + hy * 10, n === 0 ? 3 : 2, hy > 0.55 ? 2 : 1);
      }
      if (h < 0.19) {
        const bx = x + 3 + hash(gx, gy, 84) * 4;
        const by = y + 3 + hash(gx, gy, 32) * 4;
        box(ctx, '#71392d', bx - 2, by - 1, 2, 1);
        box(ctx, '#71392d', bx - 2, by + 2, 9, 1);
        box(ctx, '#71392d', bx + 5, by - 1, 2, 1);
        box(ctx, C.coral, bx, by - 1, 5, 5);
        box(ctx, '#ffb390', bx + 1, by, 2, 1);
        box(ctx, '#63392e', bx + 3, by + 1, 1, 2);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function drawRock(ctx: CanvasRenderingContext2D, o: Obstacle): void {
  const { x, y, w, h } = o;
  shadow(ctx, x + w / 2 + 3, y + h - 2, w + 8, 12);
  poly(ctx, '#193b31', [x + 5, y + h, x - 3, y + h - 9, x + 2, y + 10, x + 11, y, x + w - 10, y + 1, x + w, y + 12, x + w + 2, y + h - 5]);
  poly(ctx, '#47735a', [x + 2, y + 10, x + 11, y, x + w - 10, y + 1, x + w - 1, y + 12, x + w - 8, y + h - 9, x + 8, y + h - 9]);
  poly(ctx, '#365c46', [x + 8, y + h - 9, x + w - 8, y + h - 9, x + w - 1, y + 12, x + w, y + h - 5, x + 5, y + h]);
  box(ctx, '#719476', x + 11, y + 5, Math.max(4, w * 0.35), 3);
  box(ctx, '#5a8464', x + 5, y + 10, 4, 7);
  box(ctx, '#27523b', x + w * 0.55, y + h * 0.5, 7, 3);
  box(ctx, '#7cb371', x + w - 13, y + h - 10, 7, 2);
}

function drawTree(ctx: CanvasRenderingContext2D, o: Obstacle): void {
  const { x, y, w, h } = o;
  const cx = x + w / 2;
  shadow(ctx, cx + 2, y + h, w + 18, 15);
  box(ctx, '#1c3527', cx - 5, y + h * 0.52, 12, h * 0.5);
  box(ctx, '#7c7450', cx - 4, y + h * 0.47, 7, h * 0.48);
  box(ctx, '#a38b5c', cx - 3, y + h * 0.53, 2, h * 0.34);
  const top = y - 13;
  poly(ctx, '#0c392b', [x - 5, top + 17, x + 4, top + 6, cx - 8, top + 6, cx - 8, top - 2, cx + 10, top - 2, cx + 10, top + 5, x + w - 2, top + 5, x + w + 7, top + 18, x + w + 7, y + h * 0.5, x + w - 3, y + h * 0.68, x + 6, y + h * 0.68, x - 6, y + h * 0.45]);
  box(ctx, '#286946', x + 2, top + 10, w - 4, h * 0.5);
  box(ctx, '#337b4e', x + 9, top + 6, w - 17, h * 0.34);
  box(ctx, '#448955', x + 6, top + 14, 12, 8);
  box(ctx, '#559a5f', x + 12, top + 10, 10, 4);
  box(ctx, '#1d573b', x + w - 12, y + h * 0.24, 12, 14);
  box(ctx, '#80ad6a', x + 9, top + 15, 3, 2);
  box(ctx, '#80ad6a', cx + 5, top + 8, 4, 2);
}

function drawServer(ctx: CanvasRenderingContext2D, o: Obstacle, time: number): void {
  const { x, y, w, h } = o;
  shadow(ctx, x + w / 2, y + h + 2, w + 12, 11);
  box(ctx, '#082d27', x - 3, y - 4, w + 6, h + 7);
  box(ctx, '#63856a', x, y - 6, w, 5);
  box(ctx, '#2d5947', x, y - 1, w, h);
  box(ctx, '#173e34', x + w - 7, y, 7, h);
  for (let row = 0; row < Math.floor((h - 7) / 13); row++) {
    box(ctx, '#102f29', x + 4, y + 5 + row * 13, w - 16, 9);
    box(ctx, '#35614d', x + 7, y + 7 + row * 13, Math.max(4, w - 31), 2);
    box(ctx, (Math.floor(time * 2) + row) % 5 ? C.mint : C.coral, x + w - 20, y + 8 + row * 13, 3, 3);
  }
  box(ctx, '#7da07b', x + 2, y - 5, w - 6, 2);
  box(ctx, '#2c6745', x + 2, y + h - 5, 11, 6);
  box(ctx, '#52975e', x + 5, y + h - 8, 3, 5);
}

function drawWater(ctx: CanvasRenderingContext2D, o: Obstacle, time: number): void {
  const { x, y, w, h } = o;
  box(ctx, '#316846', x - 3, y + 5, w + 6, h - 10);
  box(ctx, '#316846', x + 5, y - 3, w - 10, h + 6);
  box(ctx, '#102f32', x, y + 5, w, h - 10);
  box(ctx, '#102f32', x + 5, y, w - 10, h);
  box(ctx, '#173f3e', x + 5, y + 7, w - 10, h - 15);
  box(ctx, '#4b8060', x + 6, y, w - 12, 2);
  for (let n = 0; n < Math.floor(w * h / 550); n++) {
    const px = x + 9 + hash(n, x) * (w - 20);
    const py = y + 8 + hash(n, y) * (h - 20);
    const shift = Math.round(Math.sin(time * 1.3 + n * 2) * 2);
    box(ctx, '#2c6256', px + shift, py, 7 + n % 5, 1);
    if (n % 4 === 0) {
      box(ctx, '#65986c', px, py + 3, 7, 3);
      box(ctx, '#80ae76', px + 1, py + 2, 4, 1);
      box(ctx, '#173f3e', px + 4, py + 2, 2, 2);
    }
  }
  box(ctx, '#71a764', x - 2, y + h - 15, 2, 12);
  box(ctx, '#4d8a56', x - 5, y + h - 11, 2, 8);
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number, color: string, size = 1): void {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(dir * Math.PI / 2);
  box(ctx, color, -4 * size, -size, 6 * size, 2 * size);
  poly(ctx, color, [size, -4 * size, 5 * size, 0, size, 4 * size]);
  ctx.restore();
}

function connectionPorts(ctx: CanvasRenderingContext2D, x: number, y: number, connections: Direction[], color: string): void {
  for (const side of connections) {
    const direction = DIRECTIONS[side];
    const px = x + 12 + direction.x * 11;
    const py = y + 12 + direction.y * 11;
    if (side % 2 === 0) {
      box(ctx, '#0b3027', px - 3, py - 5, 7, 10);
      box(ctx, '#719779', px - 2, py - 4, 5, 8);
      box(ctx, '#244e39', px - 2, py - 2, 5, 4);
      box(ctx, color, px - 1, py - 2, 3, 4);
    } else {
      box(ctx, '#0b3027', px - 5, py - 3, 10, 7);
      box(ctx, '#719779', px - 4, py - 2, 8, 5);
      box(ctx, '#244e39', px - 2, py - 2, 4, 5);
      box(ctx, color, px - 2, py - 1, 4, 3);
    }
  }
}

function belt(ctx: CanvasRenderingContext2D, state: GameState, b: Building, connections: Direction[], time: number): void {
  const x = b.gx * BUILD_CELL;
  const y = b.gy * BUILD_CELL;
  box(ctx, '#11382b', x, y, 24, 24);
  // A closed neutral pad becomes a straight, corner, junction or cross as neighbours appear.
  for (const side of connections) {
    if (side % 2 === 0) box(ctx, '#6c9471', x + (side === 0 ? 12 : 0), y + 5, 12, 14);
    else box(ctx, '#6c9471', x + 5, y + (side === 1 ? 12 : 0), 14, 12);
  }
  box(ctx, '#648e68', x + 5, y + 5, 14, 14);
  for (const side of connections) {
    if (side % 2 === 0) box(ctx, '#284d39', x + (side === 0 ? 12 : 0), y + 7, 12, 10);
    else box(ctx, '#284d39', x + 7, y + (side === 1 ? 12 : 0), 10, 12);
  }
  box(ctx, '#284d39', x + 7, y + 7, 10, 10);
  const cargo = state.capsules.find(capsule => capsule.gx === b.gx && capsule.gy === b.gy && capsule.progress > 0);
  for (const side of connections) {
    const moving = cargo?.dir === side;
    const shift = moving ? Math.floor(time * 12) % 5 : 0;
    for (let n = 0; n < 2; n++) {
      const offset = (n * 5 + shift) % 10;
      const d = DIRECTIONS[side];
      const px = x + 12 + d.x * (3 + offset);
      const py = y + 12 + d.y * (3 + offset);
      box(ctx, '#497455', px - (side % 2 ? 4 : 0), py - (side % 2 ? 0 : 4), side % 2 ? 8 : 1, side % 2 ? 1 : 8);
    }
  }
  box(ctx, connections.length ? '#7dab7c' : '#43664d', x + 10, y + 10, 4, 4);
  for (const [dx, dy] of [[2, 2], [20, 2], [2, 20], [20, 20]]) box(ctx, '#83a67d', x + dx, y + dy, 2, 2);
}

function building(ctx: CanvasRenderingContext2D, state: GameState, b: Building, time: number, receiverCapacity: number): void {
  const x = b.gx * BUILD_CELL;
  const y = b.gy * BUILD_CELL;
  const connections = getBuildingConnections(state, b);
  if (b.kind === 'belt') {
    belt(ctx, state, b, connections, time);
    return;
  }
  shadow(ctx, x + 12, y + 25, 35, 10);
  if (b.kind === 'receiver') {
    const full = b.buffer >= receiverCapacity;
    box(ctx, '#0b2e27', x - 4, y - 13, 32, 38);
    box(ctx, '#608e68', x - 2, y - 12, 28, 31);
    box(ctx, '#426c4d', x - 2, y + 12, 28, 10);
    box(ctx, '#d2dfb3', x - 3, y - 13, 30, 4);
    poly(ctx, '#102e27', [x + 1, y - 8, x + 23, y - 8, x + 20, y + 3, x + 4, y + 3]);
    box(ctx, '#2f5140', x + 5, y - 6, 15, 5);
    if (b.buffer > 0) box(ctx, C.coral, x + 9, y - 4, 6, 3);
    box(ctx, '#a5be8b', x + 1, y + 8, 22, 4);
    box(ctx, '#133d30', x + 3, y + 16, 8, 4);
    box(ctx, '#173d2e', x + 3, y + 16, 11, 3);
    box(ctx, full ? C.coral : '#c8b987', x + 3, y + 16, Math.min(1, b.buffer / receiverCapacity) * 11, 3);
    box(ctx, full ? C.coral : b.buffer > 0 ? '#e9db82' : C.mint, x + 17, y + 16, 4, 3);
  } else if (b.kind === 'analyzer') {
    const active = b.processing !== null;
    const status = b.outputBuffer > 0 ? '#edb866' : active ? MATERIALS.report.color : '#426c61';
    box(ctx, '#0a3028', x - 3, y - 18, 32, 44);
    box(ctx, '#94c6bc', x - 1, y - 18, 27, 5);
    box(ctx, '#568e80', x - 1, y - 13, 27, 35);
    box(ctx, '#345b50', x + 22, y - 12, 5, 34);
    box(ctx, '#102e28', x + 3, y - 9, 17, 15);
    box(ctx, '#204b38', x + 5, y - 7, 13, 10);
    const wave = active ? Math.floor(time * 8) % 8 : 0;
    for (let i = 0; i < 4; i++) box(ctx, active ? MATERIALS.report.color : '#377b74', x + 6 + i * 3, y - 4 + ((i + wave) % 3), 2, 2);
    box(ctx, '#8fb6a1', x + 2, y + 9, 18, 3);
    box(ctx, '#173d2e', x + 3, y + 15, 15, 5);
    box(ctx, status, x + 5, y + 16, 3, 2);
    box(ctx, active && Math.sin(time * 6) > 0 ? '#d6ffff' : status, x + 10, y + 16, 3, 2);
    box(ctx, '#d0eee4', x + 2, y - 16, 11, 1);
    box(ctx, '#204b38', x + 7, y + 23, 12, 3);
  } else if (b.kind === 'tester') {
    const active = b.processing !== null;
    const gold = MATERIALS.test.color;
    const status = b.outputBuffer > 0 ? '#edb866' : active ? gold : '#697b52';
    box(ctx, '#162f27', x - 4, y - 17, 33, 43);
    box(ctx, '#b4ac76', x - 2, y - 17, 29, 5);
    box(ctx, '#7c8059', x - 2, y - 12, 29, 34);
    box(ctx, '#485c42', x + 23, y - 11, 5, 33);
    box(ctx, '#1a3e32', x + 2, y - 8, 18, 15);
    box(ctx, '#315343', x + 4, y - 6, 14, 11);
    // A large gold check and three rack slots distinguish tests from analysis.
    box(ctx, active ? gold : '#9cac73', x + 6, y - 1, 3, 3);
    box(ctx, active ? gold : '#9cac73', x + 9, y + 1, 3, 3);
    box(ctx, active ? gold : '#9cac73', x + 12, y - 2, 3, 4);
    box(ctx, active ? gold : '#9cac73', x + 15, y - 5, 2, 4);
    for (let row = 0; row < 2; row++) {
      box(ctx, '#294833', x + 3, y + 10 + row * 6, 17, 4);
      const lit = active && Math.floor(time * 5) % 2 === row;
      box(ctx, lit ? '#fff3b2' : status, x + 4, y + 11 + row * 6, 3, 2);
      box(ctx, '#71815a', x + 10, y + 11 + row * 6, 8, 1);
    }
    box(ctx, '#ecdfac', x, y - 15, 12, 1);
    box(ctx, '#284c34', x + 5, y + 23, 15, 3);
  } else if (b.kind === 'uplink') {
    // The only selling point: a fixed mint terminal with an unmistakable dish.
    box(ctx, '#0b3027', x - 4, y - 12, 33, 38);
    box(ctx, '#a6cf9a', x - 2, y - 13, 29, 5);
    box(ctx, '#65946b', x - 2, y - 8, 29, 30);
    box(ctx, '#3e694d', x + 22, y - 7, 5, 29);
    box(ctx, '#102f27', x + 3, y - 5, 16, 15);
    arrow(ctx, x + 11, y + 3, 3, C.mint, 0.9);
    box(ctx, '#284d38', x + 3, y + 14, 16, 5);
    box(ctx, C.mint, x + 5, y + 15, 4, 2);
    box(ctx, '#bce5ab', x + 12, y + 15, 5, 2);
    box(ctx, '#729f75', x + 10, y - 25, 4, 13);
    poly(ctx, '#c1e4b6', [x - 1, y - 32, x + 25, y - 32, x + 21, y - 24, x + 15, y - 20, x + 8, y - 20, x + 2, y - 25]);
    box(ctx, '#719e77', x + 3, y - 31, 18, 3);
    box(ctx, '#e2f9d0', x + 10, y - 36, 3, 10);
    box(ctx, C.mint, x + 9, y - 38, 5, 3);
    box(ctx, '#b3cf97', x - 1, y - 11, 12, 1);
    box(ctx, '#234a34', x + 6, y + 23, 15, 3);
  }
  if (b.kind === 'analyzer' || b.kind === 'tester') {
    const recipe = PROCESSING[b.kind];
    const progress = b.processing ? Math.max(0, Math.min(1, 1 - b.processing.remaining / recipe.cycle)) : 0;
    const color = b.outputBuffer > 0 ? '#edb866' : MATERIALS[recipe.output].color;
    box(ctx, '#153c2e', x + 1, y + 26, 22, 4);
    box(ctx, b.processing || b.outputBuffer > 0 ? color : '#42684c', x + 2, y + 27, b.processing ? 20 * progress : b.outputBuffer > 0 ? 20 : 0, 2);
    // Two storage lamps: coral means full input, amber means output is waiting.
    box(ctx, b.buffer >= recipe.capacity ? C.coral : MATERIALS[recipe.input].color, x + 3, y + 21, 3, 3);
    box(ctx, b.outputBuffer > 0 ? '#edb866' : '#406b50', x + 17, y + 21, 3, 3);
  }
  const portColor = b.kind === 'receiver' ? MATERIALS.raw.color : b.kind === 'analyzer' ? MATERIALS.report.color
    : b.kind === 'tester' ? MATERIALS.test.color : C.mint;
  connectionPorts(ctx, x, y, connections, portColor);
}

function rover(ctx: CanvasRenderingContext2D, x: number, y: number, riding: boolean, time: number, facing = 1): void {
  shadow(ctx, x + 1, y + 15, 55, 15);
  const tread = riding ? Math.floor(time * 11) % 4 : 1;
  box(ctx, '#102c25', x - 24, y - 1, 11, 23);
  box(ctx, '#102c25', x + 14, y - 1, 11, 23);
  box(ctx, '#45624b', x - 22, y + 2, 7, 17);
  box(ctx, '#45624b', x + 16, y + 2, 7, 17);
  for (let i = 0; i < 4; i++) {
    box(ctx, '#77916a', x - 22, y + 2 + ((i * 5 + tread) % 17), 7, 2);
    box(ctx, '#77916a', x + 16, y + 2 + ((i * 5 + tread) % 17), 7, 2);
  }
  box(ctx, '#315b41', x - 16, y - 8, 34, 27);
  box(ctx, '#a4c68d', x - 16, y - 8, 34, 19);
  box(ctx, '#d1e0a7', x - 14, y - 8, 28, 3);
  box(ctx, '#163c2d', x - 9, y - 7, 17, 11);
  box(ctx, '#3c7050', x - 7, y - 5, 13, 7);
  box(ctx, '#7fa572', x - 14, y + 13, 29, 4);
  box(ctx, '#deebba', x - 13, y + 6, 6, 4);
  box(ctx, '#deebba', x + 8, y + 6, 6, 4);
  box(ctx, '#608b5d', x - 5, y + 7, 10, 2);
  box(ctx, '#0c3428', x - 28, y + 19, 59, 7);
  for (let i = 0; i < 12; i++) box(ctx, i % 2 ? '#7da76e' : C.mint, x - 27 + i * 5, y + 21, 3, 5);
  box(ctx, '#e68e67', x + 14, y - 15, 2, 8);
  box(ctx, C.coral, x + 12, y - 17, 6, 4);
  if (riding) drawLotti(ctx, x, y - 7, 0.67, time, facing, false);
}

function compact(ctx: CanvasRenderingContext2D, x: number, y: number, riding: boolean, time: number, facing = 1): void {
  shadow(ctx, x, y + 10, 40, 12);
  box(ctx, '#0b2c25', x - 19, y - 2, 7, 17);
  box(ctx, '#0b2c25', x + 12, y - 2, 7, 17);
  box(ctx, '#708b68', x - 18, y + 1, 4, 10);
  box(ctx, '#708b68', x + 14, y + 1, 4, 10);
  box(ctx, '#4d8a64', x - 13, y - 10, 26, 24);
  box(ctx, '#b3e0aa', x - 13, y - 11, 26, 16);
  box(ctx, '#d0f0c0', x - 11, y - 11, 22, 3);
  box(ctx, '#164133', x - 7, y - 9, 14, 9);
  box(ctx, '#579f81', x - 5, y - 7, 10, 5);
  box(ctx, '#edf6b9', x - 10, y + 2, 5, 3);
  box(ctx, '#edf6b9', x + 5, y + 2, 5, 3);
  box(ctx, '#56835d', x - 10, y + 9, 20, 4);
  box(ctx, '#15382b', x - 20, y + 13, 40, 5);
  for (let i = 0; i < 8; i++) box(ctx, i % 2 ? '#70b67b' : C.mint, x - 19 + i * 5, y + 15, 3, 4);
  if (riding) drawLotti(ctx, x, y - 6, 0.53, time, facing, false);
}

function vehicle(ctx: CanvasRenderingContext2D, kind: VehicleKind, x: number, y: number, riding: boolean, time: number, heading: number, speed = 0): void {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.rotate(heading - Math.PI / 2);
  const animation = Math.abs(speed) > 1 ? time : 0;
  if (kind === 'compact') compact(ctx, 0, 0, riding, animation);
  else rover(ctx, 0, 0, riding, animation);
  ctx.restore();
}

function vehicleSweep(ctx: CanvasRenderingContext2D, state: GameState, options: RenderOptions): void {
  const selected = getVehicle(state);
  if (!selected || !options.cleaning || options.build || state.player.bag >= getCapacity(state)) return;
  if (Math.abs(selected.speed) > VEHICLES[selected.kind].cleanSpeed + 1e-9) return;
  const sweep = getVehicleSweep(state);
  if (!sweep) return;
  ctx.save();
  ctx.translate(sweep.x, sweep.y);
  ctx.rotate(Math.atan2(sweep.forwardY, sweep.forwardX));
  ctx.fillStyle = '#81e9a617';
  ctx.fillRect(-sweep.depth / 2, -sweep.width / 2, sweep.depth, sweep.width);
  ctx.strokeStyle = '#b6ffc68c';
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(-sweep.depth / 2 + 0.5, -sweep.width / 2 + 0.5, sweep.depth - 1, sweep.width - 1);
  ctx.setLineDash([]);
  for (const sy of [-1, 1]) {
    ctx.fillStyle = C.mint;
    ctx.fillRect(sweep.depth / 2 - 2, sy * sweep.width / 2 - (sy > 0 ? 5 : 0), 2, 5);
  }
  ctx.restore();
}

function robot(ctx: CanvasRenderingContext2D, r: Robot, time: number): void {
  const industrial = r.kind === 'industrialRobot';
  ctx.save();
  ctx.translate(Math.round(r.x), Math.round(r.y));
  if (industrial) ctx.scale(2, 2);
  const x = 0;
  const y = 0;
  shadow(ctx, x, y + 9, 27, 10);
  box(ctx, '#102f27', x - 13, y - 5, 26, 17);
  box(ctx, industrial ? '#c5e7dc' : '#b1c59a', x - 11, y - 8, 22, 16);
  box(ctx, industrial ? '#edfff2' : '#daebbc', x - 7, y - 10, 14, 3);
  box(ctx, industrial ? '#59978b' : '#7ca477', x - 11, y + 5, 22, 5);
  box(ctx, '#2a5c41', x - 6, y - 5, 12, 8);
  box(ctx, r.mode === 'returning' ? C.coral : C.mint, x - 4, y - 3, 3, 2);
  box(ctx, r.mode === 'returning' ? C.coral : C.mint, x + 2, y - 3, 3, 2);
  box(ctx, '#163d2c', x - 3, y + 1, 6, 1);
  const a = time * 6 + r.id;
  for (let i = 0; i < 3; i++) {
    const angle = a + i * Math.PI * 2 / 3;
    box(ctx, '#9ecd8a', x + 12 + Math.cos(angle) * 6, y + 8 + Math.sin(angle) * 3, 4, 2);
  }
  const fill = Math.min(1, r.bag / r.capacity);
  box(ctx, '#1a462f', x - 8, y + 7, 16, 2);
  box(ctx, fill > 0.85 ? C.coral : C.mint, x - 8, y + 7, 16 * fill, 2);
  if (industrial) {
    box(ctx, '#e6fff0', -15, -6, 5, 3);
    box(ctx, '#e6fff0', 10, -6, 5, 3);
    box(ctx, '#e6fff0', -14, -11, 3, 5);
    box(ctx, '#e6fff0', 11, -11, 3, 5);
    box(ctx, '#65dce8', -6, -10, 12, 2);
    box(ctx, '#e9db82', -5, 4, 10, 2);
    box(ctx, '#e9db82', 8, -15, 2, 6);
    box(ctx, '#d9fff4', 7, -16, 4, 3);
  }
  ctx.restore();
}

function drawTool(ctx: CanvasRenderingContext2D, state: GameState, options: RenderOptions, moving: boolean): void {
  const p = state.player;
  const active = options.cleaning && !options.paused;
  const radius = TOOLS[p.tool].radius;
  const angle = Math.atan2(p.facingY, p.facingX) + (active ? Math.sin(state.time * 19) * 0.6 : 0.35);
  const reach = p.riding ? 26 : 18;
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y - (p.riding ? -11 : 9)));
  ctx.rotate(angle);
  if (active) {
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = C.mint;
    ctx.beginPath();
    ctx.arc(0, 0, radius, -0.8, 0.8);
    ctx.lineTo(0, 0);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  box(ctx, '#15392d', 3, 0, reach + 6, 4);
  box(ctx, '#c2c98e', 4, 0, reach + 4, 2);
  if (p.tool === 'toothbrush') {
    box(ctx, '#f0dec2', reach + 5, -3, 4, 7);
    box(ctx, C.coral, reach + 9, -3, 3, 7);
    box(ctx, '#ffd5b7', reach + 10, -3, 2, 2);
  } else {
    const breadth = p.tool === 'handbrush' ? 13 : p.tool === 'broom' ? 23 : 34;
    box(ctx, '#082e25', reach + 3, -breadth / 2 - 1, 9, breadth + 2);
    box(ctx, p.tool === 'widebrush' ? '#c3e6af' : '#9fc392', reach + 3, -breadth / 2, 5, breadth);
    box(ctx, C.mint, reach + 8, -breadth / 2, 5, breadth);
    for (let i = 0; i < breadth; i += 4) box(ctx, '#3a7652', reach + 10, -breadth / 2 + i, 3, 1);
  }
  if (active || moving) {
    for (let i = 0; i < (active ? 9 : 2); i++) {
      const phase = (state.time * 2.6 + i * 0.19) % 1;
      const spread = hash(i, 92) * 2 - 1;
      box(ctx, i % 3 ? '#c4eaa6' : C.coral, reach + 6 + phase * 15, spread * (5 + phase * radius * 0.5), phase < 0.5 ? 2 : 1, 2);
    }
  }
  ctx.restore();
}

function placement(ctx: CanvasRenderingContext2D, state: GameState, options: RenderOptions, view: { x: number; y: number; w: number; h: number }): void {
  if (!options.build && !options.showGrid) return;
  const p = state.player;
  const left = Math.floor(Math.max(view.x, p.x - 170) / BUILD_CELL) * BUILD_CELL;
  const top = Math.floor(Math.max(view.y, p.y - 150) / BUILD_CELL) * BUILD_CELL;
  const right = Math.min(view.x + view.w, p.x + 170);
  const bottom = Math.min(view.y + view.h, p.y + 150);
  ctx.strokeStyle = '#b5eab224';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = left; x < right; x += BUILD_CELL) { ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bottom); }
  for (let y = top; y < bottom; y += BUILD_CELL) { ctx.moveTo(left, y + 0.5); ctx.lineTo(right, y + 0.5); }
  ctx.stroke();
  if (!options.pointer || !options.build) return;
  const gx = Math.floor(options.pointer.x / BUILD_CELL);
  const gy = Math.floor(options.pointer.y / BUILD_CELL);
  const x = gx * BUILD_CELL;
  const y = gy * BUILD_CELL;
  const existing = state.buildings.find(b => b.gx === gx && b.gy === gy);
  const removable = !!existing && existing.kind !== 'uplink'
    && Math.hypot(x + 12 - p.x, y + 12 - p.y) <= 150;
  const valid = options.build.kind === 'remove' ? removable : canPlaceBuilding(state, options.build.kind, gx, gy);
  const color = valid ? C.mint : C.coral;
  ctx.globalAlpha = 0.15;
  box(ctx, color, x, y, BUILD_CELL, BUILD_CELL);
  ctx.globalAlpha = 0.65;
  if (options.build.kind !== 'remove') building(ctx, state, { id: -1, gx, gy, kind: options.build.kind, dir: options.build.dir, buffer: 0, cooldown: 0, outputBuffer: 0, processing: null }, state.time, getReceiverCapacity(state));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.strokeRect(x + 0.5, y + 0.5, 23, 23);
  if (options.build.kind === 'remove') {
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x + 7, y + 7); ctx.lineTo(x + 17, y + 17); ctx.moveTo(x + 17, y + 7); ctx.lineTo(x + 7, y + 17); ctx.stroke();
  }
}

export function hitTestBuilding(state: GameState, point: Vec): Building | undefined {
  return state.buildings.filter(b => point.x >= b.gx * BUILD_CELL - (b.kind === 'belt' ? 0 : 4)
    && point.x <= (b.gx + 1) * BUILD_CELL + (b.kind === 'belt' ? 0 : 4)
    && point.y >= b.gy * BUILD_CELL - (b.kind === 'uplink' ? 39 : b.kind === 'belt' ? 0 : 18)
    && point.y <= (b.gy + 1) * BUILD_CELL + (b.kind === 'belt' ? 0 : 3))
    .sort((a, b) => Math.hypot(point.x - (a.gx + 0.5) * BUILD_CELL, point.y - (a.gy + 0.5) * BUILD_CELL)
      - Math.hypot(point.x - (b.gx + 0.5) * BUILD_CELL, point.y - (b.gy + 0.5) * BUILD_CELL))[0];
}

export function renderWorld(ctx: CanvasRenderingContext2D, state: GameState, options: RenderOptions): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const camera = { x: Math.round(options.camera.x), y: Math.round(options.camera.y) };
  const view = { ...camera, w: width, h: height };
  const visible = (x: number, y: number, w = 0, h = 0): boolean => x + w >= view.x - 50 && y + h >= view.y - 60 && x < view.x + width + 50 && y < view.y + height + 50;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  box(ctx, C.void, 0, 0, width, height);
  ctx.translate(-camera.x, -camera.y);
  terrain(ctx, state, view);
  if (visible(HUB.x - BASE_HALF_SIZE - 5, HUB.y - BASE_HALF_SIZE - 5, BASE_HALF_SIZE * 2 + 10, BASE_HALF_SIZE * 2 + 10)) hub(ctx, state.time, view);
  dust(ctx, state, view);
  vehicleSweep(ctx, state, options);
  const obstacles = state.obstacles.filter(o => visible(o.x, o.y, o.w, o.h));
  for (const o of obstacles) if (o.kind === 'water') drawWater(ctx, o, state.time);
  for (const landmark of state.landmarks) {
    if (!visible(landmark.x, landmark.y)) continue;
    const seen = state.discoveries.includes(landmark.id);
    const color = seen ? C.mint : '#c3b985';
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 5]);
    ctx.strokeRect(landmark.x - 24 + 0.5, landmark.y - 24 + 0.5, 48, 48);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    box(ctx, '#0e3629', landmark.x - 4, landmark.y - 8, 9, 10);
    box(ctx, color, landmark.x - 2, landmark.y - 7, 5, 5);
    if (Math.hypot(state.player.x - landmark.x, state.player.y - landmark.y) < 150) label(ctx, landmark.name, landmark.x, landmark.y - 37, seen ? C.mint : C.pale, 9);
  }
  // Belts sit beneath machines, capsules and characters.
  for (const b of state.buildings) if (b.kind === 'belt' && visible(b.gx * 24, b.gy * 24)) building(ctx, state, b, state.time, getReceiverCapacity(state));
  for (const capsule of state.capsules) {
    const dir = DIRECTIONS[capsule.dir];
    const x = (capsule.gx + 0.5) * 24 + dir.x * capsule.progress * 24;
    const y = (capsule.gy + 0.5) * 24 + dir.y * capsule.progress * 24;
    if (!visible(x, y)) continue;
    shadow(ctx, x, y + 4, 11, 6);
    box(ctx, '#153b2d', x - 5, y - 4, 11, 9);
    box(ctx, '#e4dab2', x - 4, y - 4, 9, 7);
    const material = MATERIALS[capsule.material];
    box(ctx, material.color, x - 3, y - 3, 4, 5);
    box(ctx, '#fff3d2', x + 1, y - 3, 3, 2);
    if (capsule.material === 'report') {
      box(ctx, '#d4ffff', x - 2, y - 2, 4, 1);
      box(ctx, '#d4ffff', x - 2, y, 3, 1);
    } else if (capsule.material === 'test') {
      box(ctx, '#4b5937', x - 2, y, 2, 2);
      box(ctx, '#4b5937', x, y - 2, 2, 3);
    }
  }
  // Sorting around the feet keeps trees and lab equipment naturally in front.
  const layers: { y: number; draw: () => void }[] = [];
  for (const o of obstacles) {
    if (o.kind === 'water') continue;
    layers.push({ y: o.y + o.h, draw: () => {
      if (o.kind === 'tree') drawTree(ctx, o);
      else if (o.kind === 'server') drawServer(ctx, o, state.time);
      else drawRock(ctx, o);
    } });
  }
  for (const b of state.buildings) if (b.kind !== 'belt' && visible(b.gx * 24, b.gy * 24)) layers.push({ y: b.gy * 24 + 24, draw: () => building(ctx, state, b, state.time, getReceiverCapacity(state)) });
  for (const kind of Object.keys(STATIONS) as StationKind[]) {
    const location = STATIONS[kind];
    if (visible(location.x - 48, location.y - 60, 96, 80)) layers.push({ y: location.y + 14, draw: () => station(ctx, kind) });
  }
  const selectedVehicle = getVehicle(state);
  for (const parked of state.vehicles) {
    if (state.player.riding && parked.kind === selectedVehicle?.kind || !visible(parked.x, parked.y)) continue;
    layers.push({ y: parked.y + 20, draw: () => vehicle(ctx, parked.kind, parked.x, parked.y, false, state.time, parked.heading, parked.speed) });
  }
  for (const helper of state.robots) if (visible(helper.x, helper.y)) layers.push({ y: helper.y + (helper.kind === 'industrialRobot' ? 20 : 10), draw: () => robot(ctx, helper, state.time) });
  const player = state.player;
  const previous = motion.get(state);
  const changed = previous && Math.hypot(player.x - previous.x, player.y - previous.y) > 0.05;
  const movingUntil = changed ? state.time + 0.12 : previous?.until ?? 0;
  const moving = !options.paused && state.time < movingUntil;
  motion.set(state, { x: player.x, y: player.y, until: movingUntil });
  layers.push({ y: player.y + 7, draw: () => {
    if (player.riding && selectedVehicle) vehicle(ctx, selectedVehicle.kind, selectedVehicle.x, selectedVehicle.y, true, state.time, selectedVehicle.heading, selectedVehicle.speed);
    else {
      shadow(ctx, player.x, player.y + 3, 29, 10);
      drawLotti(ctx, player.x, player.y + 2, 1, options.paused ? 0 : state.time, player.facingX, moving);
    }
    if (!options.build && !player.riding) drawTool(ctx, state, options, moving);
  } });
  layers.sort((a, b) => a.y - b.y);
  for (const layer of layers) layer.draw();
  placement(ctx, state, options, view);
  // The HUD owns the single action prompt; keep world sprites free of duplicate labels.
  for (const event of state.events) {
    if (!visible(event.x, event.y)) continue;
    const age = Math.max(0, state.time - event.time);
    if (age > 2.2) continue;
    ctx.globalAlpha = Math.min(1, (2.2 - age) / 0.6);
    if (event.kind === 'clean') {
      for (let i = 0; i < 5; i++) {
        const angle = hash(event.id, i) * Math.PI * 2;
        const distance = age * (12 + hash(i, event.id) * 16);
        box(ctx, i % 2 ? '#c5e8a3' : C.coral, event.x + Math.cos(angle) * distance, event.y + Math.sin(angle) * distance - age * 9, 2, 2);
      }
    } else if (event.kind === 'credit') {
      label(ctx, event.text || `+${event.amount ?? 0} ₽`, event.x, event.y - 26 - age * 14, C.mint, 11);
      box(ctx, '#d9ffba', event.x - 23 + age * 4, event.y - 29 - age * 10, 2, 5);
    } else if (event.kind === 'purchase' || event.kind === 'discover') {
      for (let i = 0; i < 7; i++) {
        const angle = i * Math.PI * 2 / 7;
        box(ctx, i % 2 ? C.mint : '#fff4bf', event.x + Math.cos(angle) * (12 + age * 23), event.y - 13 + Math.sin(angle) * (12 + age * 16), 3, 3);
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

export function renderMinimap(ctx: CanvasRenderingContext2D, state: GameState): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const pad = 4;
  const scale = Math.min((width - pad * 2) / WORLD_W, (height - pad * 2) / WORLD_H);
  const ox = Math.round((width - WORLD_W * scale) / 2);
  const oy = Math.round((height - WORLD_H * scale) / 2);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  box(ctx, '#0b2922', 0, 0, width, height);
  box(ctx, '#275741', ox, oy, WORLD_W * scale, WORLD_H * scale);
  // Four-cell blocks preserve coral regions while keeping the tiny map legible.
  for (let gy = 0; gy < GRID_H; gy += 4) {
    for (let gx = 0; gx < GRID_W; gx += 4) {
      let dirty = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) dirty += Math.min(1, state.dust[(gy + dy) * GRID_W + gx + dx] || 0);
      if (dirty <= 0) continue;
      ctx.globalAlpha = 0.3 + Math.min(1, dirty / 16) * 0.6;
      box(ctx, '#da8a60', ox + gx * CELL * scale, oy + gy * CELL * scale, CELL * 4 * scale + 0.5, CELL * 4 * scale + 0.5);
    }
  }
  ctx.globalAlpha = 1;
  for (const o of state.obstacles) box(ctx, o.kind === 'water' ? '#183d3c' : '#18432f', ox + o.x * scale, oy + o.y * scale, Math.max(2, o.w * scale), Math.max(2, o.h * scale));
  box(ctx, '#285a44', ox + (HUB.x - BASE_HALF_SIZE) * scale, oy + (HUB.y - BASE_HALF_SIZE) * scale, BASE_HALF_SIZE * 2 * scale, BASE_HALF_SIZE * 2 * scale);
  ctx.strokeStyle = '#8acb9466';
  ctx.strokeRect(ox + (HUB.x - BASE_HALF_SIZE) * scale, oy + (HUB.y - BASE_HALF_SIZE) * scale, BASE_HALF_SIZE * 2 * scale, BASE_HALF_SIZE * 2 * scale);
  for (const landmark of state.landmarks) {
    if (!state.discoveries.includes(landmark.id)) continue;
    box(ctx, '#a8d9a1', ox + landmark.x * scale - 1, oy + landmark.y * scale - 1, 3, 3);
  }
  // Belts reveal remote routes; material colours distinguish the production chain.
  for (const b of state.buildings) {
    if (b.kind !== 'belt') continue;
    box(ctx, '#7a9e72', ox + (b.gx * 24 + 12) * scale, oy + (b.gy * 24 + 12) * scale, 2, 2);
  }
  for (const b of state.buildings) {
    if (b.kind === 'belt') continue;
    const color = b.kind === 'receiver' ? MATERIALS.raw.color
      : b.kind === 'analyzer' ? MATERIALS.report.color
      : b.kind === 'tester' ? MATERIALS.test.color : C.mint;
    const bx = ox + (b.gx * 24 + 12) * scale;
    const by = oy + (b.gy * 24 + 12) * scale;
    box(ctx, '#0a2c24', bx - 2, by - 2, 5, 5);
    box(ctx, color, bx - 1, by - 1, 3, 3);
  }
  for (const terminal of TERMINALS) {
    const tx = Math.round(ox + terminal.x * scale);
    const ty = Math.round(oy + terminal.y * scale);
    box(ctx, '#092b22', tx - 2, ty - 2, 5, 5);
    box(ctx, C.mint, tx - 1, ty - 1, 3, 3);
  }
  for (const kind of Object.keys(STATIONS) as StationKind[]) {
    const location = STATIONS[kind];
    box(ctx, kind === 'workshop' ? '#d9eab2' : '#65dce8', ox + location.x * scale - 1, oy + location.y * scale - 1, 3, 3);
  }
  for (const helper of state.robots) box(ctx, helper.kind === 'industrialRobot' ? '#69d9ff' : '#cdb4ff', ox + helper.x * scale - 1, oy + helper.y * scale - 1, helper.kind === 'industrialRobot' ? 3 : 2, 2);
  for (const parked of state.vehicles) box(ctx, parked.kind === 'compact' ? '#81e9a6' : '#c8b988', ox + parked.x * scale - 1, oy + parked.y * scale - 1, 3, 2);
  const px = Math.round(ox + state.player.x * scale);
  const py = Math.round(oy + state.player.y * scale);
  box(ctx, '#0a2f25', px - 3, py - 3, 7, 7);
  box(ctx, '#ffffff', px - 1, py - 2, 3, 5);
  box(ctx, '#ffffff', px - 2, py - 1, 5, 3);
  ctx.strokeStyle = '#77a779';
  ctx.strokeRect(ox - 0.5, oy - 0.5, Math.round(WORLD_W * scale) + 1, Math.round(WORLD_H * scale) + 1);
  ctx.restore();
}
