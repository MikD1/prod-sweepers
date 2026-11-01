import { createFactoryGame as createGame } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import { buyUpgrade, placeBuilding } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';
import { BUILDINGS, CELL, ECONOMY, GRID_W, HUB, ROBOTS, STATIONS, TERMINALS, TOOLS, type GameState } from '../src/game/types';
import { clickCell, walkTo } from './helpers';

const baseGX=Math.floor(TERMINALS[0].x/24),baseGY=Math.floor(TERMINALS[0].y/24);

async function continueGame(page: Page, state: GameState | object) {
  const save = 'version' in state && state.version === 5 ? serializeGame(state as GameState) : JSON.stringify(state);
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save});
  await page.goto('/'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
}

function garageFixture(credits = 20000): GameState {
  const state = createGame(42);
  state.credits = credits + BUILDINGS.receiver.price + 3 * BUILDINGS.belt.price;
  state.earned = state.credits;
  state.ownedTools.push('handbrush'); state.player.tool = 'handbrush'; state.player.capacityLevel = 1;
  state.stats.reportsSold = 32; state.stats.delivered = 32; state.stats.processed = 32;
  for (const [kind,gx] of [['receiver',baseGX-4],['belt',baseGX-3],['belt',baseGX-2],['belt',baseGX-1]] as const)
    expect(placeBuilding(state,kind,gx,baseGY,0).ok).toBe(true);
  state.player.x = STATIONS.garage.x; state.player.y = STATIONS.garage.y;
  return state;
}

test('physical stations sell separate assortments and remote menus allow construction only', async({page})=>{
  const state = createGame(42); state.credits = 500; state.earned = 500;
  state.player.x = HUB.x; state.player.y = HUB.y + 100;
  await continueGame(page,state); await page.keyboard.press('m');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#toasts')).toContainText('Подойди');
  await page.keyboard.press('b'); await expect(page.locator('#build-panel')).toBeVisible();
  await page.keyboard.press('Escape'); await walkTo(page,STATIONS.workshop); await page.keyboard.press('e');
  const workshop=page.getByRole('dialog',{name:'Мастерская щёток',exact:true});
  await expect(workshop).toBeVisible();
  await expect(workshop.locator('[data-buy=handbrush]')).toBeEnabled();
  await expect(workshop.locator('[data-buy=compact], [data-buy=robot]')).toHaveCount(0);
  await workshop.locator('[data-buy=handbrush]').click();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Ручная щётка');
  await page.keyboard.press('Escape'); await walkTo(page,STATIONS.garage); await page.keyboard.press('e');
  const garage=page.getByRole('dialog',{name:'Гараж',exact:true});
  await expect(garage).toBeVisible();
  await expect(garage.locator('[data-buy=handbrush], [data-buy=capacity]')).toHaveCount(0);
  await expect(garage.locator('[data-buy=robot]')).toBeDisabled();
});

test('early garage purchases offer a compact sweeper and repeatable robots up to five', async({page})=>{
  await continueGame(page,garageFixture()); await page.keyboard.press('e');
  const compact=page.locator('[data-buy=compact]'), small=page.locator('[data-buy=robot]');
  await expect(compact).toBeEnabled(); await expect(small).toBeEnabled();
  await expect(page.locator('[data-buy=vehicle]')).toBeDisabled();
  await expect(page.locator('[data-buy=industrialRobot]')).toBeDisabled();
  await compact.click();
  await expect(compact).toBeDisabled();
  for (let i=1;i<=5;i++) {
    await small.click(); await expect(page.getByTestId('robot-count')).toHaveText(`${i} / 5`);
    if(i===1) await expect(small).toContainText('2 200');
  }
  await expect(small).toBeDisabled();
  await expect(page.locator('[data-buy=industrialRobot]')).toBeDisabled();
  await page.keyboard.press('Escape'); await page.keyboard.press('v');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Мини-уборщик');
  await expect(page.locator('#bag-capacity')).toHaveText('1800');
  await page.keyboard.press('Escape');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(saved.robots).toHaveLength(5); expect(saved.vehicles).toHaveLength(1);
  await page.reload(); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Мини-уборщик');
  await page.keyboard.press('m'); await expect(page.getByTestId('robot-count')).toHaveText('5 / 5');
});

test('the expensive PRO robot collects remotely and earns only through its receiver line', async({page})=>{
  await page.clock.install();
  const state=garageFixture(ECONOMY.industrialRobot);
  state.vehicles.push({kind:'vehicle',x:TERMINALS[0].x + 150,y:TERMINALS[0].y + 132,heading:Math.PI/2,speed:0});
  state.stats.testsSold=ECONOMY.robotTests; state.stats.delivered+=ECONOMY.robotTests;
  await continueGame(page,state); await page.keyboard.press('e');
  await page.locator('[data-buy=industrialRobot]').click();
  await expect(page.getByTestId('credits')).toHaveText('0');
  await page.keyboard.press('Escape');
  // Exercise the browser's fractional frame times deterministically.
  await page.clock.runFor(20000);
  await expect(page.getByTestId('credits')).not.toHaveText('0');
  await page.keyboard.press('Escape');
  const result=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(result.robots.map((r:any)=>r.kind)).toEqual(['industrialRobot']);
  expect(result.stats.robotCleaned).toBeGreaterThan(100);
  expect(result.stats.rawSold).toBeGreaterThan(0);
  expect(result.stats.capsules).toBeGreaterThan(0);
});

test('a full early fleet can upgrade to PRO without losing a loaded robot or adding a sixth slot', async({page})=>{
  const state=garageFixture(200000);
  state.vehicles.push({kind:'vehicle',x:TERMINALS[0].x + 150,y:TERMINALS[0].y + 132,heading:Math.PI/2,speed:0});
  state.stats.testsSold=ECONOMY.robotTests; state.stats.delivered+=ECONOMY.robotTests;
  for(let i=0;i<5;i++) expect(buyUpgrade(state,'robot').ok).toBe(true);
  let remaining=15;
  for(let i=0;remaining&&i<state.dust.length;i++){const n=Math.min(remaining,state.dust[i]);state.dust[i]-=n;state.cleaned+=n;remaining-=n;}
  state.robots[0].bag=15;
  await continueGame(page,state); await page.keyboard.press('e');
  const before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  await expect(page.getByTestId('robot-count')).toHaveText('5 / 5');
  await page.getByRole('button',{name:'Улучшить робота до Лоттик PRO',exact:true}).click();
  await expect(page.getByTestId('robot-count')).toHaveText('5 / 5');
  await expect(page.getByTestId('owned-industrialRobot')).toHaveText('×1');
  const after=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(after.robots).toHaveLength(5);
  expect(after.robots[0].id).toBe(before.robots[0].id);
  expect(after.robots[0].bag).toBe(before.robots[0].bag);
  expect(after.robots[0].kind).toBe('industrialRobot');
  expect(after.credits).toBe(before.credits-ECONOMY.industrialRobot);
});

test('an old world is discarded and the new world starts at the centered four-terminal base', async({page})=>{
  const old = { ...garageFixture(), version: 3 };
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save:JSON.stringify(old)});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Продолжить',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Начать уборку',exact:true}).click();
  await page.keyboard.press('Tab');
  const fresh=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(fresh.version).toBe(5); expect(fresh.credits).toBe(0);
  expect(fresh.buildings.filter((b:any)=>b.kind==='uplink').map((b:any)=>[b.gx*24+12,b.gy*24+12])).toEqual(TERMINALS.map(t=>[t.x,t.y]));
  expect(Math.abs(fresh.player.x-HUB.x)).toBeLessThan(120);
  expect(Math.abs(fresh.player.y-HUB.y)).toBeLessThan(120);
});

test('PRO cleans far from receivers and its cargo is sold only through the connected factory', async ({page}) => {
  await page.clock.install();
  const state=createGame(42); state.obstacles=[]; state.dust.fill(0);
  state.totalDirt=128; state.cleaned=0; state.credits=1000; state.earned=1000;
  const remote={x:HUB.x+1200,y:HUB.y+600};
  for(const point of [remote,{x:HUB.x-1800,y:HUB.y-1400}]){
    const gx=Math.floor(point.x/CELL),gy=Math.floor(point.y/CELL);
    for(let y=0;y<2;y++)for(let x=0;x<4;x++)state.dust[(gy+y)*GRID_W+gx+x]=8;
  }
  for(const [kind,gx] of [['receiver',baseGX-4],['belt',baseGX-3],['belt',baseGX-2],['belt',baseGX-1]] as const)
    expect(placeBuilding(state,kind,gx,baseGY,0).ok).toBe(true);
  const balance=state.credits;
  state.robots.push({id:state.nextId++,kind:'industrialRobot',...remote,bag:0,capacity:ROBOTS.industrialRobot.capacity,mode:'cleaning',target:null,path:[],timer:0,cleanAccumulator:0});
  await continueGame(page,state);await page.clock.runFor(12000);await page.keyboard.press('Escape');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(saved.stats.robotCleaned).toBeGreaterThanOrEqual(64);
  expect(saved.stats.rawSold).toBeGreaterThan(0);expect(saved.credits).toBeGreaterThan(balance);
  expect(saved.stats.capsules).toBeGreaterThan(0);expect(saved.completed).toBe(false);
  expect(saved.dust.reduce((n:number,units:number)=>n+units,0)+saved.player.bag+saved.robots.reduce((n:number,r:any)=>n+r.bag,0)
    +saved.buildings.reduce((n:number,b:any)=>n+b.buffer+b.outputBuffer+(b.processing?.units??0),0)
    +saved.capsules.reduce((n:number,c:any)=>n+c.units,0)+saved.stats.delivered).toBe(saved.totalDirt);
});


test('a loaded vehicle accelerates at 125 Hz, unloads and lets Lotti exit',async({page})=>{
  await page.clock.install({time:0});await page.clock.pauseAt(10000);
  const state=garageFixture();state.obstacles=[];
  state.ownedTools=Object.keys(TOOLS) as GameState['ownedTools'];state.player.tool='widebrush';state.player.capacityLevel=2;
  const receiver=state.buildings.find(b=>b.kind==='receiver')!,rx=receiver.gx*24+12,ry=receiver.gy*24+12;
  Object.assign(state.player,{x:rx,y:ry+240,bag:2155,riding:true,vehicleKind:'vehicle'});
  state.vehicles=[{kind:'vehicle',x:rx,y:ry+240,heading:-Math.PI/2,speed:0}];
  let remaining=2155;
  for(let i=0;remaining&&i<state.dust.length;i++){const n=Math.min(remaining,state.dust[i]);state.dust[i]-=n;state.cleaned+=n;remaining-=n;}
  expect(remaining).toBe(0);
  await continueGame(page,state);
  await page.evaluate(()=>{
    window.requestAnimationFrame=callback=>window.setTimeout(()=>callback(performance.now()),8);
    window.cancelAnimationFrame=id=>clearTimeout(id);
  });
  await page.clock.runFor(1000);await page.keyboard.press('v');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Уборочная машина');
  await page.keyboard.down('w');await page.clock.runFor(2000);await page.keyboard.up('w');
  await page.keyboard.press('Escape');
  const driven=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(state.player.y-driven.player.y).toBeGreaterThan(150);expect(driven.player.bag).toBe(2155);
  await page.keyboard.press('Escape');await page.keyboard.press('e');await page.keyboard.press('v');
  await page.clock.runFor(120);
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await expect(page.getByTestId('equipped-tool')).toHaveText('Турбощётка');
  await page.keyboard.press('Escape');
  const after=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(after.player.riding).toBe(false);
  expect(after.buildings.find((b:any)=>b.id===receiver.id).buffer).toBeGreaterThan(2000);
});
