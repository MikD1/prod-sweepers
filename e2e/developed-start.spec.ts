import { test, expect, type Page } from '@playwright/test';
import { createGame, getBuildingConnections } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';
import { CELL, GRID_W, HUB } from '../src/game/types';

const label='Начать с развитой базой';
const savedWorld=()=>{const state=createGame(42);state.credits=123;state.earned=123;return serializeGame(state);};
async function installSave(page:Page,save:string){
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save});
}
async function beginWithSave(page:Page){
  await page.getByRole('button',{name:label,exact:true}).click();
  await page.getByRole('dialog',{name:'Развитый мир?',exact:true}).getByRole('button',{name:label,exact:true}).click();
}

test('background replay stays responsive and opens a real played world that survives reload',async({page})=>{
  test.setTimeout(90_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install();await page.goto('/');
  await expect(page.locator('#developed-start-description')).toContainText('пять роботов');
  await page.getByRole('button',{name:label,exact:true}).click();
  await expect(page.getByTestId('generation-panel')).toBeVisible();
  await expect(page.getByRole('progressbar',{name:'Прогресс подготовки мира'})).toHaveAttribute('aria-valuenow',/^\d+$/);
  // An animation frame can run while the real worker is busy simulating gameplay.
  expect(await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(true))))).toBe(true);
  expect(await page.evaluate(key=>localStorage.getItem(key),SAVE_KEY)).toBeNull();
  await expect(page.getByTestId('game-hud')).toBeVisible({timeout:60_000});
  await page.keyboard.press('Tab');
  const before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(before.time).toBeGreaterThan(15*60);expect(before.time).toBeLessThan(75*60);
  expect(before.robots.map((r:any)=>r.kind).sort()).toEqual(['industrialRobot','industrialRobot','industrialRobot','robot','robot']);
  expect(before.vehicles).toHaveLength(2);expect(before.ownedTools).toContain('widebrush');
  expect(before.buildings.filter((b:any)=>b.kind==='tester')).toHaveLength(6);
  expect(before.buildings.filter((b:any)=>b.kind==='belt').length).toBeGreaterThan(120);
  expect(before.buildings.filter((b:any)=>b.kind==='receiver').filter((b:any)=>Math.hypot(b.gx*24+12-HUB.x,b.gy*24+12-HUB.y)>1200)).toHaveLength(2);
  expect(before.buildings.some((b:any)=>b.kind==='belt'&&getBuildingConnections(before,b).length>=3)).toBe(true);
  const machines=before.buildings.filter((b:any)=>b.kind!=='belt');
  for(let i=0;i<machines.length;i++)for(let j=i+1;j<machines.length;j++){
    expect(Math.abs(machines[i].gx-machines[j].gx)+Math.abs(machines[i].gy-machines[j].gy)).toBeGreaterThan(1);
  }
  const fresh=createGame(before.seed);let nearestDirt=Infinity,farthestTrack=0;
  before.dust.forEach((units:number,index:number)=>{
    if(!fresh.dust[index])return;
    const range=Math.hypot(index%GRID_W*CELL+CELL/2-HUB.x,Math.floor(index/GRID_W)*CELL+CELL/2-HUB.y);
    if(units)nearestDirt=Math.min(nearestDirt,range);
    if(units<fresh.dust[index])farthestTrack=Math.max(farthestTrack,range);
  });
  expect(farthestTrack-nearestDirt).toBeGreaterThan(300);
  await page.keyboard.press('Tab');await page.clock.runFor(10000);await page.keyboard.press('Tab');
  const after=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(after.stats.testsSold).toBeGreaterThan(before.stats.testsSold);
  for(const robot of after.robots){
    const previous=before.robots.find((r:any)=>r.id===robot.id);
    expect(Math.hypot(robot.x-previous.x,robot.y-previous.y)>1||robot.bag!==previous.bag).toBe(true);
  }
  await page.reload();await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.keyboard.press('Tab');
  const restored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(restored.seed).toBe(before.seed);expect(restored.cleaned).toBeGreaterThanOrEqual(after.cleaned);
  expect(restored.robots).toHaveLength(5);expect(errors).toEqual([]);
});

test('cancel and leaving during generation preserve the original save and allow a regular fresh start',async({page})=>{
  const save=savedWorld();await installSave(page,save);await page.goto('/');
  const fresh=await page.getByRole('button',{name:'Начать новый мир',exact:true}).boundingBox();
  expect((await page.getByRole('button',{name:label,exact:true}).boundingBox())!.y).toBeGreaterThan(fresh!.y);
  await beginWithSave(page);await expect(page.getByTestId('generation-panel')).toBeVisible();
  await page.getByRole('button',{name:'Отменить подготовку мира',exact:true}).click();
  await expect(page.getByTestId('generation-panel')).toHaveCount(0);
  expect(await page.evaluate(key=>localStorage.getItem(key),SAVE_KEY)).toBe(save);
  await expect(page.getByRole('button',{name:label,exact:true})).toBeEnabled();
  await beginWithSave(page);await expect(page.getByTestId('generation-panel')).toBeVisible();await page.reload();
  expect(await page.evaluate(key=>localStorage.getItem(key),SAVE_KEY)).toBe(save);
  await page.getByRole('button',{name:'Начать новый мир',exact:true}).click();
  await page.getByRole('dialog',{name:'Новый мир?',exact:true}).getByRole('button',{name:'Начать новый мир',exact:true}).click();
  await page.keyboard.press('Tab');
  const state=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(state.cleaned).toBe(0);expect(state.credits).toBe(0);expect(state.robots).toEqual([]);
});

for(const reload of [false,true]) test(`a developed world hands over controllable Lotti on foot ${reload?'after reload':'after generation'}`,async({page})=>{
  test.setTimeout(90_000);
  await page.clock.install({time:0});await page.clock.pauseAt(10000);await page.clock.setFixedTime(0);
  await page.goto('/');await page.getByRole('button',{name:label,exact:true}).click();
  await expect(page.getByTestId('game-hud')).toBeVisible({timeout:60_000});
  if(reload){
    await page.keyboard.press('Tab');await page.reload();
    await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  }
  // Model a high refresh rate display through the actual browser input/render loop.
  await page.evaluate(()=>{
    window.requestAnimationFrame=callback=>window.setTimeout(()=>callback(performance.now()),8);
    window.cancelAnimationFrame=id=>clearTimeout(id);
  });
  await page.clock.runFor(1000);await page.keyboard.press('Tab');
  const before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(before.seed).toBe(0);expect(before.player.riding).toBe(false);
  expect(before.player.bag).toBe(0);expect(before.vehicles.every((v:any)=>v.speed===0)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Турбощётка');
  await page.keyboard.down('w');await page.clock.runFor(2000);await page.keyboard.up('w');
  await page.keyboard.press('Tab');
  const moved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(Math.hypot(moved.player.x-before.player.x,moved.player.y-before.player.y)).toBeGreaterThan(150);
  expect(moved.player.bag).toBe(before.player.bag);
  expect(moved.player.riding).toBe(false);
});

test('a worker failure keeps the saved world and retry performs the real simulation',async({page})=>{
  test.setTimeout(90_000);
  const save=savedWorld();await installSave(page,save);
  let fail=true;
  await page.route('**/generation.worker.ts*',route=>{
    if(fail){fail=false;return route.abort();}return route.continue();
  });
  await page.goto('/');await beginWithSave(page);
  await expect(page.getByRole('alert')).toContainText('Не удалось подготовить');
  expect(await page.evaluate(key=>localStorage.getItem(key),SAVE_KEY)).toBe(save);
  await page.getByRole('button',{name:'Повторить подготовку мира',exact:true}).click();
  await expect(page.getByTestId('game-hud')).toBeVisible({timeout:60_000});await page.keyboard.press('Tab');
  const state=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(state.cleaned).toBeGreaterThan(0);expect(state.robots.some((r:any)=>r.kind==='industrialRobot')).toBe(true);
});
