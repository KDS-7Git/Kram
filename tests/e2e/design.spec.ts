import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const theme of ['light','dark'] as const) {
  test(`Paper and Ink: ${theme}, keyboard and accessible controls`, async ({ page }, testInfo) => {
    await page.addInitScript(value => localStorage.setItem('kram-appearance',JSON.stringify({ theme:value, motion:'reduced' })),theme);
    await page.goto('/workshop');
    await expect(page.getByRole('heading',{ name:'Paper and Ink',exact:true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link',{ name:'Skip to content' })).toBeFocused();
    await page.getByRole('button',{ name:'Open details',exact:true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    expect(results.violations).toEqual([]);
    await expect(page).toHaveScreenshot(`workshop-${theme}.png`, { fullPage:true, animations:'disabled', maxDiffPixelRatio:.01 });
    await testInfo.attach(`workshop-${theme}`, { path:testInfo.snapshotPath(`workshop-${theme}.png`), contentType:'image/png' });
  });
}

test('Paper and Ink reflows at 320 pixels', async ({ page }) => {
  await page.setViewportSize({ width:320,height:720 });
  await page.goto('/workshop');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole('button',{ name:'Open details',exact:true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
