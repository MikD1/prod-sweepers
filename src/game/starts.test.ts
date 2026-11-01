import { describe, expect, it } from 'vitest';
import { createGame, receiverHasRoute, updateGame } from './engine';
import { deserializeGame, serializeGame } from './persistence';
import { createDevelopedGame, type DevelopedProgress } from './starts';
import { BUILD_CELL, BUILDINGS, CELL, ECONOMY, GRID_W, HUB, MATERIALS, SPAWN, TOOLS, VEHICLES, type GameState } from './types';

const held = (state: GameState) => state.player.bag + state.robots.reduce((n,r)=>n+r.bag,0)
  + Object.values(state.recovered).reduce((n,units)=>n+units,0)
  + state.capsules.reduce((n,c)=>n+c.units,0)
  + state.buildings.reduce((n,b)=>n+b.buffer+b.outputBuffer+(b.processing?.units??0),0);
const mass = (state: GameState) => state.dust.reduce((n,units)=>n+units,0)+held(state)+state.stats.delivered-state.stats.rawReclaimed;
const snapshots=new Map<number,GameState>();
const developed=(seed:number)=>{
  if(!snapshots.has(seed))snapshots.set(seed,createDevelopedGame(seed));
  return deserializeGame(serializeGame(snapshots.get(seed)!))!;
};

/** A replay leaves dirt nearer the base than some of its cleaned tracks. */
function trackRanges(state:GameState) {
  const fresh=createGame(state.seed);
  let nearestDirt=Infinity, farthestTrack=0;
  for(let index=0;index<state.dust.length;index++) {
    if(!fresh.dust[index])continue;
    const range=Math.hypot(index%GRID_W*CELL+CELL/2-HUB.x,Math.floor(index/GRID_W)*CELL+CELL/2-HUB.y);
    if(state.dust[index])nearestDirt=Math.min(nearestDirt,range);
    if(state.dust[index]<fresh.dust[index])farthestTrack=Math.max(farthestTrack,range);
    expect(state.dust[index]).toBeLessThanOrEqual(fresh.dust[index]);
  }
  return {nearestDirt,farthestTrack};
}

describe('simulated developed-world start',()=>{
  it.each([42,17])('hands over on foot at the base with the real vehicle cargo unloaded in seed %i',seed=>{
    const state=developed(seed);
    expect(state.player.riding).toBe(false);
    expect(state.player.bag).toBe(0);
    expect(Math.hypot(state.player.x-SPAWN.x,state.player.y-SPAWN.y)).toBeLessThan(24);
    expect(state.vehicles.every(vehicle=>vehicle.speed===0)).toBe(true);
    const parked=state.vehicles.find(vehicle=>vehicle.kind==='vehicle')!;
    expect(Math.hypot(parked.x-(HUB.x+84),parked.y-(HUB.y+96))).toBeLessThan(24);
    for(const vehicle of state.vehicles)for(const building of state.buildings) {
      const x=building.gx*BUILD_CELL,y=building.gy*BUILD_CELL;
      expect(Math.hypot(vehicle.x-Math.max(x,Math.min(vehicle.x,x+24)),vehicle.y-Math.max(y,Math.min(vehicle.y,y+24)))).toBeGreaterThanOrEqual(8);
    }
    expect(mass(state)).toBe(state.totalDirt);
  },60_000);
  it('leaves actual irregular cleaning tracks rather than a painted clean circle',()=>{
    const state=developed(42), {nearestDirt,farthestTrack}=trackRanges(state);
    expect(farthestTrack-nearestDirt).toBeGreaterThan(300);
    expect(state.stats.distance).toBeGreaterThan(5000);
    expect(held(state)).toBeGreaterThan(0);
  },60_000);

  it.each([42,17])('earns a full fleet of two small and three PRO robots for seed %i',seed=>{
    const state=developed(seed), fresh=createGame(seed);
    expect(state.time).toBeGreaterThan(15*60); expect(state.time).toBeLessThanOrEqual(75*60);
    expect(state.ownedTools).toEqual(Object.keys(TOOLS));
    expect(state.player.capacityLevel).toBeGreaterThanOrEqual(2);
    expect(state.vehicles.map(v=>v.kind).sort()).toEqual(['compact','vehicle']);
    expect(state.robots).toHaveLength(ECONOMY.maxRobots);
    expect(state.robots.map(r=>r.kind).sort()).toEqual(['industrialRobot','industrialRobot','industrialRobot','robot','robot']);
    expect(state.buildings.filter(b=>b.kind==='uplink')).toHaveLength(4);
    expect(state.buildings.filter(b=>b.kind==='analyzer')).toHaveLength(6);
    expect(state.buildings.filter(b=>b.kind==='tester')).toHaveLength(6);
    expect(state.buildings.filter(b=>b.kind==='receiver')).toHaveLength(4);
    expect(state.buildings.filter(b=>b.kind==='receiver'&&Math.hypot(b.gx*BUILD_CELL+12-HUB.x,b.gy*BUILD_CELL+12-HUB.y)>=1300)).toHaveLength(2);
    expect(state.buildings.filter(b=>b.kind==='receiver').every(b=>receiverHasRoute(state,b))).toBe(true);
    expect(state.cleaned).toBeGreaterThan(0); expect(state.cleaned).toBeLessThan(state.totalDirt*.5);
    expect(state.totalDirt).toBe(fresh.totalDirt); expect(mass(state)).toBe(state.totalDirt);
    expect(state.earned).toBe(state.stats.rawSold*MATERIALS.raw.value+state.stats.reportsSold*MATERIALS.report.value+state.stats.testsSold*MATERIALS.test.value+25*state.discoveries.length);
    expect(state.credits).toBeGreaterThanOrEqual(0); expect(state.earned-state.credits).toBeGreaterThan(ECONOMY.industrialRobot);
    const cost=state.ownedTools.reduce((sum,id)=>sum+TOOLS[id].price,0)
      +ECONOMY.capacity.slice(0,state.player.capacityLevel).reduce((sum,price)=>sum+price,0)
      +ECONOMY.speed.slice(0,state.player.speedLevel).reduce((sum,price)=>sum+price,0)
      +VEHICLES.compact.price+VEHICLES.vehicle.price+1800+2200+75000+90000+108000
      +state.buildings.reduce((sum,b)=>sum+(b.kind==='uplink'?0:BUILDINGS[b.kind].price),0)+2*(BUILDINGS.belt.price-Math.floor(BUILDINGS.belt.price/2));
    expect(state.earned-state.credits).toBe(cost);
    expect(deserializeGame(serializeGame(state))).not.toBeNull();
  },60_000);

  it('connects every generated functional building through conveyors instead of placing machines against each other',()=>{
    const buildings=developed(42).buildings, machines=buildings.filter(b=>b.kind!=='belt');
    for(let i=0;i<machines.length;i++)for(let j=i+1;j<machines.length;j++){
      expect(Math.abs(machines[i].gx-machines[j].gx)+Math.abs(machines[i].gy-machines[j].gy)).toBeGreaterThan(1);
    }
    for(const b of buildings) {
      const x=b.gx*BUILD_CELL,y=b.gy*BUILD_CELL;
      expect(Math.hypot(SPAWN.x-Math.max(x,Math.min(SPAWN.x,x+24)),SPAWN.y-Math.max(y,Math.min(SPAWN.y,y+24)))).toBeGreaterThanOrEqual(36);
    }
  },60_000);

  it('reports real simulated time through every fleet purchase',()=>{
    const progress:DevelopedProgress[]=[];
    const state=createDevelopedGame(42,p=>progress.push(p));
    expect(progress.length).toBeGreaterThan(5);
    expect(progress[0].elapsedSeconds).toBe(0);
    expect(progress.at(-1)!.elapsedSeconds).toBeCloseTo(state.time,5);
    expect(progress.some(p=>p.goal==='industrialRobot')).toBe(true);
    expect(progress.some(p=>p.goal==='industrialRobot2')).toBe(true);
    expect(progress.some(p=>p.goal==='robot2')).toBe(true);
    expect(progress.some(p=>p.goal==='industrialRobot3')).toBe(true);
    for(let i=1;i<progress.length;i++){
      expect(progress[i].elapsedSeconds).toBeGreaterThanOrEqual(progress[i-1].elapsedSeconds);
      expect(progress[i].percent).toBeGreaterThanOrEqual(progress[i-1].percent);
      expect(progress[i].percent).toBeLessThan(100);
    }
    expect(state.dust).toEqual(snapshots.get(42)!.dust);
    expect(state.stats).toEqual(snapshots.get(42)!.stats);
  },60_000);

  it('continues an actual snapshot after save/reload without losing cargo or resetting the world',()=>{
    const state=developed(42), restored=deserializeGame(serializeGame(state))!;
    const before=state.stats.testsSold;
    const robotsBefore=new Map(state.robots.map(robot=>[robot.id,{...robot}]));
    for(let frame=0;frame<100;frame++)for(const world of [state,restored])updateGame(world,.1,{dx:0,dy:0,clean:false});
    expect(state.stats.testsSold).toBeGreaterThan(before);
    for(const robot of state.robots){
      const previous=robotsBefore.get(robot.id)!;
      expect(Math.hypot(robot.x-previous.x,robot.y-previous.y)>1||robot.bag!==previous.bag).toBe(true);
    }
    expect(state.dust).toEqual(restored.dust);expect(state.credits).toBe(restored.credits);
    expect(state.stats).toEqual(restored.stats);expect(mass(state)).toBe(state.totalDirt);
    expect(deserializeGame(serializeGame(state))).not.toBeNull();
    const fresh=createGame(42);
    expect(fresh.cleaned).toBe(0); expect(fresh.credits).toBe(0); expect(fresh.robots).toEqual([]);
  },60_000);
});
