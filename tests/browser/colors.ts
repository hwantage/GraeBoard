import type { Locator, Page } from "@playwright/test";

// 글자 색상·배경색은 팔레트 팝업에서 고른다. 팔레트에 있는 색은 그 버튼을
// 누르고, 없는 색은 "직접 선택" 입력에 넣은 뒤 팝업을 닫는다.
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
  const custom = popup.getByLabel(`${label} 직접 선택`, { exact: true });
  await custom.fill(color);
  await custom.press("Escape");
}
