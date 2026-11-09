import { expect, type Page } from "@playwright/test";

// Exercise the actual shared PeriodPicker keyboard/selection path.
export async function selectMonths(
  page: Page,
  year: number,
  first: number,
  last = first,
) {
  const start = page.locator(
    `.period-month[data-year="${year}"][data-month="${first}"]`,
  );
  await expect(start).toBeEnabled();
  await start.focus();
  await start.press("Enter");
  for (let month = first; month < last; month++)
    await page.keyboard.press("Shift+ArrowRight");
  await expect(start).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page
        .locator('.period-month[aria-pressed="true"]')
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              `${(node as HTMLElement).dataset.year}-${(node as HTMLElement).dataset.month}`,
          ),
        ),
    )
    .toEqual(
      Array.from(
        { length: last - first + 1 },
        (_, i) => `${year}-${first + i}`,
      ),
    );
  await expect(page.locator('.period-month[aria-pressed="mixed"]')).toHaveCount(
    0,
  );
}

export async function moveCalendarMonths(page: Page, count: number) {
  for (let index = 0; index < Math.abs(count); index++)
    await page
      .getByRole("button", {
        name: count < 0 ? "이전 달로 이동" : "다음 달로 이동",
        exact: true,
      })
      .click();
}
