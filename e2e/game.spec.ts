import { createFactoryGame as createGame } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { getCapacity, getWalkingCapacity, placeBuilding, updateGame } from '../src/game/engine';
import { serializeGame, SAVE_KEY } from '../src/game/persistence';
import { clickCell, walkTo } from './helpers';
import { BUILDINGS, CELL, ECONOMY, GRID_W, STATIONS, TERMINALS, TOOLS, type GameState } from '../src/game/types';

const baseGX=Math.floor(TERMINALS[0].x/24),baseGY=Math.floor(TERMINALS[0].y/24);

function qualifyVehicle(state: GameState) {
  state.ownedTools = Object.keys(TOOLS) as GameState['ownedTools'];
  state.player.capacityLevel = 2;
  state.stats.testsSold = ECONOMY.vehicleTests; state.stats.delivered = ECONOMY.vehicleTests;
}
function qualifyRobot(state: GameState) {
  qualifyVehicle(state); state.vehicles.push({kind:'vehicle',x:TERMINALS[0].x,y:TERMINALS[0].y + 57,heading:Math.PI/2,speed:0});
  state.stats.testsSold = ECONOMY.robotTests; state.stats.delivered = ECONOMY.robotTests;
}

function constructRawLine(state: GameState) {
  const price = BUILDINGS.receiver.price + 3 * BUILDINGS.belt.price;
  state.credits += price; state.earned += price;
  for (const [kind, gx] of [['receiver', baseGX-4], ['belt', baseGX-3], ['belt', baseGX-2], ['belt', baseGX-1]] as const) {
    expect(placeBuilding(state, kind, gx, baseGY, 0).ok).toBe(true);
  }
}
function collectFixtureCargo(state: GameState, amount: number) {
  let remaining = amount;
  for (let i = 0; remaining && i < state.dust.length; i++) {
    const taken = Math.min(remaining, state.dust[i]);
    state.dust[i] -= taken; state.cleaned += taken; state.player.bag += taken; remaining -= taken;
  }
  expect(remaining).toBe(0);
}

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Начать уборку', exact: true }).click();
  await expect(page.getByTestId('game-hud')).toBeVisible();
}
async function hold(page: Page, key: string, ms: number) {
  await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key);
}

test('new player can sweep, fill a container, return and earn credits', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await walkTo(page, { x: TERMINALS[2].x - 60, y: TERMINALS[2].y + 70 });
  await page.keyboard.down('Space');
  await hold(page, 'a', 1000);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('bag-count')).not.toHaveText('0');
  await walkTo(page, TERMINALS[2]);
  await page.keyboard.press('e');
  await expect(page.getByTestId('credits')).not.toHaveText('0');
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('pause freezes the world, progress survives reload, help can be dismissed', async ({ page }) => {
  await start(page);
  await walkTo(page, { x: TERMINALS[2].x - 60, y: TERMINALS[2].y + 70 });
  await hold(page, 'Space', 1500);
  const bag = await page.getByTestId('bag-count').innerText();
  expect(Number(bag)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Пауза' })).toBeVisible();
  const position = await page.locator('#coordinates').innerText();
  await hold(page, 'w', 500);
  await expect(page.locator('#coordinates')).toHaveText(position);
  await expect(page.getByTestId('bag-count')).toHaveText(bag);
  await page.reload();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByTestId('bag-count')).toHaveText(bag);
  await page.getByRole('button', { name: 'Как играть', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Как играть' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('earned credits buy real upgrades, rover, vacuum and conveyor construction', async ({ page }) => {
  const state = createGame(88); state.credits = 50000; state.earned = 50000;
  state.stats.testsSold = ECONOMY.robotTests; state.stats.delivered = ECONOMY.robotTests;
  constructRawLine(state); Object.assign(state.player,STATIONS.workshop);
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: serializeGame(state) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.keyboard.press('m');
  await page.getByRole('button', { name: 'Купить Ручная щётка', exact: true }).click();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Ручная щётка');
  await page.getByRole('button', { name: 'Купить Большая щётка', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Турбощётка', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Больше контейнер', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Больше контейнер', exact: true }).click();
  await page.keyboard.press('Escape'); await walkTo(page,STATIONS.garage); await page.keyboard.press('m');
  await page.getByRole('button', { name: 'Купить Уборочная машина', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Робот-пылесос', exact: true }).click();
  await expect(page.getByTestId('robot-status')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Строительство', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать Конвейер', exact: true }).click();
  await clickCell(page,baseGX+15,baseGY+12);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(saved.ownedTools).toContain('handbrush');
  expect(saved.vehicles.some((v:any)=>v.kind==='vehicle')).toBe(true);
  expect(saved.robots).toHaveLength(1);
  expect(saved.stats.built).toBeGreaterThan(0);
  expect(saved.credits).toBeLessThan(50000);
});

test('keyboard activates dialogs and mouse cleaning follows the cursor', async ({ page }) => {
  await start(page);
  await walkTo(page, TERMINALS[2]);
  await page.keyboard.press('m');
  await expect(page.getByRole('dialog', { name: 'Терминал продажи' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await walkTo(page, { x: TERMINALS[2].x - 75, y: TERMINALS[2].y + 75 });
  const canvas = await page.locator('#world').boundingBox();
  if (!canvas) throw new Error('Canvas missing');
  await page.mouse.move(canvas.x + canvas.width / 2 + 100, canvas.y + canvas.height / 2);
  await page.mouse.down(); await page.waitForTimeout(1200); await page.mouse.up();
  await expect(page.getByTestId('bag-count')).not.toHaveText('0');
});

test('receiver packs bugs, capsules travel down a constructed raw conveyor and pay out', async ({ page }) => {
  const state = createGame(42);
  state.player.x = TERMINALS[0].x - 120; state.player.y = TERMINALS[0].y + 132;
  for (let i = 0; i < 100; i++) updateGame(state, .05, { dx: 1, dy: 0, clean: true });
  const load = state.player.bag;
  expect(load).toBeGreaterThan(0);
  state.player.x = TERMINALS[0].x - 96; state.player.y = TERMINALS[0].y + 32;
  constructRawLine(state);
  const balance=state.credits;
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: serializeGame(state) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.keyboard.press('e');
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  const inTransit = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(inTransit.capsules.length).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByTestId('credits')).toHaveText((balance+load).toLocaleString('ru'), { timeout: 15_000 });
  await page.keyboard.press('Escape');
  const result = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(result.stats.capsules).toBeGreaterThan(0);
  expect(result.capsules).toHaveLength(0);
  expect(result.stats.delivered).toBe(load);
});

test('vacuum works autonomously and credits arrive through the conveyor', async ({ page }) => {
  await page.clock.install();
  const state = createGame(42); qualifyRobot(state); state.credits = ECONOMY.robot; state.earned = ECONOMY.robot;
  const line = [['receiver',baseGX+3,baseGY+2],['belt',baseGX+3,baseGY+1],['belt',baseGX+3,baseGY],['belt',baseGX+2,baseGY],['belt',baseGX+1,baseGY]] as const;
  const cost = BUILDINGS.receiver.price + 4 * BUILDINGS.belt.price;
  state.credits += cost; state.earned += cost;
  for(const [kind,gx,gy] of line) expect(placeBuilding(state,kind,gx,gy,0).ok).toBe(true);
  Object.assign(state.player,STATIONS.garage);
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: serializeGame(state) });
  await page.goto('/'); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.keyboard.press('m');
  await page.getByRole('button', { name: 'Купить Робот-пылесос', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.clock.runFor(25000);
  await expect(page.getByTestId('credits')).not.toHaveText('0', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  const result = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(result.stats.robotCleaned).toBeGreaterThan(0);
  expect(result.stats.delivered).toBeGreaterThan(0);
  expect(result.stats.capsules).toBeGreaterThan(0);
});

test('rover sweeps in front, keeps excess cargo on refused exit and unloads at a corner', async ({ page }) => {
  const state = createGame(42); qualifyVehicle(state);
  const terminal = TERMINALS[2];
  Object.assign(state.player, { x: terminal.x, y: terminal.y + 70 });
  state.vehicles.push({ kind: 'vehicle', x: state.player.x, y: state.player.y, heading: Math.PI / 2, speed: 0 });
  collectFixtureCargo(state, getWalkingCapacity(state) - 20);
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: serializeGame(state) });
  await page.goto('/'); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.keyboard.press('v');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Уборочная машина');
  await expect(page.locator('#bag-capacity')).toHaveText(String(ECONOMY.vehicleCapacity * ECONOMY.capacityMultipliers[state.player.capacityLevel]));
  await page.keyboard.down('Space'); await hold(page, 'w', 1800); await page.keyboard.up('Space');
  expect(Number(await page.getByTestId('bag-count').innerText())).toBeGreaterThan(getWalkingCapacity(state));
  await page.keyboard.press('v');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Уборочная машина');
  for (let i = 0; i < 20; i++) {
    const [, y] = (await page.locator('#coordinates').innerText()).match(/\d+/g)!.map(Number);
    if (y <= terminal.y + 60) break;
    await hold(page, 's', 200);
  }
  await page.keyboard.press('e'); await page.keyboard.press('v');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Зубная щётка');
  await expect(page.getByTestId('bag-count')).toHaveText('0');
});

test('the last bugs complete the world and the player can keep exploring', async ({ page }) => {
  const state = createGame(42); state.dust.fill(0);
  state.dust[Math.floor((state.player.y+20)/CELL)*GRID_W+Math.floor(state.player.x/CELL)]=3;
  state.cleaned = state.totalDirt - 3;
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: serializeGame(state) });
  await page.goto('/'); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await hold(page, 'Space', 800);
  await expect(page.getByRole('dialog', { name: 'PROD сияет!' })).toBeVisible();
  await page.getByRole('button', { name: 'Остаться в мире' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#clean-percent')).toHaveText('100,0');
});

test('a loaded receiver can be rotated into a working route to the base terminal', async ({ page }) => {
  const state = createGame(42);
  state.player.x = TERMINALS[0].x - 120; state.player.y = TERMINALS[0].y + 132;
  for (let i = 0; i < 100; i++) updateGame(state, .05, { dx: 1, dy: 0, clean: true });
  const load = state.player.bag; expect(load).toBeGreaterThan(0);
  state.player.x = TERMINALS[0].x; state.player.y = TERMINALS[0].y + 57; state.credits = 500;
  expect(placeBuilding(state, 'receiver', baseGX, baseGY+3, 0).ok).toBe(true);
  expect(placeBuilding(state, 'belt', baseGX, baseGY+2, 3).ok).toBe(true);
  expect(placeBuilding(state, 'belt', baseGX, baseGY+1, 3).ok).toBe(true);
  const balance = state.credits;
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: serializeGame(state) });
  await page.goto('/'); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.keyboard.press('e'); await page.keyboard.press('b');
  const canvas = page.locator('#world'); const rect = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  if (!rect) throw new Error('Canvas missing');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + 15 * rect.height / size.height);
  await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r');
  await expect(page.getByTestId('credits')).toHaveText(String(balance + load), { timeout: 15_000 });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const result = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(result.buildings.find((b: any) => b.gx === baseGX && b.gy === baseGY+3).dir).toBe(3);
  expect(result.stats.delivered).toBe(load);
});
