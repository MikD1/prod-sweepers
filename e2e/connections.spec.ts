import { TERMINALS } from '../src/game/types';
import { createFactoryGame as createGame } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { placeBuilding } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';

const baseGX=Math.floor(TERMINALS[0].x/24),baseGY=Math.floor(TERMINALS[0].y/24);

async function cell(page: Page, gx: number, gy: number, click = false) {
  const canvas = page.locator('#world'); const rect = await canvas.boundingBox();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({ width: el.width, height: el.height }));
  if (!rect) throw Error('Canvas missing');
  const x = rect.x + rect.width / 2 + (gx * 24 + 12 - TERMINALS[0].x) * rect.width / size.width;
  const y = rect.y + rect.height / 2 + (gy * 24 + 12 - (TERMINALS[0].y+57)) * rect.height / size.height;
  if (click) await page.mouse.click(x, y); else await page.mouse.move(x, y);
}

test('conveyor placement explains an occupied machine and lack of credits before clicking', async ({ page }) => {
  const state = createGame(42); state.ownedTools.push('handbrush'); state.credits = 1000;
  expect(placeBuilding(state, 'analyzer', baseGX+2, baseGY+3, 3).ok).toBe(true);
  state.credits = 9;
  await page.addInitScript(({key, save}) => localStorage.setItem(key, save), {key: SAVE_KEY, save: serializeGame(state)});
  await page.goto('/'); await page.getByRole('button', { name: 'Продолжить', exact:true }).click();
  await page.keyboard.press('b');
  await cell(page, baseGX+2, baseGY+3);
  await expect(page.locator('#context-action')).toContainText('Анализатор', {timeout:1500});
  await expect(page.locator('#context-action')).toContainText('соседнюю');
  await cell(page, baseGX+1, baseGY+3);
  await expect(page.locator('#context-action')).toContainText('ещё 1 кр.');
  await cell(page, baseGX+1, baseGY+3, true);
  await expect(page.locator('#toasts')).toContainText('ещё 1 кр.');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
  expect(saved.credits).toBe(9);
  expect(saved.buildings.filter((b:any)=>b.kind==='belt')).toHaveLength(0);
});

test('a receiver connects through a bent conveyor to an analyzer and sells reports', async ({ page }) => {
  const state = createGame(42); state.ownedTools.push('handbrush'); state.player.tool = 'handbrush'; state.credits = 1000;
  const plan = [['receiver',baseGX-2,baseGY+4,0], ['belt',baseGX-1,baseGY+4,3], ['belt',baseGX-1,baseGY+3,0], ['analyzer',baseGX,baseGY+3,3], ['belt',baseGX,baseGY+2,3], ['belt',baseGX,baseGY+1,3]] as const;
  for (const [kind,gx,gy,dir] of plan) expect(placeBuilding(state,kind,gx,gy,dir).ok).toBe(true);
  state.player.x = TERMINALS[0].x - 48; state.player.y = TERMINALS[0].y + 97;
  let remaining = 8;
  for(let i=0;remaining&&i<state.dust.length;i++) { const n=Math.min(remaining,state.dust[i]);state.dust[i]-=n;state.cleaned+=n;state.player.bag+=n;remaining-=n; }
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save:serializeGame(state)});
  await page.goto('/'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await page.keyboard.press('e');
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await expect(page.getByTestId('credits')).toHaveText(String(state.credits+24),{timeout:10000});
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('overview-processed')).toHaveText('8');
  await expect(page.getByTestId('overview-tested')).toHaveText('0');
  await expect(page.getByTestId('credits')).toHaveText(String(state.credits+24));
});
