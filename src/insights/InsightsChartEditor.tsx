import { useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import Select from "../ui/Select";
import InsightsChart from "./InsightsChart";
import InsightsFilters from "./InsightsFilters";
import {
  chartTemplates,
  ownerCountDefinition,
  rankedOwners,
} from "./insights-chart-templates";
import {
  aggregate,
  numericProperties,
  VALUE_LABELS,
} from "../../shared/insights/insights.js";
import { insightChartSchema } from "../../shared/insights/insights-schema.js";
import { propertiesFor } from "../../shared/domain.js";
import type { Task } from "../types";
import type {
  InsightChart,
  InsightDimension,
  InsightValue,
  InsightsContext,
  TaskMetrics,
  ChartCell,
  ChartResult,
} from "./insights-types";

const TYPES = {
  number: "숫자 카드",
  bar: "막대",
  line: "꺾은선",
  pie: "파이",
  radar: "레이더",
  table: "표",
  top: "업무 목록 Top N",
};
export default function InsightsChartEditor({
  teamId,
  initial,
  tasks,
  ctx,
  canSave,
  onSave,
  onClose,
  onDrill,
  onTask,
}: {
  initial: InsightChart;
  teamId: string;
  tasks: Task[];
  ctx: InsightsContext;
  canSave: boolean;
  onSave: (chart: InsightChart) => Promise<void>;
  onClose: () => void;
  onDrill: (chart: InsightChart, cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const parsed = insightChartSchema.safeParse(draft);
  const radarOwners = useMemo(
    () =>
      rankedOwners(
        aggregate(tasks, { id: "cowners", ...ownerCountDefinition }, ctx),
      )
        .slice(0, 3)
        .map((owner) => owner.id),
    [tasks, ctx],
  );
  const result = useMemo<ChartResult | null>(
    () => (parsed.success ? aggregate(tasks, parsed.data, ctx) : null),
    [tasks, draft, ctx],
  );
  const dimensions: { label: string; value: InsightDimension }[] = [
    { label: "책임자", value: { kind: "owner" } },
    ...propertiesFor(ctx.settings, true)
      .filter((p) => p.kind === "option")
      .map((p) => ({
        label: p.name + (p.archived ? " (보관된 속성)" : ""),
        value: { kind: "property" as const, propertyId: p.id },
      })),
    ...(["week", "month", "quarter"] as const).flatMap((unit) =>
      (["work", "start", "end"] as const).map((basis) => ({
        label: `${{ work: "작업한", start: "착수", end: "완료" }[basis]} ${{ week: "주", month: "월", quarter: "분기" }[unit]}`,
        value: { kind: "time" as const, unit, basis },
      })),
    ),
    { label: "목표일 상태", value: { kind: "deadlineState" } },
    { label: "진행 상태", value: { kind: "progressState" } },
    { label: "업무 기간 구간", value: { kind: "durationBand" } },
  ];
  const numeric = numericProperties(
    (result?.metrics || []).map((metric) => metric.task),
    ctx.settings,
  );
  const values: { label: string; value: InsightValue }[] = [
    ...Object.entries(VALUE_LABELS)
      .filter(([kind]) => !kind.startsWith("number"))
      .map(([kind, label]) => ({ label, value: { kind } as InsightValue })),
    ...numeric.flatMap((p) =>
      (["numberSum", "numberAvg", "numberMax"] as const).map((kind) => ({
        label: `${p.name} · ${VALUE_LABELS[kind]}`,
        value: { kind, propertyId: p.id },
      })),
    ),
  ];
  const dimensionSelect = (
    slot: "axis" | "series" | "row" | "column",
    label: string,
    optional = false,
  ) => {
    const current = draft.dimensions[slot],
      encoded = current ? JSON.stringify(current) : "";
    return (
      <label key={slot}>
        {label}
        <Select
          aria-label={label}
          value={encoded}
          onChange={(event) => {
            const next = { ...draft.dimensions };
            if (event.target.value) next[slot] = JSON.parse(event.target.value);
            else delete next[slot];
            setDraft({ ...draft, dimensions: next });
          }}
        >
          {optional && <option value="">없음</option>}
          {dimensions
            .filter((d) =>
              draft.type === "line" && slot === "axis"
                ? d.value.kind === "time"
                : draft.type === "pie"
                  ? d.value.kind !== "time"
                  : true,
            )
            .map((d) => (
              <option
                key={JSON.stringify(d.value)}
                value={JSON.stringify(d.value)}
              >
                {d.label}
              </option>
            ))}
          {current &&
            !dimensions.some((d) => JSON.stringify(d.value) === encoded) && (
              <option value={encoded}>
                없는 속성:{" "}
                {"propertyId" in current ? current.propertyId : current.kind}
              </option>
            )}
        </Select>
      </label>
    );
  };
  function changeType(type: InsightChart["type"]) {
    const { sort, limit, ...base } = draft;
    setDraft({
      ...base,
      type,
      dimensions:
        type === "line"
          ? { axis: { kind: "time", unit: "month", basis: "work" } }
          : type === "pie"
            ? {
                axis: dimensions.find((d) => d.value.kind === "property")
                  ?.value || { kind: "owner" },
              }
            : type === "bar"
              ? { axis: { kind: "owner" } }
              : type === "radar"
                ? {
                    axis: dimensions.find((d) => d.value.kind === "property")
                      ?.value || { kind: "durationBand" },
                    series: { kind: "owner" },
                  }
                : type === "table"
                  ? { row: { kind: "owner" } }
                  : {},
      values:
        type === "table"
          ? draft.values
          : type === "pie"
            ? [{ kind: "count" }]
            : [draft.values[0]],
      display: { percent: "value" },
      ...(type === "top"
        ? { sort: { kind: "duration" as const }, limit: 10 }
        : {}),
    });
  }
  const validation = !parsed.success
    ? parsed.error.issues[0].message
    : result?.errors.join(" ") || "";
  return (
    <Modal
      title={canSave ? "차트 편집" : "차트 미리보기"}
      wide
      className="insights-editor"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="insights-editor-layout">
        <fieldset disabled={busy} className="insights-editor-controls">
          <div
            className="insights-quick-start"
            role="group"
            aria-label="차트 빠른 시작"
          >
            <span>빠른 시작</span>
            {chartTemplates(ctx.settings, radarOwners).map((template) => (
              <Button
                key={template.label}
                onClick={() =>
                  setDraft({
                    ...template.chart,
                    id: draft.id,
                    ...(draft.filter || template.chart.filter
                      ? {
                          filter: {
                            ...draft.filter,
                            ...template.chart.filter,
                            propertyFilters: {
                              ...draft.filter?.propertyFilters,
                              ...template.chart.filter?.propertyFilters,
                            },
                            propertyFilterModes: {
                              ...draft.filter?.propertyFilterModes,
                              ...template.chart.filter?.propertyFilterModes,
                            },
                          },
                        }
                      : {}),
                  })
                }
              >
                {template.label}
              </Button>
            ))}
          </div>
          <label>
            제목
            <input
              aria-label="차트 제목"
              value={draft.title}
              maxLength={80}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            종류
            <Select
              aria-label="차트 종류"
              value={draft.type}
              onChange={(event) =>
                changeType(event.target.value as InsightChart["type"])
              }
            >
              {Object.entries(TYPES).map(([type, label]) => (
                <option key={type} value={type}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          {(draft.type === "bar" || draft.type === "line") && (
            <>
              {dimensionSelect("axis", "X 기준")}
              {dimensionSelect("series", "나누기", true)}
            </>
          )}
          {draft.type === "pie" && dimensionSelect("axis", "분류 기준")}
          {draft.type === "radar" && (
            <>
              {dimensionSelect("axis", "축 기준")}
              {dimensionSelect("series", "계열 기준")}
            </>
          )}
          {draft.type === "table" && (
            <>
              {dimensionSelect("row", "행 기준")}
              {dimensionSelect("column", "열 기준", true)}
            </>
          )}
          {draft.type !== "top" &&
            draft.values.map((definition, index) => {
              const encoded = JSON.stringify(definition);
              return (
                <div key={index} className="insights-editor-value">
                  <label>
                    값 {index + 1}
                    <Select
                      aria-label={`값 ${index + 1}`}
                      value={encoded}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          values: draft.values.map((v, i) =>
                            i === index ? JSON.parse(event.target.value) : v,
                          ),
                        })
                      }
                    >
                      {values
                        .filter(
                          (entry) =>
                            draft.type !== "pie" ||
                            [
                              "count",
                              "completed",
                              "inProgress",
                              "workWeeks",
                              "delayed",
                              "numberSum",
                            ].includes(entry.value.kind),
                        )
                        .map((entry) => (
                          <option
                            key={JSON.stringify(entry.value)}
                            value={JSON.stringify(entry.value)}
                          >
                            {entry.label}
                          </option>
                        ))}
                      {!values.some(
                        (entry) => JSON.stringify(entry.value) === encoded,
                      ) && (
                        <option value={encoded}>
                          {VALUE_LABELS[definition.kind]} ·{" "}
                          {"propertyId" in definition
                            ? definition.propertyId
                            : ""}
                        </option>
                      )}
                    </Select>
                  </label>
                  {draft.type === "table" && draft.values.length > 1 && (
                    <Button
                      title={`값 ${index + 1} 삭제`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          values: draft.values.filter((_, i) => i !== index),
                        })
                      }
                    >
                      삭제
                    </Button>
                  )}
                </div>
              );
            })}
          {draft.type === "table" && (
            <Button
              disabled={draft.values.length >= 4}
              onClick={() =>
                setDraft({
                  ...draft,
                  values: [...draft.values, { kind: "workWeeks" }],
                })
              }
            >
              값 추가
            </Button>
          )}
          {draft.type === "top" ? (
            <>
              <label>
                정렬 값
                <Select
                  aria-label="정렬 값"
                  value={JSON.stringify(draft.sort)}
                  onChange={(event) =>
                    setDraft({ ...draft, sort: JSON.parse(event.target.value) })
                  }
                >
                  <option value={'{"kind":"duration"}'}>업무 기간</option>
                  <option value={'{"kind":"delayWeeks"}'}>지연 주</option>
                  {numeric.map((p) => (
                    <option
                      key={p.id}
                      value={JSON.stringify({
                        kind: "number",
                        propertyId: p.id,
                      })}
                    >
                      {p.name}
                    </option>
                  ))}
                  {draft.sort?.kind === "number" &&
                    !numeric.some(
                      (p) =>
                        p.id ===
                        (draft.sort && "propertyId" in draft.sort
                          ? draft.sort.propertyId
                          : ""),
                    ) && (
                      <option value={JSON.stringify(draft.sort)}>
                        숫자 열: {draft.sort.propertyId}
                      </option>
                    )}
                </Select>
              </label>
              <label>
                개수
                <input
                  aria-label="Top N 개수"
                  type="number"
                  min={5}
                  max={50}
                  value={draft.limit ?? 10}
                  onChange={(event) =>
                    setDraft({ ...draft, limit: Number(event.target.value) })
                  }
                />
              </label>
            </>
          ) : (
            <label>
              표시
              <Select
                aria-label="값 표시"
                value={draft.display?.percent || "value"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    display: {
                      ...draft.display,
                      percent: event.target.value as
                        "value" | "total" | "series",
                    },
                  })
                }
              >
                <option value="value">값 그대로</option>
                <option value="total">전체 대비 %</option>
                <option value="series">계열 안 %</option>
              </Select>
            </label>
          )}
          {draft.type === "bar" && (
            <>
              <label>
                방향
                <Select
                  aria-label="막대 방향"
                  value={draft.display?.orientation || "vertical"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      display: {
                        ...draft.display,
                        orientation: event.target.value as
                          "vertical" | "horizontal",
                      },
                    })
                  }
                >
                  <option value="vertical">세로</option>
                  <option value="horizontal">가로</option>
                </Select>
              </label>
              <label>
                배치
                <Select
                  aria-label="막대 배치"
                  value={draft.display?.mode || "grouped"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      display: {
                        ...draft.display,
                        mode: event.target.value as "grouped" | "stacked",
                      },
                    })
                  }
                >
                  <option value="grouped">묶음</option>
                  <option value="stacked">누적</option>
                </Select>
              </label>
            </>
          )}
          <details>
            <summary>차트 필터</summary>
            <InsightsFilters
              teamId={teamId}
              settings={ctx.settings}
              tasks={tasks}
              users={ctx.users}
              filter={draft.filter || {}}
              onChange={(filter) => setDraft({ ...draft, filter })}
            />
          </details>
          <ErrorNote error={error || validation} />
          {canSave && (
            <Button
              className="primary"
              disabled={busy || !!validation}
              onClick={async () => {
                if (!parsed.success || validation) return;
                setBusy(true);
                setError("");
                try {
                  await onSave(parsed.data);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              저장
            </Button>
          )}
        </fieldset>
        <section className="insights-editor-preview" aria-label="즉시 미리보기">
          <h3>{draft.title}</h3>
          {result?.warnings.map((warning) => (
            <p className="field-help" key={warning}>
              {warning}
            </p>
          ))}
          {result && parsed.success && (
            <InsightsChart
              chart={parsed.data}
              result={result}
              ctx={ctx}
              onDrill={(cell) => onDrill(parsed.data, cell)}
              onTask={onTask}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}
