import { useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "../ui/usePopover";
import { GripVertical } from "lucide-react";
import { Button, Empty, ErrorNote, Modal } from "../components";
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
  taskMetrics,
  workColorSet,
} from "../../shared/insights/insights.js";
import InsightsChart, { InsightsTaskTable } from "./InsightsChart";
import InsightsChartEditor from "./InsightsChartEditor";
import InsightsSettings from "./InsightsSettings";
import InsightsFilters, { type InsightsFilter } from "./InsightsFilters";
import useInsightsData from "./useInsightsData";
import type { Bootstrap, Settings, Task, Team, User } from "../types";
import type {
  ChartCell,
  InsightChart,
  InsightsContext,
  InsightsSettings as InsightsSettingsData,
  TaskMetrics,
} from "./insights-types";
import "./insights.css";
import { savedFilterSchema } from "../../shared/validation.js";

const monthKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;
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
function readInsightsView(key: string, fallback: { from: string; to: string }) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "null");
    const filter = savedFilterSchema.safeParse(stored?.filter);
    return {
      period:
        stored?.period && !periodError(stored.period)
          ? stored.period
          : fallback,
      filter: filter.success ? filter.data : {},
    };
  } catch {
    return { period: fallback, filter: {} };
  }
}
export default function Insights({
  team,
  user,
  users,
  initial,
  onBootstrap,
  onTask,
  onBusyChange,
  onGeneralSettings,
}: {
  team: Team;
  user: User;
  users: User[];
  initial: { tasks: Task[]; year: number; startMonth: number; cursor: string };
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
  const [initialView] = useState(() =>
    readInsightsView(viewKey, {
      from: monthKey(initial.year, initial.startMonth),
      to: monthKey(
        initial.year + (initial.startMonth > 1 ? 1 : 0),
        initial.startMonth > 1 ? initial.startMonth - 1 : 12,
      ),
    }),
  );
  const [period, setPeriod] = useState<{ from: string; to: string }>(
    initialView.period,
  );
  const [filter, setFilter] = useState<InsightsFilter>(initialView.filter);
  useEffect(() => {
    try {
      sessionStorage.setItem(viewKey, JSON.stringify({ period, filter }));
    } catch {
      /* Session preferences are optional when storage is unavailable. */
    }
  }, [viewKey, period, filter]);
  const [showSettings, setShowSettings] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
    () =>
      propertiesFor(team.settings).find((p) => p.kind === "option")?.id || "",
  );
  const today = useTodayKey(),
    mobile = useMobileLayout(),
    cache = useRef(createTaskMetricsCache());
  const allowed = canManageTeam(user, team.id);
  const settings = team.settings;
  const mounted = useRef(true);
  const settingsEpoch = useRef(0),
    saving = useRef(false);
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
  const data = useInsightsData(team.id, period, initial, async (signal) => {
    if (saving.current) return;
    const epoch = settingsEpoch.current;
    const boot = await api<Bootstrap>("/bootstrap", { signal });
    if (
      !signal.aborted &&
      mounted.current &&
      epoch === settingsEpoch.current &&
      !saving.current
    )
      onBootstrap(boot);
  });
  const tasks = useMemo<Task[]>(
    () =>
      filteredTasks(data.tasks, savedFilter(filter, settings), settings, users),
    [data.tasks, filter, settings, users],
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
      ...(optionId
        ? [
            chartDefinition("table", "선택형 속성별 통계", {
              dimensions: { row: { kind: "property", propertyId: optionId } },
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
    [optionId],
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
    settingsEpoch.current++;
    saving.current = true;
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
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function saveCharts(
    next: InsightChart[],
    revision = settings.revision || 0,
  ) {
    await save(
      {
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
      void saveCharts(reorderItems(charts, id, target, placement))
        .then(() => setMessage("차트 순서를 저장했습니다."))
        .catch((e) => setError((e as Error).message));
    },
    busy || !allowed || mobile,
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
      <div className="page-heading">
        <div className="heading-line">
          <h1>인사이트</h1>
        </div>
        <div className="insights-controls">
          <label className="insights-month">
            <span>시작 월</span>
            <input
              type="month"
              aria-label="인사이트 시작 월"
              min="2000-01"
              max="2100-12"
              value={period.from}
              onChange={(event) =>
                setPeriod({ ...period, from: event.target.value })
              }
            />
          </label>
          <span>~</span>
          <label className="insights-month">
            <span>끝 월</span>
            <input
              type="month"
              aria-label="인사이트 끝 월"
              min="2000-01"
              max="2100-12"
              value={period.to}
              onChange={(event) =>
                setPeriod({ ...period, to: event.target.value })
              }
            />
          </label>
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
                  tasks={data.tasks}
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
        </div>
      </div>
      <ErrorNote error={periodError(period) || error || data.error} />
      {data.error && <Button onClick={data.retry}>다시 연결</Button>}
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
      ) : !periodError(period) && !data.loading && !data.error ? (
        <>
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
          <div className="insights-grid">
            {fixed.slice(6).map((chart) => (
              <article className="insights-card" key={chart.title}>
                <div className="insights-card-heading">
                  <h2>{chart.title}</h2>
                  {chart.title === "선택형 속성별 통계" && (
                    <Select
                      aria-label="통계 속성"
                      value={optionId}
                      onChange={(event) => setOptionId(event.target.value)}
                    >
                      {propertiesFor(settings, true)
                        .filter((p) => p.kind === "option")
                        .map((p) => (
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
          <div className="insights-card-heading">
            <h2>팀 차트</h2>
            <Button
              disabled={mobile || busy || (allowed && charts.length >= 30)}
              onClick={() => edit()}
            >
              {allowed ? "차트 추가" : "차트 미리보기"}
            </Button>
          </div>
          <div className="insights-grid" ref={reorder.root}>
            {charts.map((chart) => (
              <article
                className="insights-card insights-team-chart"
                key={chart.id}
                {...reorder.itemProps(chart.id)}
              >
                <div className="insights-card-heading">
                  {allowed && (
                    <button
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
          </div>
        </>
      ) : (
        data.loading && <LoadingState label="업무를 불러오고 있습니다" />
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
