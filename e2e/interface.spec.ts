import { test, expect, type Page } from '@playwright/test';
import { createGame } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';
import { ROBOTS, STATIONS, TERMINALS, type GameState } from '../src/game/types';
import { clickCell } from './helpers';

async function start(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name:'Начать уборку', exact:true }).click();
}

test('the task stays hidden behind i and shares the left side with construction', async({page})=>{
  await start(page);
  await expect(page.locator('.mission-panel')).toBeHidden({timeout:1500});
  await expect(page.getByTestId('production-panel')).toHaveCount(0);
  const info=page.getByRole('button',{name:'Текущее задание',exact:true});
  await expect(info).toHaveText('i'); await expect(info).toHaveAttribute('aria-expanded','false');
  await info.click(); await expect(page.locator('.mission-panel')).toBeVisible();
  await expect(info).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.mission-panel')).toBeHidden(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await info.click(); await page.keyboard.press('b');
  await expect(page.locator('.mission-panel')).toBeHidden(); await expect(page.locator('#build-panel')).toBeVisible();
  await info.click();
  await expect(page.locator('.mission-panel')).toBeVisible(); await expect(page.locator('#build-panel')).toBeHidden();
  await page.reload(); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await expect(page.locator('.mission-panel')).toBeHidden();
});

test('Tab shows six live lifetime metrics while blocking player controls and Esc still pauses', async({page})=>{
  await page.clock.install();
  const state=createGame(42); state.time=125; state.credits=182; state.earned=382;
  state.stats.processed=48; state.stats.tested=16; state.stats.rawSold=10; state.stats.reportsSold=24; state.stats.testsSold=8; state.stats.delivered=42;
  let remaining=60;
  for(let i=0;remaining&&i<state.dust.length;i++){const n=Math.min(remaining,state.dust[i]);state.dust[i]-=n;state.cleaned+=n;remaining-=n;}
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save:serializeGame(state)});
  await page.goto('/'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await expect(page.getByTestId('production-panel')).toHaveCount(0);
  await page.keyboard.press('Tab');
  const overview=page.getByRole('dialog',{name:'Обзор мира',exact:true});
  await expect(overview).toBeVisible();
  await expect(page.locator('#overview-map')).toBeVisible();
  const map=await page.locator('#overview-map').boundingBox();
  expect(map!.width).toBeGreaterThan(400); expect(map!.height).toBeGreaterThan(300);
  await expect(page.getByTestId('overview-percent')).toHaveText('0,0%');
  await expect(page.getByTestId('overview-cleaned')).toHaveText('60');
  await expect(page.getByTestId('overview-processed')).toHaveText('48');
  await expect(page.getByTestId('overview-tested')).toHaveText('16');
  await expect(page.getByTestId('overview-earned')).toHaveText('382');
  await expect(page.getByTestId('overview-time')).toHaveText('02:05');
  await expect(overview.locator('dd')).toHaveCount(6);
  await expect(overview.getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('production-panel')).toHaveCount(0);
  expect(await page.getByTestId('overview-cleaned').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(30);
  const time=await page.getByTestId('overview-time').innerText();
  const position=await page.locator('#coordinates').innerText();
  await page.keyboard.down('w'); await page.clock.runFor(2200); await page.keyboard.up('w');
  await expect(page.locator('#coordinates')).toHaveText(position);
  await expect(page.getByTestId('overview-time')).not.toHaveText(time);
  await page.keyboard.press('Tab'); await expect(overview).toHaveCount(0);
  await expect(page.locator('#world')).toBeFocused();
  await expect(page.getByTestId('production-panel')).toHaveCount(0);
  await page.keyboard.press('Tab'); await expect(overview).toBeVisible();
  await page.keyboard.press('Escape'); await expect(overview).toHaveCount(0);
  await expect(page.getByRole('dialog',{name:'Пауза',exact:true})).toBeVisible();
  const paused=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).time,SAVE_KEY);
  await page.clock.runFor(2200);
  await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
  const pausedMinutes=`${String(Math.floor(paused/60)).padStart(2,'0')}:${String(Math.floor(paused%60)).padStart(2,'0')}`;
  await expect(page.getByTestId('overview-time')).toHaveText(pausedMinutes);
});

async function loadState(page:Page,state:GameState) {
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save:serializeGame(state)});
  await page.goto('/'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
}

function factoryState() {
  const state=createGame(42), terminal=state.buildings[0];
  const add=(kind:'receiver'|'analyzer'|'belt',gx:number)=>{
    const building={id:state.nextId++,kind,gx,gy:terminal.gy,dir:0 as const,buffer:0,outputBuffer:0,processing:null,cooldown:0};
    state.buildings.push(building); return building;
  };
  add('belt',terminal.gx+1); const analyzer=add('analyzer',terminal.gx+2),receiver=add('receiver',terminal.gx+3);
  state.player.x=TERMINALS[0].x+48;state.player.y=TERMINALS[0].y+60;
  state.credits=1000;
  return {state,analyzer,receiver};
}

async function robotMarker(page:Page) {
  return page.locator('#overview-map').evaluate((canvas:HTMLCanvasElement)=>{
    const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    let x=0,y=0,count=0;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i]===205&&pixels[i+1]===180&&pixels[i+2]===255){x+=(i/4)%canvas.width;y+=Math.floor(i/4/canvas.width);count++;}
    return count?{x:x/count,y:y/count}:null;
  });
}

test('overview redraws moving robot markers and production totals instead of showing a frozen snapshot',async({page})=>{
  // Keep the robot at its authored starting point until the map is open.
  await page.clock.install({time:0});await page.clock.pauseAt(10000);
  const {state,analyzer,receiver}=factoryState();analyzer.buffer=16;
  const x=receiver.gx*24+12,y=receiver.gy*24+12;
  state.robots=[{id:state.nextId++,kind:'robot',x:x+144,y,bag:40,capacity:ROBOTS.robot.capacity,mode:'returning',target:{x,y},path:[{x,y}],timer:1,cleanAccumulator:0}];
  await loadState(page,state);await page.keyboard.press('Tab');
  const marker=await robotMarker(page);expect(marker).not.toBeNull();
  const processed=await page.getByTestId('overview-processed').innerText();
  await page.clock.runFor(2500);
  const moved=await robotMarker(page);expect(moved).not.toBeNull();
  expect(Math.hypot(moved!.x-marker!.x,moved!.y-marker!.y)).toBeGreaterThan(8);
  await expect(page.getByTestId('overview-processed')).not.toHaveText(processed);
  expect(Number((await page.getByTestId('overview-earned').innerText()).replace(/\D/g,''))).toBeGreaterThan(0);
  await expect(page.getByRole('dialog',{name:'Обзор мира',exact:true}).locator('dd')).toHaveCount(6);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('dialog',{name:'Пауза',exact:true})).toBeVisible();
});

test('building hover stays quiet and only a click opens live details without cleaning',async({page})=>{
  await page.clock.install();
  const {state,analyzer}=factoryState();
  state.ownedTools.push('handbrush');state.player.tool='handbrush';
  await page.addInitScript(()=>{
    const draw=CanvasRenderingContext2D.prototype.fillText;
    (window as any).__worldLabels=[];
    CanvasRenderingContext2D.prototype.fillText=function(value,...args){if(this.canvas.id==='world')(window as any).__worldLabels.push(String(value));return draw.call(this,value,...args);};
  });
  await loadState(page,state);
  const world=page.locator('#world'),bounds=(await world.boundingBox())!,size=await world.evaluate((canvas:HTMLCanvasElement)=>({w:canvas.width,h:canvas.height}));
  expect(bounds.width/size.w).toBeLessThan(1.7);expect(bounds.width/size.w).toBeGreaterThan(1.5);
  const point={x:bounds.x+bounds.width/2+(analyzer.gx*24+12-state.player.x)*bounds.width/size.w,y:bounds.y+bounds.height/2+(analyzer.gy*24+12-state.player.y)*bounds.height/size.h};
  await page.mouse.move(point.x,point.y);await page.clock.runFor(300);
  await expect(page.getByTestId('building-details')).toHaveCount(0);
  const labels=await page.evaluate(()=>(window as any).__worldLabels as string[]);
  expect(labels.some(value=>/ВХ |ВЫХ |ПОРТ|Нужны|АНАЛИЗАТОР/.test(value))).toBe(false);
  expect(labels.some(value=>/^E ·/.test(value))).toBe(false);
  await expect(page.locator('#context-action')).toHaveText('E · СДАТЬ');
  const bag=await page.getByTestId('bag-count').innerText();
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.clock.runFor(1000);await page.mouse.up();
  const details=page.getByTestId('building-details');await expect(details).toBeVisible();
  await expect(details.getByRole('heading',{name:'Анализатор',exact:true})).toBeVisible();
  await expect(details).toContainText('Вход');await expect(details).toContainText('Выход');
  await expect(page.getByTestId('bag-count')).toHaveText(bag);
  await details.getByRole('button',{name:'Закрыть сведения о постройке',exact:true}).click();
  await expect(details).toHaveCount(0);
  await page.keyboard.press('b');await page.locator('[data-build="remove"]').click();await clickCell(page,analyzer.gx,analyzer.gy);
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),SAVE_KEY);
  expect(saved.buildings.some((building:{id:number})=>building.id===analyzer.id)).toBe(false);
});

test('workshop and chain guide remain accessible by keyboard from the simplified overview', async({page})=>{
  const state=createGame(42); state.credits=500; state.earned=500; Object.assign(state.player,STATIONS.workshop);
  await page.addInitScript(({key,save})=>{if(!localStorage.getItem(key))localStorage.setItem(key,save);},{key:SAVE_KEY,save:serializeGame(state)});
  await page.goto('/'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('m');
  await expect(page.getByRole('dialog',{name:'Мастерская щёток',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Купить Ручная щётка',exact:true}).click();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Ручная щётка');
  await page.keyboard.press('Escape'); await page.keyboard.press('m');
  await expect(page.getByRole('dialog',{name:'Мастерская щёток',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Обзор мира',exact:true}).click();
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog',{name:'Карта производственных цепочек',exact:true})).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Tab'); await page.keyboard.press('m');
  await expect(page.getByRole('dialog',{name:'Мастерская щёток',exact:true})).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Tab'); await page.keyboard.press('c');
  await expect(page.getByRole('dialog',{name:'Карта производственных цепочек',exact:true})).toBeVisible();
});
