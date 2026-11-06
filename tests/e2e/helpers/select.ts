import { expect, type Locator } from "@playwright/test";

/** Exercise the visible chooser; keep genuinely native controls usable. */
export async function chooseOption(control: Locator, choice: string | { label: string }) {
  if (await control.evaluate(element => element.tagName === "SELECT")) {
    await control.selectOption(choice);
    return;
  }
  const triggerId = await control.getAttribute("id");
  const trigger = triggerId ? control.page().locator(`[id=${JSON.stringify(triggerId)}]`) : control;
  await control.click();
  const popupId = await trigger.getAttribute("aria-controls");
  expect(popupId, "A custom chooser exposes its popup to assistive technology").toBeTruthy();
  const popup = control.page().locator(`[id=${JSON.stringify(popupId)}]`);
  const options = popup.getByRole("option");
  await expect(options.first()).toBeVisible();
  if (typeof choice === "string") {
    const values = await options.evaluateAll(elements => elements.map(element => element.getAttribute("data-value")));
    const index = values.indexOf(choice);
    expect(index, `The chooser contains value ${choice}`).toBeGreaterThanOrEqual(0);
    await options.nth(index).click();
  } else {
    await popup.getByRole("option", { name: choice.label, exact: true }).click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(popup).toBeHidden();
}
