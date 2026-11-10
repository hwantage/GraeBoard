import { useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../ui/usePopover";
import { Download, GripVertical } from "lucide-react";
import { Button } from "../ui/Button";
import { Empty } from "../ui/Empty";
import { ErrorNote } from "../ui/ErrorNote";
import { Modal } from "../ui/Modal";
import LoadingState from "../ui/LoadingState";
import Select from "../ui/Select";
import Toast, { useToast } from "../ui/Toast";
import { useMobileLayout } from "../ui/useMobileLayout";
import { useTodayKey } from "../sheet/useTodayKey";
import { reorderItems, useListReorder } from "../ui/useListReorder";
import { api, send } from "../platform/api";
import {
  canManageTeam,
  filteredTasks,
  mondayOf,
  propertiesFor,
  shortId,
  savedFilter,
} from "../../shared/domain.js";
import {
  aggregate,
  createTaskMetricsCache,
  deadlinePropertyId,
  drillDown,
  periodError,
  periodForWeeks,
  taskMetrics,
  workColorSet,
} from "../../shared/insights/insights.js";
import InsightsChart, { InsightsTaskTable } from "./InsightsChart";
import InsightsChartEditor from "./InsightsChartEditor";
import InsightsComparison from "./InsightsComparison";
import InsightsAnalysis from "./InsightsAnalysis";
import { exportInsightsReport } from "./insights-export";
import { insightFilterLabels } from "./insights-chart-presentation";
import { comparisonProperty } from "./insights-chart-templates";
import InsightsSettings from "./InsightsSettings";
import InsightsFilters, { type InsightsFilter } from "./InsightsFilters";
import type { Bootstrap, Settings, Task, Team, User } from "../types";
import type {
  ChartCell,
  InsightChart,
  InsightsContext,
  InsightsPeriod,
  InsightsSettings as InsightsSettingsData,
  TaskMetrics,
} from "./insights-types";
import "./insights.css";
import { savedFilterSchema } from "../../shared/validation.js";

const chartDefinition = (
  type: InsightChart["type"],
  title: string,
  extra: Partial<InsightChart> = {},
): InsightChart => ({
  id: "c000000",
  title,
  type,
  dimensions: {},
  values: [{ kind: "count" }],
  ...extra,
});
function readInsightsFilter(key: string): InsightsFilter {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "null");
    const filter = savedFilterSchema.safeParse(stored?.filter);
    return filter.success ? filter.data : {};
  } catch {
    return {};
  }
}
export default function Insights({
  team,
  user,
  users,
  year,
  startMonth,
  source,
  weeks,
  controlsHost,
  onBootstrap,
  onTask,
  onBusyChange,
  onGeneralSettings,
}: {
  team: Team;
  user: User;
  users: User[];
  year: number;
  startMonth: number;
  source: {
    tasks: Task[];
    ready: boolean;
    queryError: string;
    retry: () => void;
  };
  weeks: NonNullable<InsightsPeriod["weeks"]>;
  controlsHost: HTMLElement | null;
  onBootstrap: (boot: Bootstrap) => void;
  onTask: (metric: TaskMetrics) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onGeneralSettings: () => void;
}) {
  const rangeFilter = usePopover(280, false);
  useEffect(() => {
    // Safari does not focus buttons/checkboxes on pointer clicks. Keep keyboard
    // events inside the open panel even before a filter input receives focus.
    if (rangeFilter.open) rangeFilter.popup.current?.focus();
  }, [rangeFilter.open]);
  const viewKey = `graeboard:insights:${user.id}:${team.id}`;
  // Annual View owns dates. Legacy session periods are deliberately ignored.
  const period = useMemo(
    () => periodForWeeks(weeks, year, startMonth),
    [weeks, year, startMonth],
  );
  const [filter, setFilter] = useState<InsightsFilter>(() =>
    readInsightsFilter(viewKey),
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(viewKey, JSON.stringify({ filter }));
    } catch {
      /* Session preferences are optional when storage is unavailable. */
    }
  }, [viewKey, filter]);
  const [showSettings, setShowSettings] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const reportContent = useRef<HTMLDivElement>(null);
  const printRequest = useRef<AbortController | null>(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => () => printRequest.current?.abort(), []);
  const [editor, setEditor] = useState<{
    chart: InsightChart;
    revision: number;
  } | null>(null);
  const [drill, setDrill] = useState<{
    title: string;
    chart?: InsightChart;
    cell?: ChartCell;
    check?: "noWork" | "noOwner";
  } | null>(null);
  const [message, setMessage] = useToast();
  const [optionId, setOptionId] = useState(
    () => comparisonProperty(team.settings)?.id || "",
  );
  const today = useTodayKey(),
    mobile = useMobileLayout(),
    cache = useRef(createTaskMetricsCache());
  const allowed = canManageTeam(user, team.id);
  const settings = team.settings;
  const optionProperties = propertiesFor(settings, true).filter(
    (p) => p.kind === "option",
  );
  const optionProperty =
    optionProperties.find((p) => p.id === optionId) ||
    comparisonProperty(settings);
  const effectiveOptionId = optionProperty?.id || "";
  useEffect(() => {
    if (optionId !== effectiveOptionId) setOptionId(effectiveOptionId);
  }, [optionId, effectiveOptionId]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange(false);
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  const tasks = useMemo<Task[]>(
    () =>
      filteredTasks(
        source.tasks,
        savedFilter(filter, settings),
        settings,
        users,
      ),
    [source.tasks, filter, settings, users],
  );
  const ctx = useMemo<InsightsContext>(
    () => ({
      settings,
      users,
      period,
      currentWeek: mondayOf(today),
      colors: workColorSet(settings),
      cache: cache.current,
    }),
    [settings, users, period, today],
  );
  const metrics = useMemo(
    () => tasks.map((task) => taskMetrics(task, ctx)),
    [tasks, ctx],
  );
  const inRange = metrics.filter((metric) => metric.rangeWeeks.length);
  const noWork = metrics.filter((metric) => !metric.weeks.length);
  const noOwner = inRange.filter((metric) => !metric.task.cells.owner?.value);
  const charts = settings.insights?.charts || [];
  const fixed = useMemo(
    () => [
      ...(
        [
          ["count", "업무 수"],
          ["workWeeks", "작업 주 합"],
          ["avgDuration", "평균 업무 기간"],
          ["completed", "완료"],
          ["inProgress", "진행 중"],
          ["delayRate", "지연율"],
        ] as const
      ).map(([kind, title]) =>
        chartDefinition("number", title, { values: [{ kind }] }),
      ),
      chartDefinition("table", "책임자별 통계", {
        dimensions: { row: { kind: "owner" } },
        values: [
          { kind: "count" },
          { kind: "workWeeks" },
          { kind: "avgDuration" },
          { kind: "delayRate" },
        ],
      }),
      chartDefinition("top", "가장 오래 걸린 업무 Top 10", {
        sort: { kind: "duration" },
        limit: 10,
      }),
      ...(effectiveOptionId
        ? [
            chartDefinition("table", "선택형 속성별 통계", {
              dimensions: {
                row: { kind: "property", propertyId: effectiveOptionId },
              },
              values: [
                { kind: "count" },
                { kind: "workWeeks" },
                { kind: "avgDuration" },
                { kind: "delayRate" },
              ],
            }),
          ]
        : []),
    ],
    [effectiveOptionId],
  );
  const results = useMemo(
    () =>
      new Map(
        [...fixed, ...charts].map((chart) => [
          chart,
          aggregate(tasks, chart, ctx),
        ]),
      ),
    [tasks, charts, fixed, ctx],
  );
  async function save(draft: InsightsSettingsData, revision: number) {
    setBusy(true);
    try {
      const result = await send<{ settings: Settings }>(
        `/teams/${team.id}/settings`,
        { revision, insights: draft },
        "PATCH",
      );
      const boot = await api<Bootstrap>("/bootstrap");
      if (mounted.current) onBootstrap(boot);
      return result.settings;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function saveCharts(
    next: InsightChart[],
    revision = settings.revision || 0,
  ) {
    await save(
      {
        ...settings.insights,
        workColors: settings.insights?.workColors || [],
        deadlinePropertyId: deadlinePropertyId(settings),
        charts: next,
      },
      revision,
    );
  }
  const reorder = useListReorder<HTMLDivElement>(
    charts.map((chart) => chart.id),
    (id, target, placement) => {
      const next = reorderItems(charts, id, target, placement);
      if (next.every((chart, index) => chart.id === charts[index].id)) return;
      void saveCharts(next)
        .then(() => setMessage("차트 순서를 저장했습니다."))
        .catch((e) => setError((e as Error).message));
    },
    busy || !allowed || mobile,
    "grid",
  );
  const edit = (chart?: InsightChart) =>
    setEditor({
      chart: chart || {
        id: shortId("c"),
        title: "새 차트",
        type: "bar",
        dimensions: { axis: { kind: "owner" } },
        values: [{ kind: "count" }],
        display: { percent: "value" },
      },
      revision: settings.revision || 0,
    });
  const drillMetrics =
    drill?.check === "noWork"
      ? noWork
      : drill?.check === "noOwner"
        ? noOwner
        : drill?.chart
          ? drillDown(tasks, drill.chart, drill.cell, ctx)
          : [];
  const deadlineId = deadlinePropertyId(settings),
    deadline = propertiesFor(settings, true).find((p) => p.id === deadlineId);
  const configured = !!settings.insights?.workColors.length;
  const printable =
    configured &&
    source.ready &&
    !source.queryError &&
    !periodError(period) &&
    !busy &&
    ![...results.values()].some((result) => result.errors.length);
  async function downloadReport() {
    if (!printable || !reportContent.current || printRequest.current) return;
    const controller = new AbortController();
    printRequest.current = controller;
    setPrinting(true);
    setError("");
    try {
      const effective = savedFilter(filter, settings);
      const labels = insightFilterLabels(effective, ctx);
      const lastMonth = startMonth + 11;
      await exportInsightsReport(
        {
          title: `${team.name} · 인사이트 보고서`,
          teamName: team.name,
          annualView: `${year}-${String(startMonth).padStart(2, "0")} ~ ${year + Math.floor((lastMonth - 1) / 12)}-${String(((lastMonth - 1) % 12) + 1).padStart(2, "0")}`,
          period,
          filters: labels,
          content: reportContent.current,
        },
        controller.signal,
      );
    } catch (e) {
      if (mounted.current && !controller.signal.aborted)
        setError(`보고서를 내려받지 못했습니다. ${(e as Error).message}`);
    } finally {
      printRequest.current = null;
      if (mounted.current) setPrinting(false);
    }
  }
  async function openTask(metric: TaskMetrics) {
    setDrill(null);
    setEditor(null);
    try {
      await onTask(metric);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  return (
    <section className="insights-page" aria-label="인사이트">
      {controlsHost &&
        createPortal(
          <div className="insights-controls">
            <Button
              ref={rangeFilter.trigger}
              aria-expanded={rangeFilter.open}
              aria-haspopup="dialog"
              onClick={() => rangeFilter.setOpen(!rangeFilter.open)}
            >
              범위 필터
            </Button>
            {rangeFilter.open &&
              createPortal(
                <div
                  ref={rangeFilter.popup}
                  className="insights-range-filter-popover"
                  role="dialog"
                  aria-label="범위 필터"
                  tabIndex={-1}
                  style={rangeFilter.position}
                  onKeyDown={rangeFilter.onKeyDown}
                >
                  <InsightsFilters
                    teamId={team.id}
                    settings={settings}
                    tasks={source.tasks}
                    users={users}
                    filter={filter}
                    onChange={setFilter}
                  />
                </div>,
                rangeFilter.container(),
              )}
            {allowed && (
              <Button disabled={busy} onClick={() => setShowSettings(true)}>
                인사이트 설정
              </Button>
            )}
            <Button
              tooltip="PDF (인쇄 창에서 저장)"
              disabled={!printable}
              aria-busy={printing}
              onClick={() => void downloadReport()}
            >
              <Download size={16} aria-hidden="true" />
            </Button>
          </div>,
          controlsHost,
        )}
      <ErrorNote error={periodError(period) || error || source.queryError} />
      {source.queryError && <Button onClick={source.retry}>다시 연결</Button>}
      {!configured ? (
        <Empty
          title="업무 색상을 설정해 주세요"
          description={
            allowed
              ? "설정의 팀 일반에서 업무 표시 색상을 지정하세요."
              : "팀장에게 업무 색상 설정을 요청하세요."
          }
          action={
            allowed ? (
              <Button onClick={onGeneralSettings}>업무 색상 설정</Button>
            ) : undefined
          }
        />
      ) : !periodError(period) && source.ready && !source.queryError ? (
        <div ref={reportContent}>
          {!!deadlineId &&
            (!deadline || deadline.archived || deadline.kind !== "date") && (
              <p className="field-help">
                {deadline?.archived
                  ? "보관된 속성"
                  : "목표일 기준 속성을 확인하세요"}
                : {deadline?.name || deadlineId}
              </p>
            )}
          <div className="insights-summary">
            {fixed.slice(0, 6).map((chart) => (
              <article className="insights-card" key={chart.title}>
                <h2>{chart.title}</h2>
                <InsightsChart
                  chart={chart}
                  result={results.get(chart)!}
                  ctx={ctx}
                  onDrill={(cell) =>
                    setDrill({ title: chart.title, chart, cell })
                  }
                  onTask={openTask}
                />
              </article>
            ))}
          </div>
          <InsightsComparison
            tasks={tasks}
            ctx={ctx}
            onDrill={(chart, cell) =>
              setDrill({ title: chart.title, chart, cell })
            }
            onTask={openTask}
          />
          <InsightsAnalysis
            tasks={tasks}
            ctx={ctx}
            teamId={team.id}
            ownerSummary={results.get(fixed[6])!}
            onDrill={(chart, cell) =>
              setDrill({ title: chart.title, chart, cell })
            }
            onTask={openTask}
          />
          <div className="insights-grid">
            {[fixed[6], fixed[8]].filter(Boolean).map((chart) => (
              <article className="insights-card" key={chart.title}>
                <div className="insights-card-heading">
                  <h2>{chart.title}</h2>
                  {chart.title === "선택형 속성별 통계" && (
                    <Select
                      aria-label="통계 속성"
                      value={effectiveOptionId}
                      onChange={(event) => setOptionId(event.target.value)}
                    >
                      {optionProperties.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name}
                          {p.archived ? " (보관된 속성)" : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
                <InsightsChart
                  chart={chart}
                  result={results.get(chart)!}
                  ctx={ctx}
                  onDrill={(cell) =>
                    setDrill({ title: chart.title, chart, cell })
                  }
                  onTask={openTask}
                />
              </article>
            ))}
          </div>
          <div className="insights-card-heading">
            <h2>팀 차트</h2>
            <Button
              data-report-omit
              disabled={mobile || busy || (allowed && charts.length >= 30)}
              onClick={() => edit()}
            >
              {allowed ? "차트 추가" : "차트 미리보기"}
            </Button>
          </div>
          <div
            className="insights-grid insights-team-chart-grid"
            ref={reorder.root}
            {...reorder.rootProps}
          >
            {charts.map((chart) => (
              <article
                className={`insights-card insights-team-chart${(chart.type === "table" && chart.dimensions.column) || chart.type === "top" ? " insights-card-wide" : ""}`}
                key={chart.id}
                {...reorder.itemProps(chart.id)}
              >
                <div className="insights-card-heading">
                  {allowed && (
                    <button
                      data-report-omit
                      {...reorder.handleProps(chart.id)}
                      aria-label={`${chart.title} 순서 이동`}
                    >
                      <GripVertical size={16} />
                    </button>
                  )}
                  <h3>{chart.title}</h3>
                  <div className="insights-card-actions">
                    <Button
                      disabled={mobile || busy}
                      title={`${chart.title} ${allowed ? "편집" : "미리보기"}`}
                      onClick={() => edit(chart)}
                    >
                      {allowed ? "편집" : "미리보기"}
                    </Button>
                    {allowed && (
                      <>
                        <Button
                          disabled={busy || mobile || charts.length >= 30}
                          title={`${chart.title} 복제`}
                          onClick={() => {
                            void saveCharts([
                              ...charts,
                              {
                                ...chart,
                                id: shortId("c"),
                                title: `${chart.title.slice(0, 75)} 사본`,
                              },
                            ])
                              .then(() => setMessage("차트를 복제했습니다."))
                              .catch((e) => setError((e as Error).message));
                          }}
                        >
                          복제
                        </Button>
                        <Button
                          disabled={busy || mobile}
                          title={`${chart.title} 삭제`}
                          onClick={() => {
                            void saveCharts(
                              charts.filter((entry) => entry.id !== chart.id),
                            )
                              .then(() => setMessage("차트를 삭제했습니다."))
                              .catch((e) => setError((e as Error).message));
                          }}
                        >
                          삭제
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <p className="insights-print-only">
                  차트 필터:{" "}
                  {insightFilterLabels(
                    savedFilter(chart.filter || {}, settings),
                    ctx,
                  ).join(" / ") || "전체"}
                </p>
                {results.get(chart)!.warnings.map((warning) => (
                  <p className="field-help" key={warning}>
                    {warning}
                  </p>
                ))}
                <InsightsChart
                  chart={chart}
                  result={results.get(chart)!}
                  ctx={ctx}
                  onDrill={(cell) =>
                    setDrill({ title: chart.title, chart, cell })
                  }
                  onTask={openTask}
                />
              </article>
            ))}
            {reorder.gridPreview && (
              <div
                className="insights-chart-drop-slot"
                data-reorder-preview-id={reorder.gridPreview.id}
                data-reorder-preview-index={reorder.gridPreview.index}
                data-reorder-preview-order={reorder.gridPreview.order.join(",")}
                aria-hidden="true"
                style={{
                  left: reorder.gridPreview.left,
                  top: reorder.gridPreview.top,
                  width: reorder.gridPreview.width,
                  height: reorder.gridPreview.height,
                }}
              >
                <span>
                  {
                    charts.find((chart) => chart.id === reorder.gridPreview!.id)
                      ?.title
                  }{" "}
                  · {reorder.gridPreview.index + 1}번째 위치
                </span>
              </div>
            )}
          </div>
          <article className="insights-card insights-supporting-tasks">
            <h2>{fixed[7].title}</h2>
            <InsightsChart
              chart={fixed[7]}
              result={results.get(fixed[7])!}
              ctx={ctx}
              onDrill={(cell) =>
                setDrill({ title: fixed[7].title, chart: fixed[7], cell })
              }
              onTask={openTask}
            />
          </article>
          <section className="insights-data-check">
            <h2>데이터 점검</h2>
            <Button
              onClick={() => setDrill({ title: "작업 없음", check: "noWork" })}
            >
              작업 없음 {noWork.length}건
            </Button>
            <Button
              onClick={() =>
                setDrill({ title: "책임자 미지정", check: "noOwner" })
              }
            >
              책임자 미지정 {noOwner.length}건
            </Button>
          </section>
        </div>
      ) : (
        !source.ready && <LoadingState label="업무를 불러오고 있습니다" />
      )}
      {showSettings && allowed && (
        <InsightsSettings
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={save}
        />
      )}
      {editor && !mobile && (
        <InsightsChartEditor
          teamId={team.id}
          initial={editor.chart}
          tasks={tasks}
          ctx={ctx}
          canSave={allowed}
          onClose={() => setEditor(null)}
          onSave={async (chart) => {
            await saveCharts(
              charts.some((entry) => entry.id === chart.id)
                ? charts.map((entry) => (entry.id === chart.id ? chart : entry))
                : [...charts, chart],
              editor.revision,
            );
            setEditor(null);
            setMessage("차트를 저장했습니다.");
          }}
          onDrill={(chart, cell) =>
            setDrill({ title: chart.title, chart, cell })
          }
          onTask={openTask}
        />
      )}
      {drill && (
        <Modal
          title={`${drill.title} · 업무 목록`}
          wide
          onClose={() => setDrill(null)}
        >
          <InsightsTaskTable
            metrics={drillMetrics}
            ctx={ctx}
            onTask={openTask}
          />
        </Modal>
      )}
      <Toast message={message} />
    </section>
  );
}
