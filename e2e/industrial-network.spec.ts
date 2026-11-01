import { test, expect } from '@playwright/test';
import { createIndustrialNetworkPlan } from '../src/game/autoplay';
import { createGame, placeBuilding, receiverHasRoute, updateGame } from '../src/game/engine';
import { SAVE_KEY, serializeGame } from '../src/game/persistence';
import { SPAWN, type GameState } from '../src/game/types';

const mass = (state: GameState) => state.dust.reduce((n, units) => n + units, 0)
  + state.player.bag + state.robots.reduce((n, robot) => n + robot.bag, 0)
  + state.capsules.reduce((n, capsule) => n + capsule.units, 0)
  + Object.values(state.recovered).reduce((n, units) => n + units, 0)
  + state.buildings.reduce((n, building) => n + building.buffer + building.outputBuffer + (building.processing?.units ?? 0), 0)
  + state.stats.delivered - state.stats.rawReclaimed;

// An explicitly financed late-game fixture isolates transport from gathering.
// All factory stock is removed from the generated world's finite dirt supply.
function factory(lanes: 1 | 4) {
  const state = createGame(42);
  state.obstacles = []; state.landmarks = [];
  state.ownedTools.push('handbrush'); state.player.tool = 'handbrush'; state.player.capacityLevel = 2;
  state.credits = 50192; state.earned = 50192;
  state.stats.reportsSold = 64; state.stats.processed = 64; state.stats.delivered = 64;
  const network = createIndustrialNetworkPlan(state, { lanes, additionalReceiver: false });
  for (const [kind, gx, gy, dir] of network.plan) {
    state.player.x = gx * 24 + 12; state.player.y = gy * 24 + 12;
    expect(placeBuilding(state, kind, gx, gy, dir).ok).toBe(true);
  }
  const receiver = state.buildings.find(b => b.kind === 'receiver')!;
  expect(state.buildings.filter(b => b.kind === 'receiver')).toHaveLength(1);
  expect(receiverHasRoute(state, receiver)).toBe(true);
  receiver.buffer = 16384;
  let remaining = receiver.buffer + 64;
  for (let i = 0; remaining && i < state.dust.length; i++) {
    const units = Math.min(remaining, state.dust[i]);
    state.dust[i] -= units; state.cleaned += units; remaining -= units;
  }
  expect(remaining).toBe(0); expect(mass(state)).toBe(state.totalDirt);
  Object.assign(state.player, SPAWN);
  // Fill the actual long belts before opening the browser; it then measures
  // steady transport through the real frame loop rather than startup latency.
  for (let frame = 0; frame < 1600; frame++) updateGame(state, .05, { dx: 0, dy: 0, clean: false });
  return state;
}

test('one distant receiver feeds four real parallel checks faster than one and survives reload without duplicating stock', async ({ browser }) => {
  test.setTimeout(120000);
  const rates: number[] = [];
  for (const lanes of [1, 4] as const) {
    const state = factory(lanes), page = await browser.newPage();
    try {
      await page.clock.install({ time: 0 }); await page.clock.pauseAt(10000);
      await page.addInitScript(({ key, save }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, save);
      }, { key: SAVE_KEY, save: serializeGame(state) });
      await page.goto('/'); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
      const warmup: GameState = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
      await page.clock.runFor(20000); await page.keyboard.press('Escape');
      const result: GameState = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
      const sold = result.stats.testsSold - warmup.stats.testsSold;
      expect(sold).toBeGreaterThan(200);
      expect(result.credits - warmup.credits).toBe(sold * 7);
      expect(result.stats.rawSold).toBe(0); expect(result.stats.reportsSold).toBe(64);
      expect(result.buildings.filter(b => b.kind === 'analyzer')).toHaveLength(lanes);
      expect(result.buildings.filter(b => b.kind === 'tester')).toHaveLength(lanes);
      expect(mass(result)).toBe(result.totalDirt);
      rates.push(sold);
      await page.reload(); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
      await page.clock.runFor(2000); await page.keyboard.press('Escape');
      const restored: GameState = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
      expect(restored.stats.testsSold).toBeGreaterThan(result.stats.testsSold);
      expect(mass(restored)).toBe(restored.totalDirt);
    } finally { await page.close(); }
  }
  expect(rates[1]).toBeGreaterThan(rates[0] * 2.8);
});
