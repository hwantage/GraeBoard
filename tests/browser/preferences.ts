import { unpack } from "../../shared/compact.js";
import { expect, type Page } from "@playwright/test";

// 화면은 별도로 저장한 배치와 필터 조건을 합쳐 표시한다.
export async function readPreferences(page: Page, teamId: string, year = 2026) {
  const [layoutResponse, filterResponse] = await Promise.all([
    page.request.get(`/api/views?teamId=${teamId}&year=${year}`),
    page.request.get(`/api/filters?teamId=${teamId}`),
  ]);
  expect(layoutResponse.ok()).toBeTruthy();
  expect(filterResponse.ok()).toBeTruthy();
  const { views } = await layoutResponse.json().then(unpack);
  const { filters, current } = await filterResponse.json().then(unpack);
  return {
    views: [
      ...views.map((v: any) => ({
        ...v,
        data: { ...v.data, ...current.data },
      })),
      ...filters,
    ],
  };
}

export async function writePreferences(
  page: Page,
  options: {
    headers?: Record<string, string>;
    data: { teamId: string; name: string; data: any };
  },
) {
  const { teamId, name, data } = options.data;
  const headers = { "X-Requested-With": "WeeklyPlan" };
  const { propertyFilters, propertyFilterModes, ...layout } = data;
  const filter = { propertyFilters, propertyFilterModes };
  if (name !== "__current")
    return page.request.put("/api/filters", {
      headers,
      data: { teamId, scope: "personal", name, data: filter },
    });
  if (propertyFilters !== undefined || propertyFilterModes !== undefined) {
    const state = await page.request.put("/api/filters/current", {
      headers,
      data: { teamId, selectedId: "", data: filter },
    });
    expect(state.ok(), await state.text()).toBeTruthy();
  }
  return page.request.put("/api/views", {
    headers,
    data: { teamId, name, data: layout },
  });
}
