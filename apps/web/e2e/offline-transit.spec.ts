import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const shot = (name: string) => fileURLToPath(new URL(`../../../scratch/${name}.png`, import.meta.url));

test.beforeEach(async ({ request }) => { await request.get('/__test/reset'); });

test('transit activation, responsive layout and read-only cold offline reload', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Transit', exact: true })).toBeVisible();
  await expect(page.getByText('Residence → Campus', { exact: true })).toBeVisible();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.getByRole('button', { name: /Going to campus for/ }).click();
  await expect(page.getByRole('button', { name: 'Cancel today’s trip' })).toBeVisible();
  await expect(page.locator('.transit-guidance')).toContainText('Leave');
  await page.screenshot({ path: shot('transit-desktop'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: shot('transit-mobile'), fullPage: true });
  await context.setOffline(true);
  await page.close();
  const offline = await context.newPage();
  await offline.goto('/');
  await expect(offline.getByText(/Offline · Showing saved information/)).toBeVisible();
  await expect(offline.getByText('Residence → Campus', { exact: true })).toBeVisible();
  await expect(offline.getByRole('button', { name: 'Cancel today’s trip' })).toBeDisabled();
  await expect(offline.locator('.transit-guidance')).toHaveCount(0);
  await expect(offline.locator('.transit-departure').first()).toContainText('Saved schedule');
  await offline.getByRole('button', { name: 'Manage commutes' }).click();
  await expect(offline.getByRole('button', { name: 'Add commute', exact: true })).toBeDisabled();
  await offline.screenshot({ path: shot('transit-offline'), fullPage: true });
  await context.setOffline(false);
  await expect(offline.getByRole('button', { name: 'Add commute', exact: true })).toBeEnabled();
});

test('commute editor searches stops and persists buffers', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Manage commutes' }).click();
  await page.getByRole('button', { name: 'Add commute', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('ION to campus');
  await page.getByRole('textbox', { name: 'Boarding stop' }).fill('res');
  await page.getByRole('button', { name: /Residence.*ION/ }).click();
  await page.getByRole('textbox', { name: 'Destination stop' }).fill('camp');
  await page.getByRole('button', { name: /Campus.*ION/ }).click();
  await page.getByRole('spinbutton', { name: 'Walk to stop (min)' }).fill('7');
  await page.getByRole('button', { name: 'Save commute', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ION to campus' })).toBeVisible();
  await page.screenshot({ path: shot('transit-settings'), fullPage: true });
});

test('service-worker navigation reaches online authentication instead of the cached shell', async ({ page, request }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await request.get('/__test/expire');
  await page.reload();
  await expect(page.getByText('Test sign-in page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transit', exact: true })).toHaveCount(0);
});
