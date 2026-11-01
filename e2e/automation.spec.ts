import { createFactoryGame as createGame } from './helpers';
import { test, expect, type Page } from '@playwright/test';
import { placeBuilding } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';
import { BUILDINGS, TERMINALS, type GameState } from '../src/game/types';

const baseGX=Math.floor(TERMINALS[0].x/24),baseGY=Math.floor(TERMINALS[0].y/24);

function cargo(state: GameState, amount: number) {
  let remaining = amount;
  for (let i=0; remaining && i<state.dust.length; i++) {
    const n=Math.min(state.dust[i],remaining); state.dust[i]-=n; state.cleaned+=n; remaining-=n;
  }
  expect(remaining).toBe(0);
}
async function continueSave(page: Page, state: GameState) {
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save:serializeGame(state)});
  await page.goto('/'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
}
async function cell(page: Page, gx: number, gy: number) {
  const canvas=page.locator('#world'); const rect=await canvas.boundingBox();
  const size=await canvas.evaluate((el:HTMLCanvasElement)=>({width:el.width,height:el.height}));
  if(!rect)throw Error('Canvas missing');
  await page.mouse.click(rect.x+rect.width/2+(gx*24+12-TERMINALS[0].x)*rect.width/size.width,
    rect.y+rect.height/2+(gy*24+12-(TERMINALS[0].y+57))*rect.height/size.height);
}

test('an existing loaded receiver and conveyors work from the opposite side without rotation', async({page})=>{
  const state=createGame(42); state.credits=1000;
  for(const [kind,gx,gy,dir]of [['receiver',baseGX,baseGY+3,0],['belt',baseGX,baseGY+2,1],['belt',baseGX,baseGY+1,2]]as const)
    expect(placeBuilding(state,kind,gx,gy,dir).ok).toBe(true);
  const balance=state.credits; cargo(state,8);
  state.capsules.push({id:state.nextId++,gx:baseGX,gy:baseGY+3,dir:0,progress:0,units:8,material:'raw'});
  await continueSave(page,state);
  await expect(page.locator('#credits')).toHaveText(String(balance+8),{timeout:10000});
  await page.keyboard.press('Escape');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(saved.stats.rawSold).toBe(8);
  expect(saved.capsules).toHaveLength(0);
  expect(saved.buildings.find((b:any)=>b.kind==='receiver').dir).toBe(0);
});

test('a loaded receiver can be demolished and its recovered cargo survives reload and sells once at the base', async({page})=>{
  const state=createGame(42); state.credits=1000;
  expect(placeBuilding(state,'receiver',baseGX,baseGY+3,0).ok).toBe(true);
  const receiver=state.buildings.find(b=>b.kind==='receiver')!; receiver.buffer=12;
  cargo(state,20);
  state.capsules.push({id:state.nextId++,gx:baseGX,gy:baseGY+3,dir:0,progress:.4,units:8,material:'raw'});
  const afterRefund=state.credits+Math.floor(BUILDINGS.receiver.price/2);
  await continueSave(page,state);
  await page.keyboard.press('b'); await page.getByRole('button',{name:'Выбрать Демонтаж',exact:true}).click();
  await cell(page,baseGX,baseGY+3);
  await expect(page.locator('#credits')).toHaveText(String(afterRefund),{timeout:1500});
  await page.keyboard.press('Escape'); await page.keyboard.press('m');
  await expect(page.getByTestId('recovered-panel')).toBeVisible({timeout:1500});
  await expect(page.getByTestId('recovered-raw')).toHaveText('20');
  await page.reload(); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await page.keyboard.press('m');
  await expect(page.getByTestId('recovered-raw')).toHaveText('20');
  await page.getByRole('button',{name:'Продать груз со склада',exact:true}).click();
  await expect(page.locator('#credits')).toHaveText(String(afterRefund+20));
  await expect(page.getByTestId('recovered-panel')).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('e'); await page.keyboard.press('Escape');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(saved.buildings.filter((b:any)=>b.kind==='receiver')).toHaveLength(0);
  expect(saved.capsules).toHaveLength(0);
  expect(saved.recovered).toEqual({raw:0,report:0,test:0});
  expect(saved.stats.rawSold).toBe(20);
  expect(saved.credits).toBe(afterRefund+20);
});

test('the workshop shows typed recovered goods and sells their material value', async({page})=>{
  const state=createGame(42); state.recovered={raw:3,report:4,test:5}; state.credits=100;
  cargo(state,12);
  await continueSave(page,state); await page.keyboard.press('m');
  await expect(page.getByTestId('recovered-panel')).toBeVisible({timeout:1500});
  await expect(page.getByTestId('recovered-raw')).toHaveText('3');
  await expect(page.getByTestId('recovered-report')).toHaveText('4');
  await expect(page.getByTestId('recovered-test')).toHaveText('5');
  await page.getByRole('button',{name:'Продать груз со склада',exact:true}).click();
  await expect(page.locator('#credits')).toHaveText('150');
  await expect(page.getByTestId('recovered-panel')).toHaveCount(0);
});

test('a receiver alternates between connected sides and dead-end cargo survives reload without bouncing', async({page})=>{
  const state=createGame(42); state.credits=500;
  for(const [kind,gx]of [['receiver',baseGX],['belt',baseGX-1],['belt',baseGX+1]]as const)
    expect(placeBuilding(state,kind,gx,baseGY+3,3).ok).toBe(true);
  state.buildings.find(b=>b.kind==='receiver')!.buffer=16; cargo(state,16);
  await continueSave(page,state); await page.waitForTimeout(1800); await page.keyboard.press('Escape');
  const first=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(first.buildings.find((b:any)=>b.kind==='receiver').buffer).toBe(0);
  expect(first.capsules.map((c:any)=>[c.gx,c.gy,c.units]).sort((a:number[],b:number[])=>a[0]-b[0])).toEqual([[baseGX-1,baseGY+3,8],[baseGX+1,baseGY+3,8]]);
  expect(first.stats.delivered).toBe(0);
  await page.reload(); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await page.waitForTimeout(1812); await page.keyboard.press('Escape');
  const second=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(second.capsules.map((c:any)=>[c.gx,c.gy,c.units]).sort((a:number[],b:number[])=>a[0]-b[0])).toEqual([[baseGX-1,baseGY+3,8],[baseGX+1,baseGY+3,8]]);
  expect(second.recovered).toEqual({raw:0,report:0,test:0});
  expect(second.stats.delivered).toBe(0);
});
