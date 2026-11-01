import { createFactoryGame as createGame } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { placeBuilding, updateGame } from '../src/game/engine';
import { serializeGame, SAVE_KEY } from '../src/game/persistence';
import { walkTo } from './helpers';
import { BUILDINGS, ECONOMY, STATIONS, TERMINALS, type GameState } from '../src/game/types';

const baseGX=Math.floor(TERMINALS[0].x/24),baseGY=Math.floor(TERMINALS[0].y/24);

function cargo(amount = 8): GameState {
  const state = createGame(42);
  state.player.x = TERMINALS[0].x - 120; state.player.y = TERMINALS[0].y + 132;
  for (let i = 0; i < 200 && state.player.bag < amount; i++) updateGame(state, .05, { dx: 1, dy: 0, clean: true });
  expect(state.player.bag).toBe(amount);
  state.credits = 10000; state.earned = 10000;
  state.ownedTools.push('handbrush', 'broom');
  return state;
}

async function continueSave(page: Page, state: GameState | Record<string, any>) {
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save: JSON.stringify(state) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
}

async function cell(page: Page, gx: number, gy: number, playerX: number, playerY: number) {
  const canvas = page.locator('#world'); const rect = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  if (!rect) throw new Error('Canvas missing');
  await page.mouse.click(rect.x + rect.width / 2 + (gx * 24 + 12 - playerX) * rect.width / size.width,
    rect.y + rect.height / 2 + (gy * 24 + 12 - playerY) * rect.height / size.height);
}

test('player builds an analyzer line and receives triple value only after delivery', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = cargo(); state.player.x = TERMINALS[0].x; state.player.y = TERMINALS[0].y + 147;
  await continueSave(page, state);
  await page.getByRole('button', { name: 'Строительство', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать Анализатор', exact: true }).click();
  await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r');
  await cell(page, baseGX, baseGY+5, TERMINALS[0].x, TERMINALS[0].y+147);
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  await expect(page.getByTestId('bag-count')).toHaveText('8');
  await expect(page.getByTestId('credits')).toHaveText((10000 - BUILDINGS.analyzer.price).toLocaleString('ru'));
  await page.getByRole('button', { name: 'Строительство', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать Приёмник', exact: true }).click();
  await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r');
  await cell(page, baseGX, baseGY+6, TERMINALS[0].x, TERMINALS[0].y+147);
  await page.getByRole('button', { name: 'Выбрать Конвейер', exact: true }).click();
  for (const gy of [baseGY+1, baseGY+2, baseGY+3, baseGY+4]) await cell(page, baseGX, gy, TERMINALS[0].x, TERMINALS[0].y+147);
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await expect(page.getByTestId('credits')).toHaveText((10000 - BUILDINGS.analyzer.price - BUILDINGS.receiver.price - 4 * BUILDINGS.belt.price + 24).toLocaleString('ru'), { timeout: 15_000 });
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('overview-processed')).toHaveText('8');
  await expect(page.getByTestId('overview-tested')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('a full production chain resumes a saved processing job and pays sevenfold', async ({ page }) => {
  const state = cargo(); state.player.x = TERMINALS[0].x; state.player.y = TERMINALS[0].y + 57;
  state.stats.reportsSold = ECONOMY.testerReports; state.stats.delivered = ECONOMY.testerReports;
  expect(placeBuilding(state, 'receiver', baseGX, baseGY+3, 3).ok).toBe(true);
  expect(placeBuilding(state, 'analyzer', baseGX, baseGY+2, 3).ok).toBe(true);
  expect(placeBuilding(state, 'tester', baseGX, baseGY+1, 3).ok).toBe(true);
  // Pause immediately after loading to preserve a live current-recipe job.
  state.player.bag = 0;
  state.buildings.find(b => b.kind === 'analyzer')!.processing = { units: 8, remaining: .2 };
  const balance = state.credits;
  await continueSave(page, state);
  await expect(page.getByTestId('credits')).toHaveText(balance.toLocaleString('ru'));
  await page.keyboard.press('Escape');
  const inFlight = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(inFlight.version).toBe(5);
  expect(inFlight.stats.delivered).toBe(ECONOMY.testerReports);
  await page.reload(); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByTestId('credits')).toHaveText((balance + 56).toLocaleString('ru'), { timeout: 15_000 });
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('overview-processed')).toHaveText('8');
  await expect(page.getByTestId('overview-tested')).toHaveText('8');
  await page.keyboard.press('Escape');
  const result = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(result.stats.processed).toBe(8);
  expect(result.stats.tested).toBe(8);
  expect(result.stats.testsSold).toBe(8);
  expect(result.stats.reportsSold).toBe(ECONOMY.testerReports);
  expect(result.stats.rawSold).toBe(0);
  expect(result.stats.delivered).toBe(ECONOMY.testerReports + 8);
  expect(result.capsules).toHaveLength(0);
  expect(result.buildings.every((b: any) => b.buffer === 0 && b.outputBuffer === 0 && b.processing === null)).toBe(true);
});

test('money cannot skip tool progression or production milestones and requirements are visible', async ({ page }) => {
  const state = createGame(42); state.credits = 100000; state.earned = 100000; Object.assign(state.player,STATIONS.workshop);
  state.landmarks=[];
  await continueSave(page, state);
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Купить Большая щётка', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Купить Турбощётка', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Купить Ручная щётка', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Купить Большая щётка', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Купить Большая щётка', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Турбощётка', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Больше контейнер', exact: true }).click();
  await page.getByRole('button', { name: 'Купить Больше контейнер', exact: true }).click();
  await page.keyboard.press('Escape'); await walkTo(page,STATIONS.garage); await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Купить Робот-пылесос', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Купить Уборочная машина', exact: true })).toBeDisabled();
  const vehicle = page.locator('.shop-card').filter({ has: page.getByRole('heading', { name: 'Уборочная машина', exact: true }) });
  await expect(vehicle).toContainText(`0/${ECONOMY.vehicleTests}`);
  await page.keyboard.press('Escape'); await page.keyboard.press('b');
  await page.getByRole('button', { name: 'Выбрать Тестовый стенд', exact: true }).click();
  await expect(page.locator('#build-tip')).toContainText(`0/${ECONOMY.testerReports}`);
  const [px,py]=(await page.locator('#coordinates').innerText()).match(/\d+/g)!.map(Number);
  await cell(page, baseGX, baseGY+2, px, py);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const result = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(result.buildings.some((b: any) => b.kind === 'tester')).toBe(false);
  expect(result.credits).toBe(100000 - 400 - 1800 - 6000 - 300 - 1200);
});

test('a current save can recover sold raw bugs at the terminal without duplicating stock or making a resale profit', async ({ page }) => {
  const state = cargo(); state.player.x = TERMINALS[0].x; state.player.y = TERMINALS[0].y + 57;
  state.player.bag = 0; state.stats.rawSold = 8; state.stats.delivered = 8;
  await continueSave(page, state);
  await page.keyboard.press('m');
  await expect(page.getByTestId('raw-stock')).toHaveText('8');
  await page.getByRole('button', { name: 'Вернуть баги из терминала', exact: true }).click();
  await expect(page.getByTestId('bag-count')).toHaveText('8');
  await expect(page.getByTestId('credits')).toHaveText((9984).toLocaleString('ru'));
  await expect(page.getByTestId('raw-stock')).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('e');
  await page.keyboard.press('m');
  await expect(page.getByTestId('raw-stock')).toHaveText('8');
  await expect(page.locator('#shop-credits')).toHaveText((9992).toLocaleString('ru'));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const result = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(result.stats.rawReclaimed).toBe(8);
  expect(result.stats.rawSold).toBe(16);
  expect(result.player.bag).toBe(0);
  expect(result.cleaned).toBe(state.cleaned);
  expect(result.credits).toBe(state.credits - 8);
});

test('four independent corner factories sell through all four terminals', async ({page}) => {
  const state = createGame(42); state.credits = 2840; state.earned = 2840;
  state.ownedTools.push('handbrush');
  let cargo = 32;
  for (let i=0; cargo && i<state.dust.length; i++) {
    const units = Math.min(cargo,state.dust[i]); state.dust[i]-=units; state.cleaned+=units; cargo-=units;
  }
  const terminals = state.buildings.filter(b=>b.kind==='uplink');
  for (const terminal of terminals) {
    const side = terminal.gy < STATIONS.garage.y / 24 ? -1 : 1;
    Object.assign(state.player,{x:terminal.gx*24+12,y:terminal.gy*24+12});
    for (const [kind,gx,gy] of [
      ['receiver',terminal.gx-1,terminal.gy+2*side],
      ['analyzer',terminal.gx,terminal.gy+2*side],
      ['belt',terminal.gx,terminal.gy+side],
    ] as const) expect(placeBuilding(state,kind,gx,gy,0).ok).toBe(true);
    state.buildings.filter(b=>b.kind==='receiver').at(-1)!.buffer=8;
  }
  expect(state.credits).toBe(0);
  await continueSave(page,state);
  await expect(page.getByTestId('credits')).toHaveText('96');
  await page.keyboard.press('Tab');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(saved.stats.reportsSold).toBe(32);
  expect(saved.stats.rawSold).toBe(0);
  expect(saved.buildings.filter((b:any)=>b.kind==='receiver').every((b:any)=>b.buffer===0)).toBe(true);
});
