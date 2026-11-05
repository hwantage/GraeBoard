import type { Locator, Page } from "@playwright/test";

// 글자 색상·배경색은 팔레트 팝업에서 고른다. 팔레트에 있는 색은 그 버튼을
// 누르고, 없는 색은 HEX 입력 후 확인한다.
export async function pickColor(
  scope: Page | Locator,
  label: string,
  color: string,
) {
  const page = "page" in scope ? scope.page() : scope;
  await scope.getByRole("button", { name: label, exact: true }).click();
  const popup = page.getByRole("dialog", { name: label, exact: true });
  const swatch = popup.getByRole("button", { name: color, exact: true });
  if (await swatch.count()) return swatch.click();
  await popup.getByRole("button", { name: "다른 색", exact: true }).click();
  const custom = popup.getByRole("textbox", { name: "HEX", exact: true });
  await custom.fill(color);
  await custom.press("Enter");
}
