import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Keyboard-navigation helpers for the a11y E2E specs.
 *
 * `tabTo` walks focus forward with Tab until the target is focused,
 * asserting keyboard *reachability* without pinning the exact tab
 * order (which legitimately shifts as surfaces evolve). The budget is
 * generous but finite so an unreachable control fails loudly instead
 * of spinning.
 */

export async function tabTo(
  page: Page,
  target: Locator,
  { maxTabs = 40 }: { maxTabs?: number } = {}
): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    if (await isFocused(target)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  // One final check so the failure message names the target.
  await expect(
    target,
    `target did not receive focus within ${maxTabs} Tab presses — it is not keyboard-reachable`
  ).toBeFocused();
}

async function isFocused(target: Locator): Promise<boolean> {
  try {
    return await target.evaluate(
      (el) => el === document.activeElement,
      undefined,
      { timeout: 250 }
    );
  } catch {
    return false;
  }
}
