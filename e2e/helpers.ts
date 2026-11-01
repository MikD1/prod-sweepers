import { createGame } from '../src/game/engine';
import { TERMINALS, WORLD_H, WORLD_W } from '../src/game/types';
import { type Page } from '@playwright/test';
import { type Vec } from '../src/game/types';

/** Walk through the actual browser controls, allowing for HUD refresh and different speeds. */
export async function walkTo(page: Page, target: Vec, tolerance = 28) {
  for (let i = 0; i < 40; i++) {
    const [x, y] = (await page.locator('#coordinates').innerText()).match(/\d+/g)!.map(Number);
    const dx = target.x - x, dy = target.y - y;
    if (Math.hypot(dx, dy) <= tolerance) return;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const delta = horizontal ? dx : dy;
    const key = horizontal ? delta > 0 ? 'd' : 'a' : delta > 0 ? 's' : 'w';
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.max(100, Math.min(500, Math.abs(delta) / 150 * 1000)));
    await page.keyboard.up(key);
    await page.waitForTimeout(120);
  }
  throw Error(`Could not reach ${target.x},${target.y}; current position ${await page.locator('#coordinates').innerText()}`);
}

export async function pointForCell(page: Page, gx: number, gy: number) {
  await page.waitForTimeout(150);
  const [px, py] = (await page.locator('#coordinates').innerText()).match(/\d+/g)!.map(Number);
  const canvas = page.locator('#world'), rect = (await canvas.boundingBox())!;
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  const cameraX = Math.max(0, Math.min(WORLD_W - size.width, px - size.width / 2));
  const cameraY = Math.max(0, Math.min(WORLD_H - size.height, py - size.height / 2));
  return { x: rect.x + (gx * 24 + 12 - cameraX) * rect.width / size.width,
    y: rect.y + (gy * 24 + 12 - cameraY) * rect.height / size.height };
}

export async function clickCell(page: Page, gx: number, gy: number) {
  const point = await pointForCell(page, gx, gy);
  await page.mouse.click(point.x, point.y);
}

/** Factory scenarios use the north-west terminal and real canonical v4 saves. */
export function createFactoryGame(seed: number) {
  const state = createGame(seed);
  Object.assign(state.player, { x: TERMINALS[0].x, y: TERMINALS[0].y + 57 });
  return state;
}
