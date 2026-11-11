import { printFontFaces, printPage } from "../platform/browser-print";
import reportStyle from "./insights.css?inline";
import printStyle from "./insights-print.css?inline";
import type { InsightsPeriod } from "./insights-types";

// A rendering boundary, independent of how a report is selected/stored. The
// live report already contains the current aggregates and local chart choices.
// Capture synchronously, before any font/resource wait or realtime update.
export type InsightsReportInput = {
  title: string;
  teamName: string;
  annualView: string;
  period: InsightsPeriod;
  filters: string[];
  content: HTMLElement;
};

export function captureInsightsReport(input: InsightsReportInput) {
  if (input.content.querySelector('[role="alert"]'))
    throw new Error("차트 설정을 확인한 뒤 다시 내려받으세요.");
  const content = input.content.cloneNode(true) as HTMLElement;
  content.removeAttribute("id");
  content.className = "insights-report-content";
  for (const template of content.querySelectorAll<HTMLTemplateElement>(
    "template.insights-print-data",
  )) {
    if (!template.content.childElementCount)
      throw new Error("보고서 수치가 준비되지 않았습니다. 다시 시도하세요.");
    const table = document.createElement("div");
    table.className = "insights-print-data";
    table.append(template.content.cloneNode(true));
    template.replaceWith(table);
  }
  content
    .querySelectorAll(
      "[data-report-omit], .insights-card-actions, .insights-people-selection, .insights-chart-drop-slot",
    )
    .forEach((node) => node.remove());
  const originalSelects = [...input.content.querySelectorAll("select")];
  for (const [index, select] of [
    ...content.querySelectorAll("select"),
  ].entries()) {
    // cloneNode does not preserve a select's live selectedIndex.
    const original = originalSelects[index];
    const text = document.createElement("span");
    text.textContent = original?.selectedOptions[0]?.textContent || "";
    select.replaceWith(text);
  }
  for (const button of content.querySelectorAll("button")) {
    if (button.getAttribute("aria-pressed") === "false") {
      button.remove();
      continue;
    }
    const text = document.createElement("span");
    text.className = button.className;
    text.append(...button.childNodes);
    button.replaceWith(text);
  }
  content
    .querySelectorAll("input, textarea, script")
    .forEach((node) => node.remove());
  // Prevent scroll/sticky/viewport constraints from hiding report rows/columns.
  splitMatrices(content);
  splitTallCharts(content);
  groupChartHeadings(content);
  for (const node of content.querySelectorAll("*")) {
    for (const name of node.getAttributeNames())
      if (
        name.startsWith("data-") ||
        name.startsWith("on") ||
        [
          "tabindex",
          "draggable",
          "aria-haspopup",
          "aria-expanded",
          "data-tooltip",
        ].includes(name)
      )
        node.removeAttribute(name);
    if (node.getAttribute("role") === "button") node.removeAttribute("role");
  }
  const header = document.createElement("header");
  header.className = "insights-report-header";
  const line = (tag: string, text: string) => {
    const node = document.createElement(tag);
    node.textContent = text;
    header.append(node);
  };
  line("p", input.teamName);
  line("h1", input.title);
  line("p", `연간 보기: ${input.annualView}`);
  line(
    "p",
    `선택 표시 월: ${input.period.from} ~ ${input.period.to} · 선택 ${input.period.weeks?.length || 0}주`,
  );
  line("p", `속성 필터: ${input.filters.join(" / ") || "전체"}`);
  line(
    "p",
    `생성: ${new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date())} (한국 시간)`,
  );
  line(
    "p",
    "작업 주 합은 선택한 주차만, 업무 기간·상태·목표일은 불러온 업무 전체 작업 주를 기준으로 합니다.",
  );
  const weeks = document.createElement("p");
  weeks.className = "insights-report-weeks";
  weeks.textContent = `선택 주차 (시작일 / 연간 표시 월): ${input.period.weeks?.map((week) => `${week.key} / ${week.year}-${String(week.month).padStart(2, "0")}`).join(", ") || "없음"}`;
  header.append(weeks);
  const page = document.implementation.createHTMLDocument(input.title);
  page.documentElement.lang = "ko";
  const charset = page.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  page.head.prepend(charset);
  const style = page.createElement("style");
  style.textContent = `${printFontFaces(/Pretendard|Noto Sans KR|Nanum Gothic Coding/i)}\n${reportStyle}\n${printStyle}`;
  page.head.append(style);
  const computed = getComputedStyle(input.content);
  for (const key of [
    "--ink",
    "--muted",
    "--line",
    "--accent",
    "--accent-surface",
    "--accent-soft",
    "--accent-border",
    "--accent-strong",
  ])
    page.body.style.setProperty(key, computed.getPropertyValue(key));
  page.body.style.fontFamily = computed.fontFamily;
  const main = page.createElement("main");
  main.append(header, content);
  page.body.append(main);
  return {
    title: input.title,
    html: `<!doctype html>\n${page.documentElement.outerHTML}`,
  };
}

export async function exportInsightsReport(
  input: InsightsReportInput,
  signal: AbortSignal,
) {
  const snapshot = captureInsightsReport(input);
  await printPage(snapshot.html, snapshot.title, {
    frameClass: "insights-print-frame",
    landscape: true,
    signal,
  });
}

function splitMatrices(content: HTMLElement) {
  for (const table of content.querySelectorAll<HTMLTableElement>(
    "table.insights-matrix",
  )) {
    const header = table.tHead!;
    const groups = [...header.rows[0].cells].slice(1);
    const chunks: HTMLTableCellElement[][] = [];
    for (const group of groups) {
      const last = chunks[chunks.length - 1];
      if (
        !last ||
        last.reduce((sum, cell) => sum + cell.colSpan, 0) + group.colSpan > 8
      )
        chunks.push([group]);
      else last.push(group);
    }
    if (chunks.length < 2) continue;
    let start = 0;
    chunks.forEach((chunk, index) => {
      const copy = table.cloneNode(false) as HTMLTableElement;
      // Chromium may split a native table-caption away from its table.
      // A keep-with-next heading also names this column group's table.
      const caption = document.createElement("h4");
      caption.className = "insights-print-matrix-caption";
      const label = `${table.getAttribute("aria-label")} · 열 묶음 ${index + 1}/${chunks.length}`;
      caption.textContent = label;
      copy.setAttribute("aria-label", label);
      const head = copy.createTHead();
      const first = head.insertRow();
      first.append(
        header.rows[0].cells[0].cloneNode(true),
        ...chunk.map((cell) => cell.cloneNode(true)),
      );
      const length = chunk.reduce((sum, cell) => sum + cell.colSpan, 0);
      if (header.rows[1]) {
        const row = head.insertRow();
        row.append(
          ...[...header.rows[1].cells]
            .slice(start, start + length)
            .map((cell) => cell.cloneNode(true)),
        );
      }
      for (const section of [
        ...table.tBodies,
        ...(table.tFoot ? [table.tFoot] : []),
      ]) {
        const target =
          section === table.tFoot ? copy.createTFoot() : copy.createTBody();
        for (const row of section.rows) {
          const next = target.insertRow();
          next.append(
            row.cells[0].cloneNode(true),
            ...[...row.cells]
              .slice(start + 1, start + length + 1)
              .map((cell) => cell.cloneNode(true)),
          );
        }
      }
      table.before(caption, copy);
      start += length;
    });
    table.remove();
  }
}

function splitTallCharts(content: HTMLElement) {
  for (const svg of content.querySelectorAll<SVGSVGElement>(
    "svg.insights-bars",
  )) {
    const { width, height } = svg.viewBox.baseVal;
    if (height <= 500) continue;
    const positions = [
      ...new Set(
        [...svg.querySelectorAll(".insights-axis-label")].map((node) =>
          Number(node.getAttribute("y")),
        ),
      ),
    ].sort((a, b) => a - b);
    if (positions.length < 2) continue;
    const cuts = positions
      .slice(1)
      .map((y, index) => (y + positions[index]) / 2);
    const boundaries = [0];
    const maxHeight = (420 * width) / 1000;
    for (let index = 0; index < cuts.length; index++)
      if (
        (cuts[index + 1] || height) - boundaries[boundaries.length - 1] >
        maxHeight
      )
        boundaries.push(cuts[index]);
    boundaries.push(height);
    for (let index = 0; index < boundaries.length - 1; index++) {
      const figure = document.createElement("figure");
      const copy = svg.cloneNode(true) as SVGSVGElement;
      copy.setAttribute(
        "viewBox",
        `0 ${boundaries[index]} ${width} ${boundaries[index + 1] - boundaries[index]}`,
      );
      copy.setAttribute(
        "height",
        String(boundaries[index + 1] - boundaries[index]),
      );
      const caption = document.createElement("figcaption");
      caption.textContent = `${svg.getAttribute("aria-label")} · 그래프 ${index + 1}/${boundaries.length - 1}`;
      figure.append(caption, copy);
      svg.before(figure);
    }
    svg.remove();
  }
}

function groupChartHeadings(content: HTMLElement) {
  for (const card of content.querySelectorAll<HTMLElement>(".insights-card")) {
    const plot = [...card.children].find((child) =>
      child.matches(".insights-chart-scroll, .insights-radar-scroll"),
    );
    if (!plot?.querySelector("svg")) continue;
    const slices = [...plot.children].filter(
      (child) => child.tagName === "FIGURE",
    );
    let end: Element = plot;
    if (slices.length > 1) {
      plot.replaceWith(...slices);
      end = slices[0];
    } else {
      while (
        end.nextElementSibling &&
        !end.nextElementSibling.matches(".insights-print-data")
      )
        end = end.nextElementSibling;
    }
    const group = document.createElement("div");
    group.className = "insights-report-chart-figure";
    const nodes = [...card.childNodes];
    for (const node of nodes.slice(0, nodes.indexOf(end) + 1))
      group.append(node);
    card.prepend(group);
  }
}
