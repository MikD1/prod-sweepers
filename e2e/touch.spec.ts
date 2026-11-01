import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { createGame, placeBuilding } from '../src/game/engine';
import { deserializeGame, SAVE_KEY, serializeGame } from '../src/game/persistence';
import { BASE_HALF_SIZE, BUILD_CELL, BUILDINGS, CELL, GRID_W, HUB, STATIONS, TERMINALS, type GameState, type Vec } from '../src/game/types';
import { pointForCell } from './helpers';

test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

type Contact = Vec & { id: number; radiusX: number; radiusY: number; force: number };

/** Chromium generates actual touch/pointer events for every changed contact. */
class Fingers {
  private contacts = new Map<number, Contact>();
  private constructor(private session: CDPSession) {}

  static async on(page: Page) { return new Fingers(await page.context().newCDPSession(page)); }

  private async dispatch(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel') {
    await this.session.send('Input.dispatchTouchEvent', { type, touchPoints: [...this.contacts.values()] });
  }

  async down(id: number, point: Vec) {
    this.contacts.set(id, { ...point, id, radiusX: 4, radiusY: 4, force: 1 });
    await this.dispatch('touchStart');
  }

  async move(id: number, point: Vec) {
    const contact = this.contacts.get(id);
    if (!contact) throw new Error(`Finger ${id} is not down`);
    this.contacts.set(id, { ...contact, ...point });
    await this.dispatch('touchMove');
  }

  async up(id: number) {
    const contact = this.contacts.get(id);
    if (!contact) throw new Error(`Finger ${id} is not down`);
    this.contacts.delete(id);
    // Chromium accepts the changed contact on touchEnd and keeps the other fingers down.
    await this.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [contact] });
  }

  async cancel() {
    this.contacts.clear();
    await this.dispatch('touchCancel');
  }

  async tap(target: Locator | Vec, id = 33) {
    const point = 'boundingBox' in target ? await center(target) : target;
    await this.down(id, point);
    await this.up(id);
  }
}

async function center(locator: Locator): Promise<Vec> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing touch target: ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function insideViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!, viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function frozenClock(page: Page) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(10000);
}

async function continueGame(page: Page, state: GameState) {
  // Also check the fixture against the same save validator used by the real app.
  const save = serializeGame(state);
  expect(deserializeGame(save)).not.toBeNull();
  await frozenClock(page);
  await page.addInitScript(({ key, save }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, save);
  }, { key: SAVE_KEY, save });
  await page.goto('/');
  await page.getByRole('button', { name: 'Продолжить', exact: true }).tap();
  await expect(page.locator('#touch-controls')).toBeVisible();
  await page.clock.runFor(160);
}

async function savedGame(page: Page): Promise<GameState> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), SAVE_KEY);
}

async function position(page: Page): Promise<Vec> {
  const [x, y] = (await page.locator('#coordinates').innerText()).match(/\d+/g)!.map(Number);
  return { x, y };
}

async function bag(page: Page) { return Number(await page.getByTestId('bag-count').innerText()); }

function takeWorldDust(state: GameState, units: number) {
  let remaining = units;
  for (let i = 0; remaining && i < state.dust.length; i++) {
    const taken = Math.min(remaining, state.dust[i]);
    state.dust[i] -= taken;
    state.cleaned += taken;
    remaining -= taken;
  }
  expect(remaining).toBe(0);
}

/** Move existing world dust to the exercise area without inventing any mass. */
function supplyDust(state: GameState, point: Vec, halfWidth = 250, halfHeight = 160) {
  const cells = new Set<number>();
  for (let gy = Math.floor((point.y - halfHeight) / CELL); gy <= Math.floor((point.y + halfHeight) / CELL); gy++) {
    for (let gx = Math.floor((point.x - halfWidth) / CELL); gx <= Math.floor((point.x + halfWidth) / CELL); gx++) {
      cells.add(gy * GRID_W + gx);
    }
  }
  let needed = [...cells].reduce((sum, i) => sum + 8 - state.dust[i], 0);
  for (let i = 0; needed && i < state.dust.length; i++) {
    if (cells.has(i)) continue;
    const moved = Math.min(needed, state.dust[i]);
    state.dust[i] -= moved;
    needed -= moved;
  }
  expect(needed).toBe(0);
  for (const i of cells) state.dust[i] = 8;
}

function sweepFixture() {
  const state = createGame(42);
  state.obstacles = [];
  Object.assign(state.player, { x: HUB.x + BASE_HALF_SIZE + 80, y: HUB.y, facingX: 1, facingY: 0 });
  supplyDust(state, state.player);
  return state;
}

async function deflectStick(page: Page, fingers: Fingers, direction: Vec, id = 11) {
  const stick = page.locator('#touch-stick'), box = (await stick.boundingBox())!;
  const origin = await center(stick), length = Math.hypot(direction.x, direction.y);
  await fingers.down(id, origin);
  await fingers.move(id, { x: origin.x + direction.x / length * box.width * .4, y: origin.y + direction.y / length * box.height * .4 });
}

test('touch controls fit portrait, landscape and narrow screens, with scrollable dialogs', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#touch-controls')).toBeHidden();
  await page.getByRole('button', { name: 'Начать уборку', exact: true }).tap();
  await expect(page.locator('#touch-controls')).toBeVisible({ timeout: 1500 });
  await expect(page.locator('body')).toHaveClass(/touch-mode/);
  await expect(page.locator('#touch-clean')).toHaveAccessibleName('Убирать');
  await expect(page.locator('#touch-clean')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#touch-vehicle')).toBeHidden();
  await expect(page.locator('#touch-build-confirm')).toBeHidden();

  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 360, height: 640 }]) {
    await page.setViewportSize(viewport);
    for (const selector of ['#touch-stick', '#touch-stick-knob', '#touch-clean', '#overview-toggle', '#build-toggle', '#workshop']) {
      await insideViewport(page, page.locator(selector));
    }
    for (const tool of await page.locator('[data-tool]').all()) await insideViewport(page, tool);
    const stick = (await page.locator('#touch-stick').boundingBox())!;
    expect(stick.width).toBeGreaterThanOrEqual(100);
    expect(stick.height).toBeGreaterThanOrEqual(100);
    const clean = (await page.locator('#touch-clean').boundingBox())!;
    expect(stick.x + stick.width).toBeLessThanOrEqual(clean.x + 1);
  }

  await page.locator('#help').tap();
  const help = page.getByRole('dialog', { name: 'Как играть', exact: true });
  await insideViewport(page, help);
  await expect(page.locator('#touch-controls')).toBeHidden();
  const scroll = await help.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }));
  expect(scroll.content).toBeGreaterThan(scroll.height);
  const fingers = await Fingers.on(page), bounds = (await help.boundingBox())!;
  const swipe = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * .8 };
  await fingers.down(11, swipe);
  for (let i = 1; i <= 6; i++) await fingers.move(11, { x: swipe.x, y: swipe.y - i * 35 });
  await fingers.up(11);
  await expect.poll(() => help.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.locator('#close-modal').tap();
  await expect(page.locator('#touch-controls')).toBeVisible();
});

test('two fingers walk and sweep real dust, and either finger can be released independently', async ({ page }) => {
  const state = sweepFixture(), initialDust = state.dust.reduce((sum, n) => sum + n, 0);
  await continueGame(page, state);
  const fingers = await Fingers.on(page), stickCenter = await center(page.locator('#touch-stick'));
  await deflectStick(page, fingers, { x: 1, y: 0 });
  await fingers.down(22, await center(page.locator('#touch-clean')));
  await expect(page.locator('#touch-clean')).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(900);
  const sweeping = await position(page), collected = await bag(page);
  expect(sweeping.x - state.player.x).toBeGreaterThan(65);
  expect(collected).toBeGreaterThan(0);
  expect(await center(page.locator('#touch-stick'))).toEqual(stickCenter);

  await fingers.up(22);
  await expect(page.locator('#touch-clean')).toHaveAttribute('aria-pressed', 'false');
  await page.clock.runFor(500);
  const walking = await position(page);
  expect(walking.x - sweeping.x).toBeGreaterThan(35);
  expect(await bag(page)).toBe(collected);

  await fingers.down(22, await center(page.locator('#touch-clean')));
  await fingers.up(11);
  // The live coordinates refresh at 10 Hz; let them catch up to the release position.
  await page.clock.runFor(150);
  const standing = await position(page);
  expect(Math.abs(standing.x - walking.x)).toBeLessThanOrEqual(12);
  await page.clock.runFor(500);
  expect(await position(page)).toEqual(standing);
  expect(await bag(page)).toBeGreaterThan(collected);
  await expect(page.locator('#touch-clean')).toHaveAttribute('aria-pressed', 'true');
  await fingers.up(22);
  await page.clock.runFor(150);
  const stoppedBag = await bag(page);
  await page.clock.runFor(500);
  expect(await position(page)).toEqual(standing);
  expect(await bag(page)).toBe(stoppedBag);

  await page.locator('#pause').tap();
  const saved = await savedGame(page);
  expect(saved.cleaned - state.cleaned).toBe(stoppedBag);
  expect(initialDust - saved.dust.reduce((sum, n) => sum + n, 0)).toBe(stoppedBag);
});

test('cancel, page exit, resize, dialogs and blur clear held touch inputs without a later restart', async ({ page }) => {
  await continueGame(page, sweepFixture());
  const fingers = await Fingers.on(page);
  const holdBoth = async () => {
    await deflectStick(page, fingers, { x: 1, y: 0 });
    await fingers.down(22, await center(page.locator('#touch-clean')));
    await page.clock.runFor(250);
  };
  const expectStopped = async () => {
    await page.clock.runFor(150);
    const stopped = await position(page), load = await bag(page);
    await page.clock.runFor(500);
    expect(await position(page)).toEqual(stopped);
    expect(await bag(page)).toBe(load);
    await expect(page.locator('#touch-clean')).toHaveAttribute('aria-pressed', 'false');
  };

  await holdBoth();
  await fingers.cancel();
  await page.clock.runFor(150);
  await expectStopped();

  await holdBoth();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expectStopped();
  await fingers.cancel();

  await holdBoth();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.clock.runFor(150);
  await expectStopped();
  await fingers.cancel();

  await holdBoth();
  // Open a dialog while the physical contacts are still held, then verify its reset.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog', { name: 'Обзор мира', exact: true })).toBeVisible();
  await expect(page.locator('#touch-controls')).toBeHidden();
  await expectStopped();
  await fingers.cancel();
  await page.locator('#close-modal').tap();
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expectStopped();

  await holdBoth();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('dialog', { name: 'Пауза', exact: true })).toBeVisible();
  await expect(page.locator('#touch-controls')).toBeHidden();
  await fingers.cancel();
  await page.locator('#close-modal').tap();
  await page.clock.runFor(150);
  await expectStopped();
});

test('contextual touch delivers cargo, opens the workshop and buys tools without map input leaking', async ({ page }) => {
  const state = createGame(42), terminal = TERMINALS[0], cargo = 60;
  Object.assign(state.player, { x: terminal.x + 55, y: terminal.y + 55 });
  state.credits = 500; state.earned = 500;
  takeWorldDust(state, cargo); state.player.bag = cargo;
  await continueGame(page, state);
  await page.locator('#touch-interact').tap();
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await expect(page.getByTestId('credits')).toHaveText(String(500 + cargo));
  expect((await savedGame(page)).stats.delivered).toBe(cargo);

  const fingers = await Fingers.on(page);
  await deflectStick(page, fingers, { x: STATIONS.workshop.x - state.player.x, y: STATIONS.workshop.y - state.player.y });
  await page.clock.runFor(1800);
  await fingers.up(11);
  await page.clock.runFor(160);
  const atShop = await position(page);
  expect(Math.hypot(atShop.x - STATIONS.workshop.x, atShop.y - STATIONS.workshop.y)).toBeLessThan(30);
  await page.locator('#touch-interact').tap();
  const shop = page.getByRole('dialog', { name: 'Мастерская щёток', exact: true });
  await expect(shop).toBeVisible();
  await expect(page.locator('#touch-controls')).toBeHidden();
  await page.getByRole('button', { name: 'Купить Ручная щётка', exact: true }).tap();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Ручная щётка');
  await page.locator('#close-modal').tap();
  await page.locator('[data-tool="toothbrush"]').tap();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Зубная щётка');
  await page.locator('[data-tool="handbrush"]').tap();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Ручная щётка');
  await page.locator('#workshop').tap();
  await expect(shop).toBeVisible();
  await page.locator('#close-modal').tap();

  const beforeMap = await position(page), beforeBag = await bag(page);
  await page.locator('#overview-toggle').tap();
  const map = page.locator('#overview-map'), mapCenter = await center(map);
  await fingers.down(11, mapCenter);
  await fingers.move(11, { x: mapCenter.x + 40, y: mapCenter.y - 40 });
  await page.clock.runFor(800);
  await fingers.up(11);
  expect(await position(page)).toEqual(beforeMap);
  expect(await bag(page)).toBe(beforeBag);
  await page.locator('#close-modal').tap();
  await page.clock.runFor(500);
  expect(await position(page)).toEqual(beforeMap);
  expect(await bag(page)).toBe(beforeBag);
  const saved = await savedGame(page);
  expect(saved.ownedTools).toContain('handbrush');
  expect(saved.credits).toBe(500 + cargo - 400);
});

test('the touch warehouse action sells recovered cargo even beside a closer receiver', async ({ page }) => {
  const state = createGame(42), terminal = TERMINALS[0];
  Object.assign(state.player, { x: terminal.x + BUILD_CELL, y: terminal.y });
  state.ownedTools.push('handbrush'); state.player.tool = 'handbrush';
  state.credits = 1000; state.earned = 1000;
  expect(placeBuilding(state, 'receiver', Math.floor(state.player.x / BUILD_CELL), Math.floor(state.player.y / BUILD_CELL), 0).ok).toBe(true);
  takeWorldDust(state, 40); state.recovered.raw = 40;
  const balance = state.credits;
  await continueGame(page, state);
  const interact = page.locator('#touch-interact');
  await expect(interact).toHaveText('Продать склад');
  await interact.tap();
  const saved = await savedGame(page);
  expect(saved.recovered.raw).toBe(0);
  expect(saved.credits).toBe(balance + 40);
  await expect(interact).toHaveText('Терминал');
  await interact.tap();
  await expect(page.getByRole('dialog', { name: 'Терминал продажи', exact: true })).toBeVisible();
});

test('a nearby compact sweeper drives forward, steers and sweeps with two fingers, then exits', async ({ page }) => {
  const state = sweepFixture();
  Object.assign(state.player, { capacityLevel: 1 });
  state.ownedTools.push('handbrush'); state.player.tool = 'handbrush';
  state.vehicles.push({ kind: 'compact', x: state.player.x, y: state.player.y, heading: -Math.PI / 2, speed: 0 });
  await continueGame(page, state);
  await expect(page.locator('#touch-vehicle')).toBeVisible();
  await page.locator('#touch-vehicle').tap();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Мини-уборщик');
  expect((await savedGame(page)).player.riding).toBe(true);

  const fingers = await Fingers.on(page);
  await deflectStick(page, fingers, { x: 0, y: -1 });
  await fingers.down(22, await center(page.locator('#touch-clean')));
  await page.clock.runFor(1000);
  const forward = await position(page);
  expect(state.player.y - forward.y).toBeGreaterThan(35);
  expect(Math.abs(forward.x - state.player.x)).toBeLessThan(5);
  expect(await bag(page)).toBeGreaterThan(0);
  const stick = (await page.locator('#touch-stick').boundingBox())!, origin = await center(page.locator('#touch-stick'));
  await fingers.move(11, { x: origin.x + stick.width * .3, y: origin.y - stick.height * .35 });
  await page.clock.runFor(800);
  const turned = await position(page);
  expect(turned.x - forward.x).toBeGreaterThan(8);
  await fingers.up(22);
  await fingers.up(11);
  await page.clock.runFor(600);
  const stopped = await position(page), load = await bag(page);
  await page.clock.runFor(500);
  expect(await position(page)).toEqual(stopped);
  expect(await bag(page)).toBe(load);
  await page.locator('#touch-vehicle').tap();
  await expect(page.getByTestId('equipped-tool')).toHaveText('Ручная щётка');
  const saved = await savedGame(page);
  expect(saved.player.riding).toBe(false);
  expect(saved.player.vehicleKind).toBeNull();
  expect(saved.vehicles[0].kind).toBe('compact');
  expect(saved.vehicles[0].heading).toBeGreaterThan(-Math.PI / 2 + .2);
  expect(saved.player.bag).toBeGreaterThan(0);
  expect(saved.vehicles[0].speed).toBe(0);
});

test('touch construction previews before confirmation, recovers loaded demolition cargo and inspects without cleaning', async ({ page }) => {
  const state = createGame(42), terminal = TERMINALS[0];
  Object.assign(state.player, { x: terminal.x, y: terminal.y + 72 });
  state.credits = 1000; state.earned = 1000;
  const gx = Math.floor(state.player.x / BUILD_CELL) + 3, gy = Math.floor(state.player.y / BUILD_CELL) - 1;
  expect(placeBuilding(state, 'receiver', gx, gy, 0).ok).toBe(true);
  const receiver = state.buildings.find(b => b.kind === 'receiver')!;
  takeWorldDust(state, 40); receiver.buffer = 40;
  const initialDust = state.dust.reduce((sum, n) => sum + n, 0), count = state.buildings.length, balance = state.credits;
  await continueGame(page, state);
  const fingers = await Fingers.on(page);
  await expect(page.locator('#touch-build-confirm')).toBeHidden();
  await page.locator('#build-toggle').tap();
  await page.locator('[data-build="belt"]').tap();
  const beltCell = { gx, gy: gy + 2 };
  await fingers.tap(await pointForCell(page, beltCell.gx, beltCell.gy));
  await page.clock.runFor(300);
  const preview = await savedGame(page);
  expect(preview.buildings).toHaveLength(count);
  expect(preview.credits).toBe(balance);
  const confirm = page.locator('#touch-build-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Построить');
  await confirm.tap();
  const built = await savedGame(page);
  expect(built.buildings.some(b => b.kind === 'belt' && b.gx === beltCell.gx && b.gy === beltCell.gy)).toBe(true);
  expect(built.credits).toBe(balance - BUILDINGS.belt.price);

  await page.locator('[data-build="remove"]').tap();
  await fingers.tap(await pointForCell(page, receiver.gx, receiver.gy));
  expect((await savedGame(page)).buildings.some(b => b.id === receiver.id)).toBe(true);
  await expect(confirm).toContainText('Снести');
  await confirm.tap();
  const removed = await savedGame(page);
  expect(removed.buildings.some(b => b.id === receiver.id)).toBe(false);
  expect(removed.recovered.raw).toBe(40);
  expect(removed.credits).toBe(balance - BUILDINGS.belt.price + BUILDINGS.receiver.price / 2);
  await page.locator('#close-build').tap();
  await expect(confirm).toBeHidden();

  const beltPoint = await pointForCell(page, beltCell.gx, beltCell.gy);
  await fingers.down(11, beltPoint);
  await page.clock.runFor(1000);
  await fingers.up(11);
  const details = page.getByTestId('building-details');
  await expect(details).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Конвейер', exact: true })).toBeVisible();
  await expect(page.getByTestId('bag-count')).toHaveText('0');
  await details.getByRole('button', { name: 'Закрыть сведения о постройке', exact: true }).tap();
  await page.locator('#pause').tap();
  const saved = await savedGame(page);
  expect(saved.cleaned).toBe(state.cleaned);
  expect(saved.dust.reduce((sum, n) => sum + n, 0)).toBe(initialDust);
});

test.describe('desktop input', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } });

  test('desktop starts without touch controls', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Начать уборку', exact: true }).click();
    await expect(page.getByTestId('game-hud')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/touch-mode/);
    await expect(page.locator('#touch-controls')).toBeHidden();
  });
});
