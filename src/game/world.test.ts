import { describe, expect, it } from 'vitest';
import { createGame } from './engine';
import { buildWalkability } from './world';
import { BASE_HALF_SIZE, CELL, DIRECTIONS, GRID_H, GRID_W, HUB, LEGACY_GRID_H, LEGACY_GRID_W, SPAWN, STATIONS, TERMINALS, WORLD_H, WORLD_W } from './types';

describe('expanded PROD world', () => {
  it('adds distinct districts and resources beyond the starting region', () => {
    const state = createGame(42);
    const outer = state.landmarks.filter(l => l.x >= LEGACY_GRID_W * CELL || l.y >= LEGACY_GRID_H * CELL);
    expect(outer.length).toBeGreaterThanOrEqual(12);
    expect(new Set(state.landmarks.map(l => l.id)).size).toBe(state.landmarks.length);
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      let dust = 0;
      for (let y = sy * LEGACY_GRID_H; y < (sy + 1) * LEGACY_GRID_H; y++)
        for (let x = sx * LEGACY_GRID_W; x < (sx + 1) * LEGACY_GRID_W; x++) dust += state.dust[y * GRID_W + x];
      expect(dust).toBeGreaterThan(10000);
    }
    expect(state.dust.length).toBe(GRID_W * GRID_H);
    expect(state.totalDirt).toBe(state.dust.reduce((sum, value) => sum + value, 0));
  });

  it('keeps both purchase stations clear and generates independent deterministic saves', () => {
    const a = createGame(42), b = createGame(42);
    expect(a.dust).toEqual(b.dust);
    expect(a.obstacles).toEqual(b.obstacles);
    for (const station of Object.values(STATIONS)) {
      expect(a.obstacles.some(o => station.x >= o.x - 32 && station.x <= o.x + o.w + 32 && station.y >= o.y - 32 && station.y <= o.y + o.h + 32)).toBe(false);
    }
    a.dust.fill(0); a.obstacles[0].x = 0;
    expect(b.dust.some(Boolean)).toBe(true);
    expect(b.obstacles[0].x).not.toBe(0);
  });

  it('places a clear logistics base in the middle of the map with four open corner terminals', () => {
    const state = createGame(42);
    expect(Math.abs(HUB.x-WORLD_W/2)).toBeLessThanOrEqual(12);
    expect(Math.abs(HUB.y-WORLD_H/2)).toBeLessThanOrEqual(12);
    expect(state.buildings.filter(b=>b.kind==='uplink')).toHaveLength(4);
    for(const terminal of TERMINALS) {
      expect(state.buildings.some(b=>b.kind==='uplink' && b.gx===Math.floor(terminal.x/24) && b.gy===Math.floor(terminal.y/24))).toBe(true);
      expect(state.obstacles.some(o=>terminal.x>=o.x-24&&terminal.x<=o.x+o.w+24&&terminal.y>=o.y-24&&terminal.y<=o.y+o.h+24)).toBe(false);
    }
    for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++)
      if(Math.abs(x*CELL+6-HUB.x)<=BASE_HALF_SIZE&&Math.abs(y*CELL+6-HUB.y)<=BASE_HALF_SIZE)
        expect(state.dust[y*GRID_W+x]).toBe(0);
  });
});


describe('larger v5 resource world', () => {
  it('populates the new eastern and southern strips with in-bounds landmarks, scenery and richer distant dust', () => {
    const state = createGame(42);
    expect(GRID_W).toBe(448); expect(GRID_H).toBe(336); expect(state.version).toBe(5);
    expect(state.landmarks.some(landmark => landmark.x > 4608)).toBe(true);
    expect(state.landmarks.some(landmark => landmark.y > 3456)).toBe(true);
    expect(state.obstacles.some(obstacle => obstacle.x > 4608)).toBe(true);
    expect(state.landmarks.every(landmark => landmark.x >= 0 && landmark.x <= WORLD_W && landmark.y >= 0 && landmark.y <= WORLD_H)).toBe(true);
    expect(state.obstacles.every(obstacle => obstacle.x >= 0 && obstacle.x + obstacle.w <= WORLD_W && obstacle.y >= 0 && obstacle.y + obstacle.h <= WORLD_H)).toBe(true);
    const near: number[] = [], far: number[] = [];
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      const layers = state.dust[y * GRID_W + x]; if (!layers) continue;
      const radius = Math.max(Math.abs(x*CELL+6-HUB.x)/(WORLD_W/2), Math.abs(y*CELL+6-HUB.y)/(WORLD_H/2));
      if (radius < .3) near.push(layers); if (radius > .85) far.push(layers);
    }
    expect(far.reduce((a,b)=>a+b,0)/far.length).toBeGreaterThan(near.reduce((a,b)=>a+b,0)/near.length + 1);
  });
});


it('keeps every required dust cell reachable from the central spawn across the enlarged map', () => {
  const state = createGame(7), walkable = buildWalkability(state.obstacles);
  const seen = new Uint8Array(GRID_W * GRID_H), queue = new Int32Array(GRID_W * GRID_H);
  const start = Math.floor(SPAWN.y/CELL)*GRID_W + Math.floor(SPAWN.x/CELL);
  queue[0] = start; seen[start] = 1;
  let head = 0, tail = 1;
  while (head < tail) {
    const current = queue[head++], x = current % GRID_W, y = Math.floor(current/GRID_W);
    for (const direction of DIRECTIONS) {
      const nx = x+direction.x, ny = y+direction.y, next = ny*GRID_W+nx;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H || seen[next] || !walkable[next]) continue;
      seen[next] = 1; queue[tail++] = next;
    }
  }
  let accessibleDust = 0;
  for (let index = 0; index < state.dust.length; index++) if (seen[index]) accessibleDust += state.dust[index];
  expect(accessibleDust).toBe(state.totalDirt);
});
