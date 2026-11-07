import { expect, type Page } from "@playwright/test";

// Assess settled contrast; an entrance or palette transition can produce
// intermediate colours. Loading/Undo animations must not delay the scan.
export async function settleAppearance(page: Page) {
  await expect(page.locator("html")).not.toHaveClass(/theme-crossfade/);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity &&
      !(animation instanceof CSSAnimation && animation.animationName === "undo-window"),
  ).length)).toBe(0);
}
