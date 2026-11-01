import { createFactoryGame as createGame } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { updateGame } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';
import { STATIONS , TERMINALS } from '../src/game/types';

const baseGX=Math.floor(TERMINALS[0].x/24),baseGY=Math.floor(TERMINALS[0].y/24);

async function continueSave(page: Page, save: string) {
  await page.addInitScript(({ key, save }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, save); }, { key: SAVE_KEY, save });
  await page.goto('/');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
}
async function point(page: Page, gx: number, gy: number) {
  const canvas = page.locator('#world'); const rect = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  if (!rect) throw Error('Canvas missing');
  return { x: rect.x + rect.width / 2 + (gx * 24 + 12 - TERMINALS[0].x) * rect.width / size.width,
    y: rect.y + rect.height / 2 + (gy * 24 + 12 - (TERMINALS[0].y+57)) * rect.height / size.height };
}

test('buying the first brush also upgrades the container and allows a longer gathering trip', async ({ page }) => {
  const state = createGame(42); state.credits = 400; state.earned = 400; Object.assign(state.player,STATIONS.workshop); state.obstacles=[];
  await continueSave(page, serializeGame(state));
  await expect(page.locator('#bag-capacity')).toHaveText('120');
  await page.keyboard.press('m');
  await expect(page.locator('.shop-card').filter({ has: page.getByRole('heading', { name: 'Ручная щётка', exact: true }) })).toContainText('300');
  await page.getByRole('button', { name: 'Купить Ручная щётка', exact: true }).click();
  await expect(page.locator('#bag-capacity')).toHaveText('300');
  await page.keyboard.press('Escape');
  await page.keyboard.down('s'); await page.waitForTimeout(3000); await page.keyboard.up('s');
  await page.keyboard.down('Space'); await page.keyboard.down('d'); await page.waitForTimeout(4000);
  await page.keyboard.up('d'); await page.keyboard.up('Space');
  await page.keyboard.press('Tab');
  const gathered = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).player.bag, SAVE_KEY);
  await expect(page.getByTestId('bag-count')).toHaveText(String(gathered));
  expect(gathered).toBeGreaterThan(36); expect(gathered).toBeLessThan(300);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Digit1');
  await expect(page.locator('#bag-capacity')).toHaveText('300');
  await page.keyboard.press('Escape');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(saved.buildings.map((b: any) => b.kind)).toEqual(['uplink', 'uplink', 'uplink', 'uplink']);
  expect(saved.player.bag).toBe(gathered);
});

test('the production map explains all sale routes, pauses play and opens from construction', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Начать уборку', exact: true }).click();
  await page.getByRole('button', { name: 'Карта производственных цепочек', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'Карта производственных цепочек', exact: true });
  await expect(guide).toBeVisible();
  await expect(page.getByTestId('chain-raw')).toContainText('8 кр.');
  await expect(page.getByTestId('chain-transport')).toContainText('8 кр.');
  await expect(page.getByTestId('chain-report')).toContainText('24 кр.');
  await expect(page.getByTestId('chain-test')).toContainText('56 кр.');
  await expect(guide).toContainText('Сам конвейер цену не повышает');
  await expect(page.getByTestId('first-line-cost')).toHaveText('710 кр.');
  const position = await page.locator('#coordinates').innerText();
  await page.keyboard.down('w'); await page.waitForTimeout(400); await page.keyboard.up('w');
  await expect(page.locator('#coordinates')).toHaveText(position);
  await page.keyboard.press('Escape'); await page.keyboard.press('b');
  await page.getByRole('button', { name: 'Посмотреть цепочки', exact: true }).click();
  await expect(guide).toBeVisible();
  await page.keyboard.press('c'); await expect(guide).toHaveCount(0);
  await expect(page.locator('#build-panel')).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('c'); await expect(guide).toBeVisible();
});

test('a handbrush owner builds the illustrated first factory for 710 and sells eight bugs for 24', async ({ page }) => {
  const state = createGame(42);
  state.player.x = TERMINALS[0].x - 120; state.player.y = TERMINALS[0].y + 132;
  while (state.player.bag < 8) updateGame(state, .05, { dx: 1, dy: 0, clean: true });
  state.player.x = TERMINALS[0].x; state.player.y = TERMINALS[0].y + 57;
  state.ownedTools.push('handbrush'); state.player.tool = 'handbrush'; state.credits = 710; state.earned = 710;
  await continueSave(page, serializeGame(state)); await page.keyboard.press('b');
  await page.getByRole('button', { name: 'Выбрать Приёмник', exact: true }).click();
  const receiver = await point(page, baseGX-1, baseGY+2); await page.mouse.click(receiver.x, receiver.y);
  await page.getByRole('button', { name: 'Выбрать Анализатор', exact: true }).click();
  const analyzer = await point(page, baseGX, baseGY+2); await page.mouse.move(analyzer.x, analyzer.y);
  await page.keyboard.press('r'); await page.keyboard.press('r'); await page.keyboard.press('r');
  await page.mouse.click(analyzer.x, analyzer.y);
  await page.getByRole('button', { name: 'Выбрать Конвейер', exact: true }).click();
  const belt = await point(page, baseGX, baseGY+1); await page.mouse.click(belt.x, belt.y);
  await expect(page.getByTestId('credits')).toHaveText('0');
  await page.keyboard.press('Escape'); await page.keyboard.press('e');
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await expect(page.getByTestId('credits')).toHaveText('24', { timeout: 12000 });
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('overview-processed')).toHaveText('8');
  await expect(page.getByTestId('overview-tested')).toHaveText('0');
});
