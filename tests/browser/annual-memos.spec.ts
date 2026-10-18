import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { unpack } from "../../shared/compact.js";

const headers = { "X-Requested-With": "WeeklyPlan" };
test("연간 메모는 필요할 때 열고 저장 후 닫으며 800px 문서를 가로로 편집한다", async ({
  page,
}, info) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  const team = unpack(
    await (
      await page.request.post("/api/admin/teams", {
        headers,
        data: {
          name: `메모 ${randomUUID().slice(0, 8)}`,
          members: [{ userId: boot.user.id, role: "lead" }],
        },
      })
    ).json(),
  );
  const task = unpack(
    await (
      await page.request.post("/api/tasks", {
        headers,
        data: {
          teamId: team.id,
          year: 2026,
          fields: { title: "메모와 함께 편집할 업무" },
        },
      })
    ).json(),
  ).task;
  const memoRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/years\/\d+\/memos(?:\/|$)/.test(new URL(request.url()).pathname))
      memoRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(team.id);
  const memos = page.getByRole("region", { name: "연간 업무 메모 목록" });
  const rail = memos.locator(".memo-documents");
  const card = (name: string) =>
    memos.getByRole("tabpanel", { name, exact: true });
  const source = (name: string) =>
    card(name).getByRole("textbox", { name: "연간 업무 메모 Markdown 원문" });
  const rich = (name: string) =>
    card(name).getByRole("textbox", { name: "연간 업무 메모 리치 편집" });
  const tab = (name: string) => memos.getByRole("tab", { name, exact: true });
  const openMemos = async () => {
    const toggle = memos.getByRole("button", {
      name: "메모 열기",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(
      memos.getByRole("button", { name: "메모 닫기", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
  };
  const toggle = memos.locator(".toggle-memos");
  const plus = memos.locator(".memo-add-document");
  await expect(page.locator(`[data-cell="${task.id}:title"]`)).toBeVisible();
  await expect(toggle).toHaveText("메모 열기");
  await expect(rail).toHaveCount(0);
  expect(memoRequests).toHaveLength(0);
  expect((await toggle.boundingBox())!.x).toBeGreaterThan(
    (await memos
      .getByRole("button", { name: "업무 추가", exact: true })
      .boundingBox())!.x,
  );
  await openMemos();
  await expect(memos.getByRole("tab")).toHaveCount(0);
  await plus.click();
  await expect(rich("메모 1")).toBeVisible();
  expect((await card("메모 1").boundingBox())!.width).toBeCloseTo(800, 0);
  const titleLine = (await card("메모 1")
    .locator(".memo-document-heading")
    .boundingBox())!;
  const modes = (await card("메모 1")
    .getByRole("group", { name: "문서 편집 모드" })
    .boundingBox())!;
  const body = (await card("메모 1")
    .locator(".memo-document-body")
    .boundingBox())!;
  expect(titleLine.y + titleLine.height).toBeLessThan(body.y);
  expect(modes.y + modes.height).toBeLessThan(body.y);

  await card("메모 1")
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await page.locator(`[data-cell="${task.id}:title"]`).click();
  await source("메모 1").focus();
  expect(
    await source("메모 1").evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "메모 본문");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);
  await source("메모 1").fill("# 첫 번째 메모\n\n- [x] 저장 확인");
  await plus.click();
  await expect(rich("메모 2")).toBeVisible();
  await expect(memos.getByRole("tabpanel")).toHaveCount(2);
  await expect(card("메모 1")).not.toHaveAttribute("hidden");
  await card("메모 2")
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await source("메모 2").fill("# 두 번째 메모");
  await tab("메모 1").click();
  await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeLessThan(1);
  await expect(source("메모 1")).toHaveValue(
    "# 첫 번째 메모\n\n- [x] 저장 확인",
  );
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await tab("메모 1").click();
    expect((await card("메모 1").boundingBox())!.width).toBeLessThanOrEqual(
      800,
    );
    await memos.screenshot({
      path: info.outputPath(`annual-memo-cards-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await plus.click();
  await expect(rich("메모 3")).toBeVisible();
  await expect
    .poll(() => rail.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(600);
  await tab("메모 1").click();
  await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeLessThan(1);
  await rail.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect
    .poll(() => rail.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(600);
  await tab("메모 1").click();
  await tab("메모 1").press("ArrowRight");
  await expect(tab("메모 2")).toHaveAttribute("aria-selected", "true");
  await tab("메모 1").dblclick();
  await memos
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .fill("연간 회의록");
  await memos
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .press("Enter");
  await expect(card("연간 회의록").locator(".memo-document-title")).toHaveText(
    "연간 회의록",
  );
  await source("연간 회의록").fill("# 전환 직전 저장");
  await memos.getByRole("button", { name: "메모 닫기", exact: true }).click();
  await expect(rail).toHaveCount(0);
  const savedList = unpack(
    await (
      await page.request.get(`/api/teams/${team.id}/years/2026/memos`)
    ).json(),
  );
  expect(savedList.documents).toHaveLength(3);
  const savedId = savedList.documents.find(
    (doc: { title: string }) => doc.title === "연간 회의록",
  ).id;
  const saved = unpack(
    await (
      await page.request.get(
        `/api/teams/${team.id}/years/2026/memos/${savedId}`,
      )
    ).json(),
  );
  expect(saved.markdown).toBe("# 전환 직전 저장");
  await openMemos();
  await expect(rich("연간 회의록")).toContainText("전환 직전 저장");
  await expect(memos.getByRole("tab")).toHaveCount(3);
  await page.getByLabel("팀 선택").selectOption(boot.teams[0].id);
  await expect(memos.getByRole("tab")).toHaveCount(0);
  await page.getByLabel("팀 선택").selectOption(team.id);
  await openMemos();
  await expect(rich("연간 회의록")).toContainText("전환 직전 저장");
  await expect(rich("메모 2")).toContainText("두 번째 메모");
  await page.getByRole("button", { name: "다음 연도", exact: true }).click();
  await expect(memos.getByRole("tab")).toHaveCount(0);
  await page.getByRole("button", { name: "이전 연도", exact: true }).click();
  await openMemos();
  await expect(tab("연간 회의록")).toBeVisible();
  await page.reload();
  await expect(rail).toHaveCount(0);
  await openMemos();
  await expect(rich("연간 회의록")).toContainText("전환 직전 저장");
  await card("연간 회의록")
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await source("연간 회의록").fill(
    "# 긴 메모\n\n" +
      Array.from({ length: 30 }, (_, index) => `문단 ${index + 1}`).join(
        "\n\n",
      ),
  );
  await card("연간 회의록")
    .getByRole("button", { name: "리치 문서", exact: true })
    .click();
  await expect(rich("연간 회의록")).toContainText("문단 30");
  await rich("연간 회의록").locator("p").last().scrollIntoViewIfNeeded();
  const heading = (await card("연간 회의록")
    .locator(".memo-document-heading")
    .boundingBox())!;
  const tools = (await card("연간 회의록")
    .locator(".document-rich-tools")
    .boundingBox())!;
  expect(tools.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
  const documentBody = card("연간 회의록").locator(".memo-document-body");
  expect(
    await documentBody.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  const bodyBox = (await documentBody.boundingBox())!;
  expect(heading.y + heading.height).toBeLessThan(bodyBox.y);
  for (const name of ["메모 3", "메모 2", "연간 회의록"]) {
    await tab(name).click();
    await memos.getByRole("button", { name: "문서 메뉴", exact: true }).click();
    await memos
      .getByRole("menuitem", { name: "문서 삭제", exact: true })
      .click();
    await memos.getByRole("button", { name: "문서 삭제", exact: true }).click();
    await expect(tab(name)).toHaveCount(0);
  }
  await expect(memos.getByRole("tabpanel")).toHaveCount(0);
  await plus.click();
  await expect(rich("메모 1")).toBeVisible();
  await page.reload();
  await expect(rail).toHaveCount(0);
  await openMemos();
  await expect(rich("메모 1")).toBeVisible();
});

test("메모 탭 드래그·취소·키보드 이동은 문서 배치와 저장된 순서를 함께 바꾼다", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  const team = unpack(
    await (
      await page.request.post("/api/admin/teams", {
        headers,
        data: {
          name: `메모 정렬 ${randomUUID().slice(0, 8)}`,
          members: [{ userId: boot.user.id, role: "lead" }],
        },
      })
    ).json(),
  );
  const base = `/api/teams/${team.id}/years/2026/memos`;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids)
    await page.request.post(base, { headers, data: { id } });
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(team.id);
  const memos = page.getByRole("region", { name: "연간 업무 메모 목록" });
  const open = async () =>
    memos.getByRole("button", { name: "메모 열기", exact: true }).click();
  await expect(page.locator('[role="grid"]')).toHaveAttribute(
    "aria-rowcount",
    "1",
  );
  await open();
  const tabs = memos.getByRole("tab");
  const titles = memos.locator(".memo-document-title");
  const tab = (name: string) => memos.getByRole("tab", { name, exact: true });
  const first = memos.getByRole("tabpanel", { name: "메모 1", exact: true });
  await expect(
    first.getByRole("textbox", { name: "연간 업무 메모 리치 편집" }),
  ).toBeVisible();
  await first
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  const source = first.getByRole("textbox", {
    name: "연간 업무 메모 Markdown 원문",
  });
  await source.fill("# 드래그 직전 입력");
  const drag = async (name: string, target: string, cancel = false) => {
    const from = (await tab(name).boundingBox())!;
    const to = (await tab(target).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 3, to.y + to.height / 2, { steps: 8 });
    await expect(memos.locator('[data-reordering="true"]')).toHaveCount(1);
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
  };
  await drag("메모 3", "메모 1", true);
  await expect(tabs).toHaveText(["메모 1", "메모 2", "메모 3"]);
  await expect(titles).toHaveText(["메모 1", "메모 2", "메모 3"]);
  await drag("메모 3", "메모 1");
  await expect(tabs).toHaveText(["메모 3", "메모 1", "메모 2"]);
  await expect(titles).toHaveText(["메모 3", "메모 1", "메모 2"]);
  await expect(source).toHaveValue("# 드래그 직전 입력");
  const saved = unpack(
    await (await page.request.get(`${base}/${ids[0]}`)).json(),
  );
  expect(saved.markdown).toBe("# 드래그 직전 입력");
  await memos.getByRole("button", { name: "메모 닫기", exact: true }).click();
  await open();
  await expect(tabs).toHaveText(["메모 3", "메모 1", "메모 2"]);
  await tab("메모 3").press("Alt+ArrowRight");
  await expect(tabs).toHaveText(["메모 1", "메모 3", "메모 2"]);
  await expect(titles).toHaveText(["메모 1", "메모 3", "메모 2"]);
  await page.route(`**/teams/${team.id}/years/2026/memos/reorder`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "순서 저장 실패" }),
    }),
  );
  await tab("메모 3").press("Alt+ArrowLeft");
  await expect(memos.getByRole("alert")).toContainText("순서 저장 실패");
  await expect(tabs).toHaveText(["메모 1", "메모 3", "메모 2"]);
  await page.unroute(`**/teams/${team.id}/years/2026/memos/reorder`);
  await tab("메모 3").press("Alt+ArrowLeft");
  await expect(tabs).toHaveText(["메모 3", "메모 1", "메모 2"]);
  await page.reload();
  await open();
  await expect(tabs).toHaveText(["메모 3", "메모 1", "메모 2"]);
  await expect(titles).toHaveText(["메모 3", "메모 1", "메모 2"]);
  for (let index = 4; index <= 12; index++) {
    await page.request.post(base, {
      headers,
      data: { id: randomUUID(), title: `가로 스크롤 확인용 긴 메모 ${index}` },
    });
  }
  await memos.getByRole("button", { name: "메모 닫기", exact: true }).click();
  await open();
  await expect(tabs).toHaveCount(12);
  const orderBeforeScroll = await tabs.allTextContents();
  const tabScroll = memos.getByRole("tablist");
  const scrollBox = (await tabScroll.boundingBox())!;
  const from = (await tab("메모 3").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    scrollBox.x + scrollBox.width - 3,
    scrollBox.y + scrollBox.height / 2,
    { steps: 12 },
  );
  await expect
    .poll(() => tabScroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(80);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(tabs).toHaveText(orderBeforeScroll);
});

test("접힌 메모도 사본에 포함하고 사본 재복사 직전 입력을 저장하며 원본과 독립적으로 편집한다", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  const team = unpack(
    await (
      await page.request.post("/api/admin/teams", {
        headers,
        data: {
          name: `사본 메모 ${randomUUID().slice(0, 8)}`,
          members: [{ userId: boot.user.id, role: "lead" }],
        },
      })
    ).json(),
  );
  const task = unpack(
    await (
      await page.request.post("/api/tasks", {
        headers,
        data: {
          teamId: team.id,
          year: 2026,
          fields: { title: "메모 포함 사본 업무" },
        },
      })
    ).json(),
  ).task;
  const base = `/api/teams/${team.id}/years/2026/memos`;
  const a = randomUUID(),
    b = randomUUID();
  await page.request.post(base, { headers, data: { id: a } });
  await page.request.post(base, { headers, data: { id: b } });
  await page.request.put(`${base}/${a}`, {
    headers,
    data: {
      markdown: "# 원본의 회의 기록",
      expectedRevision: 0,
      operationId: randomUUID(),
    },
  });
  await page.request.post(`${base}/reorder`, {
    headers,
    data: { ids: [b, a], expectedIds: [a, b] },
  });
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(team.id);
  await expect(page.locator(`[data-cell="${task.id}:title"]`)).toBeVisible();
  const memos = page.getByRole("region", { name: "연간 업무 메모 목록" });
  const sheets = page.getByRole("tablist", {
    name: "원본과 사본",
    exact: true,
  });
  const open = async () =>
    memos.getByRole("button", { name: "메모 열기", exact: true }).click();
  const card = (name: string) =>
    memos.getByRole("tabpanel", { name, exact: true });
  const rich = (name: string) =>
    card(name).getByRole("textbox", { name: "연간 업무 메모 리치 편집" });
  const source = (name: string) =>
    card(name).getByRole("textbox", { name: "연간 업무 메모 Markdown 원문" });
  const createCopy = async (name: string) => {
    await page.getByRole("button", { name: "사본 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "사본 만들기",
      exact: true,
    });
    await dialog.getByRole("textbox", { name: "사본 이름" }).fill(name);
    await dialog.getByRole("button", { name: "확인", exact: true }).click();
    await expect(
      sheets.getByRole("tab", { name, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      memos.getByRole("button", { name: "메모 열기", exact: true }),
    ).toBeVisible();
  };
  await expect(memos.getByRole("tabpanel")).toHaveCount(0);
  await createCopy("메모 포함 사본");
  await open();
  await expect(memos.getByRole("tab")).toHaveText(["메모 2", "메모 1"]);
  await expect(rich("메모 1")).toContainText("원본의 회의 기록");
  await memos.getByRole("tab", { name: "메모 1", exact: true }).dblclick();
  await memos
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .fill("사본 회의록");
  await memos
    .getByRole("textbox", { name: "문서 제목", exact: true })
    .press("Enter");
  await memos
    .getByRole("tab", { name: "사본 회의록", exact: true })
    .press("Alt+ArrowLeft");
  await expect(memos.getByRole("tab")).toHaveText(["사본 회의록", "메모 2"]);
  await card("사본 회의록")
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await source("사본 회의록").fill("# 사본 재복사 직전 입력");
  await createCopy("메모 재사본");
  await open();
  await expect(memos.getByRole("tab")).toHaveText(["사본 회의록", "메모 2"]);
  await expect(rich("사본 회의록")).toContainText("사본 재복사 직전 입력");
  await card("사본 회의록")
    .getByRole("button", { name: "Markdown 원문", exact: true })
    .click();
  await source("사본 회의록").fill("# 재사본에서만 변경");
  await sheets
    .getByRole("tab", { name: "메모 포함 사본", exact: true })
    .click();
  await open();
  await expect(rich("사본 회의록")).toContainText("사본 재복사 직전 입력");
  await sheets.getByRole("tab", { name: "원본", exact: true }).click();
  await open();
  await expect(memos.getByRole("tab")).toHaveText(["메모 2", "메모 1"]);
  await expect(rich("메모 1")).toContainText("원본의 회의 기록");
  await page.reload();
  await sheets.getByRole("tab", { name: "메모 재사본", exact: true }).click();
  await open();
  await expect(rich("사본 회의록")).toContainText("재사본에서만 변경");
});

test("메모를 열 때 빈 상태의 버튼 위치를 유지하고 문서가 있으면 표 맨 아래로 이동한다", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { username: "test@somansa.com", password: "1234" },
  });
  const boot = unpack(await (await page.request.get("/api/bootstrap")).json());
  const team = unpack(
    await (
      await page.request.post("/api/admin/teams", {
        headers,
        data: {
          name: `빈 메모 위치 ${randomUUID().slice(0, 8)}`,
          members: [{ userId: boot.user.id, role: "lead" }],
        },
      })
    ).json(),
  );
  await Promise.all(
    Array.from({ length: 35 }, (_, index) =>
      page.request.post("/api/tasks", {
        headers,
        data: {
          teamId: team.id,
          year: 2026,
          fields: { title: `스크롤 확인 업무 ${index + 1}` },
        },
      }),
    ),
  );
  await page.goto("/");
  await page.getByLabel("팀 선택").selectOption(team.id);
  await expect(page.locator('[data-column="title"]')).not.toHaveCount(0);
  const memos = page.getByRole("region", { name: "연간 업무 메모 목록" });
  const toggle = memos.locator(".toggle-memos");
  const grid = page.locator(".sheet-scroll");
  await page.evaluate(() => document.fonts.ready);
  const measure = () =>
    toggle.evaluate(async (button) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const box = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const text = [...button.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      )!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const label = range.getBoundingClientRect();
      const scroll = button.closest(".sheet-scroll")!;
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        iconX: icon.x,
        iconY: icon.y,
        labelX: label.x,
        labelY: label.y,
        scrollTop: scroll.scrollTop,
        scrollLeft: scroll.scrollLeft,
      };
    });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() =>
        grid.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThan(1);
    const before = await measure();
    for (let index = 0; index < 6; index++) {
      await page.mouse.click(
        before.x + before.width / 2,
        before.y + before.height / 2,
      );
      const opened = index % 2 === 0;
      await expect(toggle).toHaveAttribute("aria-expanded", String(opened));
      if (opened)
        await expect(memos.locator(".memo-add-document")).toBeEnabled();
      await expect(memos.getByRole("tabpanel")).toHaveCount(0);
      const after = await measure();
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        expect(
          Math.abs(after[key] - before[key]),
          `${width}px ${index} ${key}`,
        ).toBeLessThan(0.1);
      }
      const lineVisible = await memos
        .locator(".document-tabs")
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            style.borderBottomStyle !== "none" &&
            parseFloat(style.borderBottomWidth) > 0 &&
            style.borderBottomColor !== "rgba(0, 0, 0, 0)"
          );
        });
      expect(lineVisible).toBe(opened);
    }
  }
  const memoPath = `/api/teams/${team.id}/years/2026/memos`;
  await page.request.post(memoPath, {
    headers,
    data: { id: randomUUID(), title: "하단 문서" },
  });
  await page.route(`**${memoPath}`, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ response });
  });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (let index = 0; index < 2; index++) {
      await grid.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await toggle.click();
      const memo = memos.getByRole("tabpanel", { name: "하단 문서" });
      await expect(memo).toBeVisible();
      await expect
        .poll(() =>
          grid.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(1);
      expect(
        await memo.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const scroll = element
            .closest(".sheet-scroll")!
            .getBoundingClientRect();
          return box.top >= scroll.top && box.bottom <= scroll.bottom;
        }),
      ).toBe(true);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
  }
});
