import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const defaults = ['Recommendations', 'Transit', 'Calendar', 'Due work', 'Dining menu', 'Study spaces', 'Courses'];
const shot = (name: string) => fileURLToPath(new URL(`../../../scratch/${name}.png`, import.meta.url));

test('panel order changes the dashboard, persists, and restores without resetting other preferences', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  const names = page.locator('.panel-order-name');
  await expect(names).toHaveText(defaults);
  const handle = page.getByRole('button', { name: 'Reorder Transit', exact: true });
  const from = (await handle.boundingBox())!;
  const to = (await page.locator('[data-panel-id="recommendations"]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 8, { steps: 12 });
  await page.mouse.up();
  await expect(names).toHaveText(['Transit', 'Recommendations', ...defaults.slice(2)]);
  await expect(page.locator('.dashboard-panels > section').first()).toHaveAttribute('id', 'transit');
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect(names).toHaveText(defaults);
  await page.keyboard.press('ArrowUp');
  await expect(handle).toBeFocused();
  await page.screenshot({ path: shot('panel-order-desktop'), animations: 'disabled' });
  await page.reload();
  await expect(page.locator('.dashboard-panels > section').first()).toHaveAttribute('id', 'transit');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(names).toHaveText(['Transit', 'Recommendations', ...defaults.slice(2)]);
  await page.screenshot({ path: shot('panel-order-mobile'), animations: 'disabled' });
  const list = page.getByRole('list', { name: 'Dashboard panel order' });
  await expect.poll(() => list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Restore default', exact: true }).click();
  await expect(names).toHaveText(defaults);
  await expect(page.locator('.dashboard-panels > section').first()).toHaveAttribute('aria-label', 'Recommendations');
  await expect(page.getByRole('button', { name: 'Restore default', exact: true })).toBeDisabled();
});

test('saved panel order drops unknown and duplicate panels and includes new panels', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('uni-dashboard:preferences:v3', JSON.stringify({
    panelOrder: ['courses', 'unknown', 'courses', 'calendar'], density: 'compact',
  })));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  await expect(page.locator('.panel-order-name')).toHaveText(['Courses', 'Calendar', 'Recommendations', 'Transit', 'Due work', 'Dining menu', 'Study spaces']);
  await page.getByRole('button', { name: 'Restore default', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('uni-dashboard:preferences:v3')!).density)).toBe('compact');
});

test('a phone touch drag can move a panel across the entire list', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8799/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  const handle = page.getByRole('button', { name: 'Reorder Courses', exact: true });
  await handle.scrollIntoViewIfNeeded();
  const from = (await handle.boundingBox())!;
  const to = (await page.locator('[data-panel-id="recommendations"]').boundingBox())!;
  const x = from.x + from.width / 2, y = from.y + from.height / 2;
  const session = await context.newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 30; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (to.y + 8 - y) * step / 30 }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.panel-order-name')).toHaveText(['Courses', ...defaults.slice(0, -1)]);
  await expect(page.locator('.is-dragging')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: shot('panel-order-narrow-mobile'), animations: 'disabled' });
  await context.close();
});

test('grouped settings fit the drawer, animate on switching, and respect reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('tab')).toHaveText(['Dining', 'Layout', 'Courses', 'Schedule', 'Connections', 'Status', 'Recommendations']);
  await expect.poll(() => page.locator('.settings-selector').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  await expect.poll(() => page.getByRole('tabpanel').evaluate(el => getComputedStyle(el).animationName)).toBe('settings-panel-enter');
  await page.getByText('About this dashboard', { exact: true }).click();
  await expect(page.locator('.settings-merged-group')).toHaveAttribute('data-expanded', 'true');
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.getByText('Agent access (MCP)', { exact: true }).click();
  await expect(page.locator('.settings-merged-group[open]')).toBeVisible();
  await page.screenshot({ path: shot('settings-connections-group'), animations: 'disabled' });
  await page.getByRole('tab', { name: 'Schedule', exact: true }).click();
  await page.getByText('Transit and commutes', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add commute', exact: true })).toBeVisible();
  await page.screenshot({ path: shot('settings-schedule-group'), animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('tab', { name: 'Layout', exact: true }).click();
  await expect.poll(() => page.getByRole('tabpanel').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: shot('settings-grouped-desktop'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: shot('settings-grouped-mobile'), animations: 'disabled' });
});
