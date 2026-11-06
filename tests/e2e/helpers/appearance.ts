import { expect, type Page } from "@playwright/test";

// Assess settled contrast; an entrance or palette transition can produce
// intermediate colours. Loading/Undo animations must not delay the scan.
export async function settleAppearance(page: Page) {
  await expect(page.locator("html")).not.toHaveClass(/theme-crossfade/);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    animation.playState === "running" && (
      animation instanceof CSSTransition ||
      (animation instanceof CSSAnimation && [
        "route-enter", "dialog-enter", "sheet-enter", "sheet-enter-phone",
        "popover-enter", "feedback-enter", "fade-in",
      ].includes(animation.animationName))
    ),
  ).length)).toBe(0);
}
