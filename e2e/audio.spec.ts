import { test, expect, type Page } from '@playwright/test';

async function outputLevel(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = (window as any).__audioProbe as AnalyserNode | undefined;
    if (!probe) return 0;
    const samples = new Float32Array(probe.fftSize);
    probe.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  });
}

test('background music plays continuously, mutes and pauses with the game', async ({ page }) => {
  // Passively measure the real audio graph at the speakers; native playback stays intact.
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args: any[]) {
      if (args[0] === this.context.destination && this.context instanceof AudioContext) {
        const host = window as any;
        host.__audioProbe ??= this.context.createAnalyser();
        connect.call(this, host.__audioProbe);
      }
      return (connect as any).apply(this, args);
    } as typeof AudioNode.prototype.connect;
  });
  await page.goto('/');
  expect(await outputLevel(page)).toBe(0);
  await page.getByRole('button', { name: 'Начать уборку', exact: true }).click();
  await page.waitForTimeout(400); // The short start sound has finished.
  await expect.poll(() => outputLevel(page), { timeout: 2500 }).toBeGreaterThan(.001);
  await page.getByRole('button', { name: 'Выключить звук', exact: true }).click();
  await expect.poll(() => outputLevel(page)).toBeLessThan(.00001);
  await page.getByRole('button', { name: 'Включить звук', exact: true }).click();
  await expect.poll(() => outputLevel(page)).toBeGreaterThan(.001);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Пауза', exact: true })).toBeVisible();
  await expect.poll(() => outputLevel(page)).toBeLessThan(.00001);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect.poll(() => outputLevel(page)).toBeGreaterThan(.001);
});
