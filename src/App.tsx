import Select from "./Select";
import { getTheme, themeVariables } from "../shared/themes.js";
import { applyBorderPreset } from "../shared/borders.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CalendarDays,
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Upload,
  History,
  FileClock,
  Trash2,
  Settings,
  Check,
  LoaderCircle,
  CloudOff,
  Eye,
  Bookmark,
  X,
  RotateCcw,
  Save,
  LogOut,
  ArrowLeft,
  Presentation,
  Minimize2,
} from "lucide-react";
import { api, send, ApiError } from "./api";
import {
  FIELDS,
  fieldsFor,
  orderColumns,
  propertiesFor,
  emptyPropertyValue,
  propertyValue,
  normalizeView,
  DEFAULT_SETTINGS,
  MAX_STYLE_CELLS,
  defaultView,
  visibleWeeks,
  weeksForYear,
  filteredTasks,
  cell,
  value,
  canEdit,
  statusSummary,
  todayKey,
} from "../shared/domain.js";
import type {
  Bootstrap,
  Task,
  User,
  View,
  Style,
  Border,
  BorderPreset,
  Selection,
  Point,
  CellChange,
  BatchResult,
  HistoryEntry,
  TaskDeletion,
  Report,
  SavedCell,
  Property,
} from "./types";
import {
  Auth,
  Button,
  Modal,
  Empty,
  Avatar,
  ErrorNote,
  SessionLogin,
} from "./components";
import AdminPanel from "./AdminPanel";
import { BrandMark, BrandWordmark } from "./Brand";
import Grid, { type Column, rangeOf, rangesOf, selectedPoints } from "./Grid";
import Toolbar from "./Toolbar";
import PeriodPicker from "./PeriodPicker";
import FindBar from "./FindBar";
import {
  createClipboard,
  copyToSystem,
  type ClipboardMatrix,
} from "./clipboard";
import { rebaseHistory, cellsBefore, describeStyle } from "./history";
import {
  RowPanel,
  ExportPanel,
  ImportPanel,
  ReportsPanel,
  HistoryPanel,
  TrashPanel,
  AccountPanel,
} from "./Panels";

type Failed = {
  payload: { operationId: string; changes: CellChange[] };
  error: ApiError | Error;
  mode: "normal" | "undo" | "redo";
};
function rememberedBoard(boot: Bootstrap) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`weekly-board:${boot.user.id}`) || "{}",
    );
    return {
      teamId: boot.teams.some((t) => t.id === stored.teamId)
        ? stored.teamId
        : boot.teams[0]?.id || "",
      year:
        Number.isInteger(stored.year) &&
        stored.year >= 2000 &&
        stored.year <= 2100
          ? stored.year
          : Number(todayKey().slice(0, 4)),
    };
  } catch {
    return {
      teamId: boot.teams[0]?.id || "",
      year: Number(todayKey().slice(0, 4)),
    };
  }
}
export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [authReady, setAuthReady] = useState(false),
    [startupError, setStartupError] = useState("");
  useEffect(() => {
    api<Bootstrap>("/bootstrap")
      .then(setBoot)
      .catch((e) => {
        if (e.status !== 401) setStartupError(e.message);
      })
      .finally(() => setAuthReady(true));
  }, []);
  if (!authReady)
    return (
      <div className="app-loading">
        <LoaderCircle className="spin" />
        기록을 불러오고 있습니다
      </div>
    );
  if (startupError)
    return (
      <Empty
        title="서버에 연결할 수 없습니다"
        description={startupError}
        action={<Button onClick={() => location.reload()}>다시 연결</Button>}
      />
    );
  if (!boot) return <Auth onLogin={setBoot} />;
  return (
    <Workspace
      key={boot.user.id}
      boot={boot}
      onBootstrap={setBoot}
      onLogout={() => setBoot(null)}
    />
  );
}
function Workspace({
  boot,
  onBootstrap,
  onLogout,
}: {
  boot: Bootstrap;
  onBootstrap: (b: Bootstrap) => void;
  onLogout: () => void;
}) {
  const { user } = boot;
  const [teamId, setTeamId] = useState(() => rememberedBoard(boot).teamId),
    [year, setYear] = useState(() => rememberedBoard(boot).year),
    [tasks, setTasks] = useState<Task[]>([]),
    [view, setView] = useState<View>(
      defaultView(Number(todayKey().slice(0, 4))) as View,
    ),
    [loaded, setLoaded] = useState(false),
    [panel, setPanel] = useState(""),
    [rowTask, setRowTask] = useState<Task | null>(null),
    [editor, setEditor] = useState<{ point: Point; initial?: string } | null>(
      null,
    ),
    [selection, setSelection] = useState<Selection | null>(null),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    // 방금 삭제한 보기. 알림이 떠 있는 동안 실행취소로 되살릴 수 있다.
    [undoToast, setUndoToast] = useState<{
      message: string;
      undo: () => Promise<void>;
    } | null>(null),
    [presentation, setPresentation] = useState(false),
    [viewMenu, setViewMenu] = useState(false),
    [savedViews, setSavedViews] = useState<any[]>([]),
    [viewName, setViewName] = useState(""),
    [saveNameOpen, setSaveNameOpen] = useState(false),
    [pending, setPending] = useState(0),
    [failed, setFailed] = useState<Failed | null>(null),
    [lastSaved, setLastSaved] = useState(""),
    [undoStack, setUndoStack] = useState<HistoryEntry[]>([]),
    [redoStack, setRedoStack] = useState<HistoryEntry[]>([]),
    [report, setReport] = useState<Report | null>(null),
    [jump, setJump] = useState<{
      key: string | null;
      taskId?: string;
      id: number;
    } | null>(null),
    [viewError, setViewError] = useState("");
  const team = boot.teams.find((t) => t.id === teamId) || boot.teams[0];
  const themeId = getTheme(team?.settings.theme).id;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const variables = themeVariables(themeId);
    root.dataset.theme = themeId;
    for (const [key, color] of Object.entries(variables))
      root.style.setProperty(key, color);
    return () => {
      delete root.dataset.theme;
      for (const key of Object.keys(variables)) root.style.removeProperty(key);
    };
  }, [themeId]);
  const users = report?.users || boot.users;
  const selectableUsers = report
    ? users
    : users.filter((u) => u.teamIds.includes(teamId));
  const isManager = ["admin", "manager"].includes(user.role);
  const settings = report?.settings || team?.settings || DEFAULT_SETTINGS;
  const fields = useMemo(() => fieldsFor(settings), [settings]);
  const properties = useMemo(
    () => propertiesFor(settings) as Property[],
    [settings],
  );
  const taskRef = useRef(tasks),
    workspaceRef = useRef<HTMLDivElement>(null),
    viewMenuRef = useRef<HTMLDivElement>(null),
    presentationScroll = useRef<{ top: number; left: number } | null>(null),
    viewRef = useRef(view),
    pendingRef = useRef(0),
    failedRef = useRef(failed),
    editorRef = useRef(editor),
    queue = useRef(Promise.resolve()),
    viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    lastView = useRef(view),
    boardKey = useRef(""),
    mutationEpoch = useRef(0),
    viewSaver = useRef<null | (() => void)>(null);
  useLayoutEffect(() => {
    const grid =
      workspaceRef.current?.querySelector<HTMLElement>(".sheet-scroll");
    if (presentation) grid?.focus({ preventScroll: true });
    else if (presentationScroll.current) {
      grid?.scrollTo(
        presentationScroll.current.left,
        presentationScroll.current.top,
      );
      presentationScroll.current = null;
      workspaceRef.current
        ?.querySelector<HTMLElement>(".presentation-start")
        ?.focus({ preventScroll: true });
    }
  }, [presentation]);
  useEffect(() => {
    if (!presentation) return;
    const exit = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPresentation(false);
      }
    };
    window.addEventListener("keydown", exit, true);
    return () => window.removeEventListener("keydown", exit, true);
  }, [presentation]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `weekly-board:${user.id}`,
        JSON.stringify({ teamId, year }),
      );
    } catch {}
  }, [teamId, year, user.id]);
  useEffect(() => {
    if (teamId && !boot.teams.some((t) => t.id === teamId)) {
      boardKey.current = "";
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewTimer.current = null;
      viewSaver.current = null;
      setEditor(null);
      editorRef.current = null;
      setFailed(null);
      failedRef.current = null;
      setError("");
      setViewError("");
      setTeamId(boot.teams[0]?.id || "");
    }
  }, [boot.teams, teamId]);
  taskRef.current = tasks;
  viewRef.current = view;
  failedRef.current = failed;
  editorRef.current = editor;
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (undoToast) {
      const timer = setTimeout(() => setUndoToast(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [undoToast]);
  // 저장한 보기 팝업은 바깥을 누르거나 Esc로 닫는다. 실행취소 알림은
  // 되살아난 항목을 바로 확인할 수 있게 팝업을 닫지 않는다.
  useEffect(() => {
    if (!viewMenu) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!viewMenuRef.current?.contains(target) && !target.closest?.(".toast"))
        setViewMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [viewMenu]);
  const refreshBoot = () =>
    api<Bootstrap>("/bootstrap")
      .then((next) => {
        onBootstrap(next);
        return next;
      })
      .catch((e) => setError(e.message));
  const refresh = useCallback(async () => {
    if (!teamId) return;
    const key = `${teamId}:${year}`,
      epoch = mutationEpoch.current;
    try {
      const [r, latestBoot] = await Promise.all([
        api(`/tasks?teamId=${teamId}&year=${year}`),
        api<Bootstrap>("/bootstrap"),
      ]);
      if (
        boardKey.current === key &&
        epoch === mutationEpoch.current &&
        !pendingRef.current &&
        !failedRef.current &&
        !editorRef.current
      ) {
        taskRef.current = r.tasks;
        setTasks(r.tasks);
        onBootstrap(latestBoot);
      }
    } catch (e) {
      if (e instanceof ApiError && [403, 404].includes(e.status)) {
        try {
          const latest = await api<Bootstrap>("/bootstrap");
          if (
            boardKey.current === key &&
            !latest.teams.some((t) => t.id === teamId)
          ) {
            onBootstrap(latest);
            return;
          }
        } catch {}
      }
      if (boardKey.current !== key) return;
      setError((e as Error).message);
    }
  }, [teamId, year]);
  const refreshViews = useCallback(async () => {
    const r = await api(`/views?teamId=${teamId}&year=${year}`);
    setSavedViews(r.views);
    return r.views;
  }, [teamId, year]);
  useEffect(() => {
    if (!teamId) return;
    const key = `${teamId}:${year}`;
    boardKey.current = key;
    setLoaded(false);
    setError("");
    setViewError("");
    setSelection(null);
    setReport(null);
    setUndoStack([]);
    setRedoStack([]);
    setTasks([]);
    setJump(null);
    Promise.all([
      api(`/tasks?teamId=${teamId}&year=${year}`),
      api(`/views?teamId=${teamId}&year=${year}`),
    ])
      .then(([r, v]) => {
        if (boardKey.current !== key) return;
        setTasks(r.tasks);
        taskRef.current = r.tasks;
        setSavedViews(v.views);
        const current =
          v.views.find((s: any) => s.name === "__current")?.data ||
          defaultView(year);
        setView(current);
        viewRef.current = current;
        setLoaded(true);
        setJump({ key: null, id: Date.now() });
      })
      .catch((e) => {
        if (boardKey.current === key) {
          setError(e.message);
          setLoaded(true);
        }
      });
    return () => {
      boardKey.current = "";
      if (viewTimer.current) clearTimeout(viewTimer.current);
      viewSaver.current?.();
      viewSaver.current = null;
    };
  }, [teamId, year]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !report &&
        !pendingRef.current &&
        !failedRef.current &&
        !editorRef.current &&
        document.visibilityState === "visible"
      )
        refresh();
    }, 7000);
    return () => clearInterval(timer);
  }, [refresh, report]);
  useEffect(() => {
    const flushView = () => {
      if (viewTimer.current) clearTimeout(viewTimer.current);
      const save = viewSaver.current;
      viewSaver.current = null;
      save?.();
    };
    const guard = (e: BeforeUnloadEvent) => {
      flushView();
      if (
        pendingRef.current ||
        failedRef.current ||
        editorRef.current ||
        viewTimer.current
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("pagehide", flushView);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("pagehide", flushView);
    };
  }, []);
  function changeView(part: Partial<View>) {
    setSelection(null);
    setViewError("");
    const next = { ...viewRef.current, ...part };
    viewRef.current = next;
    setView(next);
    if (!report) {
      if (viewTimer.current) clearTimeout(viewTimer.current);
      const key = `${teamId}:${year}`;
      const save = () => {
        viewTimer.current = null;
        api("/views", {
          method: "PUT",
          body: JSON.stringify({ teamId, name: "__current", data: next }),
          keepalive: true,
        }).catch((e) => {
          if (boardKey.current === key)
            setViewError("보기 설정 저장 실패: " + e.message);
        });
      };
      viewSaver.current = save;
      viewTimer.current = setTimeout(() => {
        viewSaver.current = null;
        save();
      }, 450);
    }
  }
  useEffect(() => {
    if (!loaded || report) return;
    const next = normalizeView(viewRef.current, settings) as View;
    const memberIds = new Set(selectableUsers.map((u) => u.id));
    for (const property of properties.filter((p) => p.kind === "member")) {
      const values = next.propertyFilters?.[property.id];
      if (values && next.propertyFilters)
        next.propertyFilters[property.id] = values.filter(
          (id) => id === "" || memberIds.has(id),
        );
    }
    if (JSON.stringify(next) !== JSON.stringify(viewRef.current))
      changeView(next);
  }, [settings, loaded, report, boot.users, teamId, view]);
  const source = report?.tasks || tasks;
  // 행 높이·열 너비 같은 표시 설정이 바뀔 때는 업무를 다시 거르지 않는다.
  const filterView = useMemo(
    () => view,
    [
      view.people,
      view.personRole,
      view.propertyFilters,
      view.propertyFilterModes,
      view.groupBy,
      view.sort,
      view.sortKey,
      view.sortDirection,
      view.status,
      view.category,
    ],
  );
  const matches = useMemo(
    () => filteredTasks(source, filterView, user.id, settings, users) as Task[],
    [source, filterView, user.id, settings, users],
  );
  const shown = useMemo(() => {
    const hidden = new Set(view.hiddenRows);
    return matches.filter((t) => !hidden.has(t.id));
  }, [matches, view.hiddenRows]);
  function navigateToSearch(point: Point) {
    const current = viewRef.current;
    const reveal: Partial<View> = {};
    if (!current.visibleFields.includes(point.key))
      reveal.visibleFields = [...current.visibleFields, point.key];
    if (current.hiddenRows.includes(point.taskId))
      reveal.hiddenRows = current.hiddenRows.filter(
        (id) => id !== point.taskId,
      );
    if (Object.keys(reveal).length) changeView(reveal);
    setSelection({ anchor: point, focus: point });
    setJump((previous) => ({
      ...point,
      id: Math.max(Date.now(), (previous?.id || 0) + 1),
    }));
  }
  const weeks = useMemo(() => visibleWeeks(year, view), [year, view]);
  const yearWeekCount = useMemo(() => weeksForYear(year).length, [year]);
  const columnOrder = useMemo(
    () =>
      orderColumns(fields, visibleWeeks(year, { ...view, hiddenWeeks: [] })),
    [fields, year, view],
  );
  const columns = useMemo<Column[]>(
    () =>
      orderColumns(
        fields
          .filter((f) => view.visibleFields.includes(f.key))
          .map((f) => ({
            key: f.key,
            label: f.label,
            width: view.widths[f.key] || f.width,
            placement: f.placement,
          })),
        weeks.map((w) => ({
          key: w.key,
          label: w.label,
          width: view.widths[w.key] || 40,
          month: w.month,
          weekIndex: w.index,
          date: w.date,
          end: w.end,
        })),
      ).map((c, i) => ({
        ...c,
        fixed:
          !c.month &&
          c.placement !== "afterWeeks" &&
          i < (view.frozenColumns ?? 0),
      })),
    [weeks, fields, view.visibleFields, view.widths, view.frozenColumns],
  );
  const range = rangeOf(selection, shown, columns);
  const count = range
    ? (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
    : 0;
  const selectedTask = selection
    ? source.find((t) => t.id === selection.focus.taskId)
    : undefined;
  const selectedCell =
    selection && selectedTask ? cell(selectedTask, selection.focus.key) : null;
  const selectionLabel = selection?.areas?.length
    ? `${selection.areas.length + 1}개 영역 선택`
    : count && range && selection?.kind === "columns"
      ? `${range.c2 - range.c1 + 1}개 열 · ${count.toLocaleString()}개 셀`
      : count && range && selection?.kind === "rows"
        ? `${range.r2 - range.r1 + 1}개 행 · ${count.toLocaleString()}개 셀`
        : count === 1
          ? `${shown.findIndex((t) => t.id === selection!.focus.taskId) + 1}행 · ${columns.find((c) => c.key === selection!.focus.key)?.label}`
          : count
            ? `${count.toLocaleString()}개 셀`
            : "";
  const editable =
    !!selectedTask && canEdit(user, selectedTask) && !report && !failed;
  function getPoints() {
    return selectedPoints(selection, shown, columns);
  }
  function applyResult(result: BatchResult) {
    const previous = taskRef.current;
    const updatedTasks = (() => {
      const byId = new Map<string, SavedCell[]>();
      for (const c of result.cells) {
        const changes = byId.get(c.taskId);
        if (changes) changes.push(c);
        else byId.set(c.taskId, [c]);
      }
      const updated = previous.map((t) => {
        const changes = byId.get(t.id);
        if (!changes) return t;
        return {
          ...t,
          updatedAt: result.updatedAt?.[t.id] || t.updatedAt,
          cells: {
            ...t.cells,
            ...Object.fromEntries(
              changes.map(({ taskId, key, ...c }) => [key, c]),
            ),
          },
        };
      });
      return updated;
    })();
    taskRef.current = updatedTasks;
    setTasks(updatedTasks);
    setLastSaved(result.savedAt);
  }
  function recordResult(result: BatchResult, mode: Failed["mode"]) {
    if (mode === "normal") {
      setUndoStack((previous) => [...previous.slice(-49), result]);
      setRedoStack([]);
    } else if (mode === "undo") {
      setUndoStack(
        rebaseHistory(
          undoStack.slice(0, -1),
          cellsBefore(undoStack.at(-1)),
          result.cells,
        ),
      );
      setRedoStack([...redoStack, result]);
    } else {
      setRedoStack(
        rebaseHistory(
          redoStack.slice(0, -1),
          cellsBefore(redoStack.at(-1)),
          result.cells,
        ),
      );
      setUndoStack([...undoStack, result]);
    }
  }
  function submitChanges(
    build: () => CellChange[],
    mode: Failed["mode"] = "normal",
  ) {
    if (report || presentation || failedRef.current) return;
    if (pendingRef.current) {
      setError("앞선 변경을 저장 중입니다. 잠시 후 다시 적용하세요.");
      return;
    }
    const submittedBoard = boardKey.current;
    mutationEpoch.current++;
    pendingRef.current++;
    setPending(pendingRef.current);
    queue.current = queue.current.then(async () => {
      let payload: Failed["payload"] | null = null;
      try {
        if (failedRef.current) return;
        const changes = build();
        if (!changes.length) return;
        payload = { operationId: crypto.randomUUID(), changes };
        const result = await send<BatchResult>("/cells/batch", payload);
        if (boardKey.current !== submittedBoard) return;
        applyResult(result);
        recordResult(result, mode);
      } catch (err) {
        if (boardKey.current !== submittedBoard) return;
        const e = err as ApiError;
        if (payload) {
          const f = { payload, error: e, mode };
          failedRef.current = f;
          setFailed(f);
        } else setError(e.message);
      } finally {
        pendingRef.current--;
        setPending(pendingRef.current);
      }
    });
  }
  function mutate(
    points: Point[],
    transform: (t: Task, key: string) => Partial<CellChange>,
  ) {
    if (!points.length) return;
    submitChanges(() => {
      const tasksById = new Map(taskRef.current.map((t) => [t.id, t]));
      return points.map((p) => {
        const task = tasksById.get(p.taskId);
        if (!task) throw new Error("편집할 업무를 찾지 못했습니다.");
        if (!canEdit(user, task))
          throw new Error(
            "선택 범위에 편집 권한이 없는 업무가 포함되어 있습니다.",
          );
        return {
          ...p,
          expectedVersion: cell(task, p.key).version,
          ...transform(task, p.key),
        };
      });
    });
  }
  function style(part: Partial<Style>, reset = false) {
    try {
      mutate(
        selectedPoints(selection, shown, columns, MAX_STYLE_CELLS),
        (t, k) => ({
          style: reset ? {} : { ...cell(t, k).style, ...part },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function applyBorder(preset: BorderPreset, border: Border) {
    try {
      const points = selectedPoints(selection, shown, columns, MAX_STYLE_CELLS);
      const selected = new Set(points.map((p) => `${p.taskId}:${p.key}`));
      const rows = new Map(shown.map((t, i) => [t.id, i]));
      const cols = new Map(columns.map((c, i) => [c.key, i]));
      const has = (r: number, c: number) =>
        !!shown[r] &&
        !!columns[c] &&
        selected.has(`${shown[r].id}:${columns[c].key}`);
      mutate(points, (task, key) => {
        const r = rows.get(task.id)!,
          c = cols.get(key)!;
        return {
          style: applyBorderPreset(cell(task, key).style, preset, border, {
            Top: !has(r - 1, c),
            Right: !has(r, c + 1),
            Bottom: !has(r + 1, c),
            Left: !has(r, c - 1),
          }),
        };
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function edit(p: Point, initial?: string) {
    const task = source.find((t) => t.id === p.taskId);
    if (!task || report || presentation || failed) return;
    if (pendingRef.current) {
      setError("앞선 변경을 저장 중입니다. 잠시 후 편집하세요.");
      return;
    }
    if (!canEdit(user, task)) {
      setError(
        "본인의 책임·지원 업무 또는 관리 권한이 있는 업무를 선택하세요.",
      );
      return;
    }
    if (["owner", "supporters"].includes(p.key) && !isManager) {
      setError("담당자 변경은 팀 관리자에게 요청하세요.");
      return;
    }
    if (
      fields.some((f) => f.key === p.key) &&
      !viewRef.current.visibleFields.includes(p.key)
    ) {
      changeView({ visibleFields: [...viewRef.current.visibleFields, p.key] });
    }
    setSelection({ anchor: p, focus: p });
    setEditor({ point: p, initial });
  }
  // 업무 삭제·복구는 셀 저장과 겹치지 않게 저장 중 표시를 함께 쓴다.
  async function taskOperation(run: () => Promise<void>) {
    if (pendingRef.current || report || presentation) return;
    mutationEpoch.current++;
    pendingRef.current++;
    setPending(pendingRef.current);
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pendingRef.current = 0;
      setPending(0);
    }
    await refresh();
  }
  // 삭제(처음 삭제와 재실행). 실행취소 기록에 남겨 툴바 실행취소로 되살린다.
  function deleteTasks(entry: TaskDeletion, redo = false) {
    return taskOperation(async () => {
      for (const id of entry.ids) {
        const t = taskRef.current.find((task) => task.id === id);
        if (!t) throw new Error("이미 삭제되었거나 찾을 수 없는 업무입니다.");
        await send(`/tasks/${id}`, { updatedAt: t.updatedAt }, "DELETE");
      }
      setRedoStack((stack) => (redo ? stack.filter((e) => e !== entry) : []));
      setUndoStack((stack) => [
        ...stack.filter((e) => e !== entry).slice(-49),
        entry,
      ]);
      setUndoToast(null);
      setToast(`‘${entry.title}’ 업무를 삭제했습니다.`);
    });
  }
  function restoreTasks(entry: TaskDeletion) {
    return taskOperation(async () => {
      for (const id of entry.ids)
        await send(`/tasks/${id}/restore`, {}, "POST");
      setUndoStack((stack) => stack.filter((e) => e !== entry));
      setRedoStack((stack) => [...stack.filter((e) => e !== entry), entry]);
      setToast(`‘${entry.title}’ 업무를 되살렸습니다.`);
    });
  }
  function undo(redo = false) {
    const stack = redo ? redoStack : undoStack,
      entry = stack.at(-1);
    if (!entry || pending) return;
    if ("kind" in entry) {
      if (redo) deleteTasks(entry, true);
      else restoreTasks(entry);
      return;
    }
    submitChanges(
      () => {
        const tasksById = new Map(taskRef.current.map((t) => [t.id, t]));
        const afterById = new Map(
          entry.cells.map((c) => [`${c.taskId}:${c.key}`, c]),
        );
        return entry.before.map((c) => {
          const t = tasksById.get(c.taskId);
          const after = afterById.get(`${c.taskId}:${c.key}`);
          if (!t || !after || cell(t, c.key).version !== after.version)
            throw new Error(
              "이후 변경이 있어 되돌릴 수 없습니다. 변경 이력에서 확인하세요.",
            );
          return {
            taskId: c.taskId,
            key: c.key,
            ...(JSON.stringify(c.value) === JSON.stringify(after.value)
              ? {}
              : { value: c.value }),
            style: c.style,
            expectedVersion: after.version,
          };
        });
      },
      redo ? "redo" : "undo",
    );
  }
  function clearCells() {
    try {
      mutate(getPoints(), (_t, k) => ({
        value: emptyPropertyValue(properties.find((p) => p.id === k)),
      }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function paste(matrix: ClipboardMatrix) {
    if (!selection) return;
    if (selection.areas?.length) {
      setError("붙여넣을 때는 하나의 연속된 영역을 선택하세요.");
      return;
    }
    const ri = shown.findIndex((t) => t.id === selection.focus.taskId),
      ci = columns.findIndex((c) => c.key === selection.focus.key);
    if (ri < 0 || ci < 0) return;
    if (
      ri + matrix.length > shown.length ||
      matrix.some((r) => ci + r.length > columns.length)
    ) {
      setError(
        "붙여넣을 범위가 표를 벗어납니다. 행을 추가하거나 더 작은 범위를 선택하세요.",
      );
      return;
    }
    if (matrix.reduce((s, r) => s + r.length, 0) > 2000) {
      setError("한 번에 2,000개 셀까지 붙여넣을 수 있습니다.");
      return;
    }
    const changes = new Map<string, Pick<CellChange, "value" | "style">>();
    const points: Point[] = [];
    try {
      matrix.forEach((r, i) =>
        r.forEach(({ text, style }, j) => {
          const p = { taskId: shown[ri + i].id, key: columns[ci + j].key };
          let v: any = text;
          const field = fields.find((f) => f.key === p.key);
          const property = properties.find((p) => p.id === field?.key);
          if (property?.kind === "option" && text) {
            const option = property.values.find(
              (o) =>
                !o.archived &&
                (o.label === text || propertyValue(property, o) === text),
            );
            if (!option)
              throw new Error(`${property.name}에 없는 값입니다: ${text}`);
            v = propertyValue(property, option);
          }
          if (field?.type === "number") {
            if (text && !Number.isFinite(Number(text)))
              throw new Error(`${field.label} 열에는 숫자를 입력하세요.`);
            v = text === "" ? "" : Number(text);
          }
          if (property?.kind === "member") {
            const ids = text
              .split(/[,;]/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((name) => {
                const matches = selectableUsers.filter(
                  (u) => u.name === name || u.id === name,
                );
                if (matches.length !== 1)
                  throw new Error(
                    `담당자 “${name}”을 정확히 연결할 수 없습니다.`,
                  );
                return matches[0].id;
              });
            if (!property.multiple && ids.length > 1)
              throw new Error(
                `${property.name} 열에는 팀원 한 명을 선택하세요.`,
              );
            v = property.multiple ? [...new Set(ids)] : ids[0] || "";
          }
          points.push(p);
          changes.set(`${p.taskId}:${p.key}`, {
            value: v,
            ...(style ? { style } : {}),
          });
        }),
      );
      mutate(points, (t, k) => changes.get(`${t.id}:${k}`)!);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function addTask() {
    setError("");
    try {
      const { task } = await send("/tasks", {
        teamId,
        year,
        fields: view.groupBy
          ? {
              [view.groupBy]: emptyPropertyValue(
                properties.find((p) => p.id === view.groupBy),
              ),
            }
          : {},
      });
      setTasks((s) => {
        const next = [...s, task];
        taskRef.current = next;
        return next;
      });
      changeView({
        search: "",
        status: "",
        category: "",
        propertyFilters: {},
        propertyFilterModes: {},
        people: [],
        sortKey: "",
        sortDirection: "default",
        sort: "position",
      });
      setSelection({
        anchor: { taskId: task.id, key: "title" },
        focus: { taskId: task.id, key: "title" },
      });
      setEditor({ point: { taskId: task.id, key: "title" } });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function hideRows() {
    if (!range) return;
    const ranges = rangesOf(selection, shown, columns);
    const ids = shown
      .filter((_, i) => ranges.some((r) => i >= r.r1 && i <= r.r2))
      .map((t) => t.id);
    changeView({ hiddenRows: [...new Set([...view.hiddenRows, ...ids])] });
    setToast(`${ids.length}개 업무를 나의 보기에서 숨겼습니다.`);
  }
  async function reorderTask(
    taskIds: string | string[],
    targetId: string,
    placement: "before" | "after",
  ) {
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
    const byId = new Map(taskRef.current.map((t) => [t.id, t]));
    const moving = ids.map((id) => byId.get(id));
    const target = byId.get(targetId);
    if (
      !ids.length ||
      moving.some((t) => !t) ||
      !target ||
      pendingRef.current ||
      failedRef.current ||
      report ||
      presentation
    )
      return;
    const submittedBoard = boardKey.current;
    setError("");
    mutationEpoch.current++;
    pendingRef.current = 1;
    setPending(1);
    try {
      const result = await send("/tasks/reorder", {
        tasks: moving.map((t) => ({ id: t!.id, updatedAt: t!.updatedAt })),
        targetId,
        placement,
        year,
        groupBy: view.groupBy || "",
        targetUpdatedAt: target.updatedAt,
      });
      if (boardKey.current !== submittedBoard) return;
      const moved = new Map<string, Task>(
        result.tasks.map((t: Task) => [t.id, t]),
      );
      const next = taskRef.current.map((t) => moved.get(t.id) || t);
      taskRef.current = next;
      setTasks(next);
    } catch (e) {
      if (boardKey.current === submittedBoard) setError((e as Error).message);
    } finally {
      pendingRef.current = 0;
      setPending(0);
    }
    if (boardKey.current === submittedBoard) await refresh();
  }
  async function rowAction(action: string) {
    if (!rowTask) return;
    const t = rowTask;
    setRowTask(null);
    setError("");
    try {
      if (action === "hide") {
        changeView({ hiddenRows: [...new Set([...view.hiddenRows, t.id])] });
        return;
      }
      if (action === "copy") {
        await send("/tasks", {
          teamId,
          year,
          sourceId: t.id,
          fields: { title: String(value(t, "title")) + " 사본" },
        });
      }
      if (action === "delete") {
        // 확인 없이 지우고 실행취소로 되살린다.
        await deleteTasks({
          kind: "delete",
          ids: [t.id],
          title: String(value(t, "title")) || "제목 없는",
        });
        return;
      }
      if (action === "carry") {
        await send(
          `/tasks/${t.id}`,
          {
            updatedAt: t.updatedAt,
            years: [...new Set([...t.years, year + 1])],
          },
          "PATCH",
        );
        setToast(`${year + 1}년에서도 같은 업무를 조회할 수 있습니다.`);
      }
      if (action === "up" || action === "down") {
        if (view.sortKey && view.sortDirection !== "default")
          throw new Error(
            "컬럼 머리글을 우클릭하여 정렬 해제를 선택한 뒤 순서를 변경하세요.",
          );
        const order = shown.filter(
          (x) =>
            !view.groupBy || value(x, view.groupBy) === value(t, view.groupBy),
        );
        const idx = order.findIndex((x) => x.id === t.id),
          direction = action === "up" ? -1 : 1,
          neighbor = order[idx + direction];
        if (neighbor) {
          await reorderTask(
            t.id,
            neighbor.id,
            direction < 0 ? "before" : "after",
          );
        }
        return;
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function retryFailed(overwrite = false) {
    if (!failed || pendingRef.current) return;
    mutationEpoch.current++;
    pendingRef.current = 1;
    setPending(1);
    let payload = failed.payload;
    try {
      if (overwrite) {
        const d = (failed.error as ApiError).details;
        payload = {
          operationId: crypto.randomUUID(),
          changes: payload.changes.map((c) =>
            c.taskId === d?.taskId && c.key === d?.key
              ? { ...c, expectedVersion: d.current.version }
              : c,
          ),
        };
      }
      const result = await send<BatchResult>("/cells/batch", payload);
      applyResult(result);
      recordResult(result, failed.mode);
      setFailed(null);
      failedRef.current = null;
      setPanel("");
    } catch (e) {
      const next = { ...failed, payload, error: e as Error };
      setFailed(next);
      failedRef.current = next;
    } finally {
      pendingRef.current = 0;
      setPending(0);
    }
  }
  const summary = useMemo(
    () => statusSummary(tasks, settings),
    [tasks, settings],
  );
  if (!team)
    return (
      <main className="no-team">
        <Empty
          title="참여한 팀이 없습니다"
          description="시스템 관리자에게 팀 배정을 요청하세요."
          action={
            <Button
              onClick={async () => {
                await send("/auth/logout", {});
                onLogout();
              }}
            >
              로그아웃
            </Button>
          }
        />
      </main>
    );
  const hiddenCount = view.hiddenRows.length + view.hiddenWeeks.length;
  return (
    <div
      ref={workspaceRef}
      className={`workspace ${presentation ? "presentation-mode" : ""}`}
    >
      <main
        className="main-workspace"
        onKeyDown={(e) => {
          if (presentation || e.nativeEvent.isComposing || e.defaultPrevented)
            return;
          const target = e.target instanceof HTMLElement ? e.target : null;
          if (
            (e.metaKey || e.ctrlKey) &&
            !e.altKey &&
            (e.code === "KeyB" || e.key.toLowerCase() === "b") &&
            target?.closest(".sheet-scroll,.format-toolbar") &&
            !target.closest("dialog,[role=dialog]") &&
            (!target.closest("input,textarea,select,[contenteditable=true]") ||
              target.closest(".inline-editor"))
          ) {
            e.preventDefault();
            if (!e.repeat && editable && !pending)
              style({ bold: !selectedCell?.style.bold });
            return;
          }
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key.toLowerCase() === "z" &&
            e.target instanceof HTMLElement &&
            !e.target.closest("input,textarea,select,dialog")
          ) {
            e.preventDefault();
            undo(e.shiftKey);
          }
        }}
      >
        <header className="topbar">
          <div className="brand">
            <BrandMark className="brand-symbol" />
            <BrandWordmark className="brand-wordmark" />
          </div>
          <Select
            className="team-select"
            aria-label="팀 선택"
            value={teamId}
            disabled={!!pending || !!failed}
            onChange={(e) => setTeamId(e.target.value)}
          >
            {boot.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <nav className="top-navigation" aria-label="주 메뉴">
            <Button
              title="연간 업무"
              active={!report}
              onClick={() => {
                if (report) {
                  setReport(null);
                  setView(lastView.current);
                }
              }}
            >
              <CalendarDays size={15} />
              <span>연간 업무</span>
            </Button>
            <Button title="주간 보고본" onClick={() => setPanel("reports")}>
              <FileClock size={15} />
              <span>주간 보고본</span>
            </Button>
            <Button title="변경 이력" onClick={() => setPanel("history")}>
              <History size={15} />
              <span>변경 이력</span>
            </Button>
            {isManager && (
              <>
                <Button title="휴지통" onClick={() => setPanel("trash")}>
                  <Trash2 size={15} />
                  <span>휴지통</span>
                </Button>
                <Button
                  title="팀과 계정 관리"
                  onClick={() => setPanel("admin")}
                >
                  <Settings size={15} />
                  <span>관리</span>
                </Button>
              </>
            )}
          </nav>
          <div
            className={`save-status ${failed ? "failed" : ""}`}
            role="status"
          >
            {failed ? (
              <>
                <CloudOff size={14} />
                저장 실패
              </>
            ) : pending ? (
              <>
                <LoaderCircle size={14} className="spin" />
                저장 중
              </>
            ) : (
              <>
                <Check size={14} />
                {lastSaved ? "변경사항 저장됨" : "모든 변경사항 저장됨"}
              </>
            )}
          </div>
          <Button
            className="top-account"
            title="내 계정"
            onClick={() => setPanel("account")}
          >
            <Avatar user={user} small />
            <span>{user.name}</span>
          </Button>
        </header>
        <section className="page-heading">
          <div className="heading-line">
            <h1>{report ? report.name : "연간 업무"}</h1>
            <span className="year-badge">{year}</span>
            {report && (
              <span className="tag">읽기 전용 · {report.referenceDate}</span>
            )}
          </div>
          {!report && (
            <div
              className="board-summary"
              aria-label="선택한 팀·연도 전체 업무 통계"
              title="선택한 팀·연도의 전체 업무 기준입니다. 필터와 숨김 설정에 영향을 받지 않습니다."
            >
              <span>
                <i className="summary-dot" />
                전체 업무 <strong>{tasks.length}</strong>
              </span>
              {summary.map((group) => (
                <span key={group.id} data-status-summary={group.id}>
                  <i
                    className="summary-dot"
                    style={{ backgroundColor: group.color }}
                  />
                  {group.label} <strong>{group.count}</strong>
                </span>
              ))}
            </div>
          )}
          <div className="heading-actions">
            <Button
              className="presentation-start"
              title="발표 모드"
              disabled={!loaded || !!pending || !!failed || !!editor}
              onClick={() => {
                if (
                  pendingRef.current ||
                  failedRef.current ||
                  editorRef.current
                )
                  return;
                const grid =
                  workspaceRef.current?.querySelector(".sheet-scroll");
                presentationScroll.current = {
                  top: grid?.scrollTop || 0,
                  left: grid?.scrollLeft || 0,
                };
                setViewMenu(false);
                setPresentation(true);
              }}
            >
              <Presentation size={15} />
              발표 모드
            </Button>
            {report ? (
              <Button
                onClick={() => {
                  setReport(null);
                  setView(lastView.current);
                  setSelection(null);
                }}
              >
                <ArrowLeft size={16} />
                업무로 돌아가기
              </Button>
            ) : (
              <>
                {isManager && (
                  <Button onClick={() => setPanel("import")}>
                    <Upload size={15} />
                    가져오기
                  </Button>
                )}
                <Button onClick={() => setPanel("export")}>
                  <Download size={15} />
                  내보내기
                </Button>
                {user.role !== "viewer" && (
                  <Button
                    className="primary"
                    onClick={addTask}
                    disabled={!loaded || !!pending || !!failed}
                  >
                    <Plus size={17} />
                    업무 추가
                  </Button>
                )}
              </>
            )}
          </div>
        </section>
        <section className="board">
          <fieldset className="view-controls" disabled={!loaded}>
            <div className="filters date-controls" aria-label="기간 설정">
              <div className="year-control" role="group" aria-label="연도 선택">
                <Button
                  title="이전 연도"
                  disabled={!!pending || !!failed || !!report || year <= 2000}
                  onClick={() => setYear(year - 1)}
                >
                  <ChevronLeft size={15} />
                </Button>
                <Button
                  className="year-value"
                  title={`${year}년 전체 선택`}
                  aria-pressed={weeks.length === yearWeekCount}
                  onClick={() => {
                    changeView({
                      fromMonth: 1,
                      toMonth: 12,
                      fromWeek: "",
                      toWeek: "",
                      hiddenWeeks: [],
                      collapsedMonths: [],
                    });
                    setJump({ key: null, id: Date.now() });
                  }}
                >
                  {year}
                </Button>
                <Button
                  title="다음 연도"
                  disabled={!!pending || !!failed || !!report || year >= 2100}
                  onClick={() => setYear(year + 1)}
                >
                  <ChevronRight size={15} />
                </Button>
              </div>
              <PeriodPicker
                year={year}
                view={view}
                disabled={!loaded}
                onChange={(range) => {
                  changeView(range);
                  setJump({ key: null, id: Date.now() });
                }}
              />
            </div>
            <div className="view-bar" aria-label="보기 및 필터">
              <FindBar
                key={`${teamId}:${year}:${report?.id || "live"}`}
                tasks={matches}
                properties={properties}
                users={users}
                onNavigate={navigateToSearch}
              />
              {(hiddenCount > 0 || view.collapsedMonths.length > 0) && (
                <Button
                  className="quiet"
                  onClick={() =>
                    changeView({
                      hiddenRows: [],
                      hiddenWeeks: [],
                      collapsedMonths: [],
                    })
                  }
                >
                  <Eye size={14} />
                  숨김 해제
                </Button>
              )}
              <div className="view-bar-spacer" />
              <span className="visible-count">{shown.length}개 업무 표시</span>
              <div className="popover-root" ref={viewMenuRef}>
                <Button
                  className="quiet"
                  onClick={() => {
                    setViewMenu(!viewMenu);
                    refreshViews().catch((e) => setError(e.message));
                  }}
                >
                  <Bookmark size={14} />
                  저장한 보기
                  <ChevronDown size={12} />
                </Button>
                {viewMenu && (
                  <div className="popover saved-views">
                    <div className="popover-title">
                      <strong>나의 보기</strong>
                      <Button
                        title="저장한 보기 닫기"
                        onClick={() => setViewMenu(false)}
                      >
                        <X size={14} />
                      </Button>
                    </div>
                    {savedViews
                      .filter((v) => v.name !== "__current")
                      .map((v) => (
                        <div key={v.id}>
                          <button
                            onClick={() => {
                              changeView(v.data);
                              setViewMenu(false);
                            }}
                          >
                            {v.name}
                          </button>
                          <button
                            className="saved-view-delete"
                            title={`${v.name} 삭제`}
                            aria-label={`${v.name} 삭제`}
                            onClick={async () => {
                              try {
                                await api(`/views/${v.id}`, {
                                  method: "DELETE",
                                });
                                const restore = { teamId, ...v };
                                setToast("");
                                setUndoToast({
                                  message: `‘${v.name}’ 보기를 삭제했습니다.`,
                                  async undo() {
                                    setUndoToast(null);
                                    await send(
                                      "/views",
                                      {
                                        teamId: restore.teamId,
                                        name: restore.name,
                                        data: restore.data,
                                      },
                                      "PUT",
                                    );
                                    if (
                                      boardKey.current ===
                                      `${restore.teamId}:${restore.data.year}`
                                    )
                                      await refreshViews();
                                    setToast(
                                      `‘${restore.name}’ 보기를 되살렸습니다.`,
                                    );
                                  },
                                });
                                await refreshViews();
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    <Button
                      onClick={() => {
                        setSaveNameOpen(true);
                        setViewMenu(false);
                      }}
                    >
                      현재 보기 저장
                    </Button>
                  </div>
                )}
              </div>
              <Button
                title="보기 초기화"
                className="quiet"
                onClick={() => {
                  changeView(
                    normalizeView(defaultView(year), settings) as View,
                  );
                  setToast("필터와 개인 보기 설정을 초기화했습니다.");
                }}
              >
                <RotateCcw size={14} />
              </Button>
            </div>
          </fieldset>
          <Toolbar
            style={selectedCell?.style || {}}
            disabled={!editable || !!pending}
            onStyle={(s) => style(s)}
            onBorder={applyBorder}
            onReset={() => style({}, true)}
            onUndo={() => undo()}
            onRedo={() => undo(true)}
            canUndo={!!undoStack.length && !pending && !report && !failed}
            canRedo={!!redoStack.length && !pending && !report && !failed}
            onHide={hideRows}
            selectionLabel={selectionLabel}
            onCopy={async () => {
              if (!range) return;
              if (selection?.areas?.length) {
                setError("복사할 때는 하나의 연속된 영역을 선택하세요.");
                return;
              }
              try {
                await copyToSystem(
                  createClipboard(
                    shown.slice(range.r1, range.r2 + 1),
                    columns.slice(range.c1, range.c2 + 1).map((c) => c.key),
                    users,
                    settings,
                  ),
                );
                setToast("선택 셀의 내용과 서식을 복사했습니다.");
              } catch (e) {
                setError(
                  e instanceof Error && e.message.includes("2,000")
                    ? e.message
                    : "표에 초점을 두고 Ctrl/Cmd+C로 복사하세요.",
                );
              }
            }}
          />
          {(error || viewError) && (
            <div className="board-error" role="alert">
              <span>{error || viewError}</span>
              <Button
                title="알림 닫기"
                onClick={() => {
                  setError("");
                  setViewError("");
                }}
              >
                <X size={15} />
              </Button>
            </div>
          )}
          {failed && (
            <div className="board-error" role="alert">
              <CloudOff size={16} />
              <span>저장하지 못한 변경이 있습니다. {failed.error.message}</span>
              <Button onClick={() => setPanel("failed")}>입력 확인</Button>
            </div>
          )}
          {!loaded ? (
            <div className="board-loading">
              <LoaderCircle className="spin" />
              업무를 불러오는 중
            </div>
          ) : (
            <Grid
              tasks={shown}
              allTasks={matches}
              sourceTasks={source}
              columns={columns}
              columnOrder={columnOrder}
              view={view}
              user={user}
              users={users}
              selectableUsers={selectableUsers}
              selection={selection}
              settings={settings}
              editor={editor}
              onCancelEdit={() => setEditor(null)}
              onCommit={(point, v) => {
                const task = taskRef.current.find((t) => t.id === point.taskId);
                if (
                  task &&
                  JSON.stringify(cell(task, point.key).value) ===
                    JSON.stringify(v)
                ) {
                  setEditor(null);
                  return true;
                }
                if (pendingRef.current || failedRef.current) {
                  setError(
                    "앞선 변경을 처리한 뒤 저장하세요. 입력은 셀에 남아 있습니다.",
                  );
                  return false;
                }
                mutate([point], () => ({ value: v }));
                setEditor(null);
                return true;
              }}
              onSelect={setSelection}
              onEdit={edit}
              onPaste={paste}
              onClear={clearCells}
              onRowMenu={(t) => setRowTask(t)}
              onReorder={reorderTask}
              onView={changeView}
              onAdd={addTask}
              onError={setError}
              readOnly={!!report || !!failed || presentation}
              presentation={presentation}
              jump={jump}
            />
          )}
        </section>
      </main>
      {presentation && (
        <Button
          className="presentation-exit"
          title="발표 모드 종료 (Esc)"
          onClick={() => setPresentation(false)}
        >
          <Minimize2 size={15} />
          발표 종료 <kbd>Esc</kbd>
        </Button>
      )}
      {undoToast && !presentation ? (
        <div className="toast" role="status">
          <Trash2 size={16} />
          <span>{undoToast.message}</span>
          <button
            className="toast-action"
            onClick={() =>
              undoToast.undo().catch((e) => setError((e as Error).message))
            }
          >
            실행취소
          </button>
        </div>
      ) : (
        toast &&
        !presentation && (
          <div className="toast" role="status">
            <Check size={16} />
            {toast}
          </div>
        )
      )}
      {rowTask && !editor && (
        <RowPanel
          task={source.find((t) => t.id === rowTask.id) || rowTask}
          settings={settings}
          user={report ? { ...user, role: "viewer" } : user}
          users={users}
          onClose={() => setRowTask(null)}
          onEdit={(p) => {
            setRowTask(null);
            edit(p);
          }}
          onAction={rowAction}
        />
      )}
      {panel === "export" && (
        <ExportPanel
          teamId={teamId}
          year={year}
          taskIds={shown.map((t) => t.id)}
          keys={columns.map((c) => c.key)}
          onClose={() => setPanel("")}
        />
      )}
      {panel === "import" && (
        <ImportPanel
          teamId={teamId}
          year={year}
          onClose={() => setPanel("")}
          onDone={() => {
            refresh();
            refreshBoot();
            refreshViews();
            setToast("자료 가져오기를 완료했습니다.");
          }}
        />
      )}
      {panel === "reports" && (
        <ReportsPanel
          teamId={teamId}
          year={year}
          view={view}
          tasks={shown}
          user={user}
          onClose={() => setPanel("")}
          onOpen={(r) => {
            if (r.year !== year) {
              setError("보고본과 같은 연도를 선택한 뒤 열어주세요.");
              return;
            }
            lastView.current = view;
            setReport(r);
            setView(normalizeView(r.view, r.settings || team.settings) as View);
            setSelection(null);
          }}
        />
      )}
      {panel === "history" && (
        <HistoryPanel
          settings={settings}
          users={users}
          teamId={teamId}
          year={year}
          tasks={tasks}
          user={user}
          onClose={() => setPanel("")}
          onRefresh={refresh}
        />
      )}
      {panel === "trash" && (
        <TrashPanel
          teamId={teamId}
          year={year}
          onClose={() => setPanel("")}
          onRefresh={refresh}
        />
      )}
      {panel === "admin" && (
        <AdminPanel
          user={user}
          team={team}
          visibleFields={view.visibleFields}
          onVisibilitySaved={(changes) => {
            const next = new Set(viewRef.current.visibleFields);
            for (const [key, visible] of Object.entries(changes)) {
              if (visible) next.add(key);
              else if (key !== "title") next.delete(key);
            }
            changeView({ visibleFields: [...next] });
          }}
          onClose={() => setPanel("")}
          onRefresh={async () => {
            const latest = await refreshBoot();
            if (latest?.teams.some((t) => t.id === teamId)) await refresh();
          }}
        />
      )}
      {panel === "account" && (
        <AccountPanel
          user={user}
          onClose={() => setPanel("")}
          logoutDisabled={!!pending || !!failed}
          onLogout={async () => {
            if (pendingRef.current || failedRef.current) return;
            await send("/auth/logout", {});
            onLogout();
          }}
        />
      )}
      {saveNameOpen && (
        <Modal title="나의 보기 저장" onClose={() => setSaveNameOpen(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await send(
                  "/views",
                  { teamId, name: viewName, data: view },
                  "PUT",
                );
                await refreshViews();
                setSaveNameOpen(false);
                setViewName("");
                setToast("나의 보기를 저장했습니다.");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label>
              보기 이름
              <input
                autoFocus
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                required
                maxLength={60}
                placeholder="예: 나의 이번 달 업무"
              />
            </label>
            <p className="field-help">현재 필터·숨김·열 너비를 저장합니다.</p>
            <footer className="form-actions">
              <Button type="submit" className="primary">
                <Bookmark size={15} />
                저장
              </Button>
            </footer>
          </form>
        </Modal>
      )}
      {panel === "failed" && failed && (
        <Modal title="저장하지 못한 입력" wide onClose={() => setPanel("")}>
          <ErrorNote error={failed.error.message} />
          {(failed.error as ApiError).status === 401 && (
            <SessionLogin
              username={user.username}
              onSuccess={() => retryFailed(false)}
            />
          )}
          <div className="failed-input">
            <ol>
              {failed.payload.changes.map((c, i) => (
                <li key={i}>
                  <strong>
                    {String(
                      value(
                        tasks.find((t) => t.id === c.taskId) || { cells: {} },
                        "title",
                      ) || "선택 업무",
                    )}{" "}
                    / {fields.find((f) => f.key === c.key)?.label || c.key}
                  </strong>
                  <p>
                    {c.value === undefined
                      ? "내용 유지"
                      : Array.isArray(c.value)
                        ? c.value
                            .map(
                              (id) =>
                                users.find((u) => u.id === id)?.name || id,
                            )
                            .join(", ")
                        : String(c.value)}
                  </p>
                  {c.style && <small>{describeStyle(c.style)}</small>}
                </li>
              ))}
            </ol>
          </div>
          {(failed.error as ApiError).status === 409 && (
            <p>
              서버의 최신값:{" "}
              {String((failed.error as ApiError).details?.current?.value ?? "")}
            </p>
          )}
          <footer className="form-actions">
            <Button
              disabled={!!pending}
              onClick={async () => {
                if (
                  !confirm(
                    "저장되지 않은 입력을 버리고 최신 업무를 불러올까요?",
                  )
                )
                  return;
                setFailed(null);
                failedRef.current = null;
                setPanel("");
                await refresh();
              }}
            >
              입력 취소·최신 내용 보기
            </Button>
            <Button disabled={!!pending} onClick={() => retryFailed(false)}>
              다시 시도
            </Button>
            {(failed.error as ApiError).status === 409 && (
              <Button
                disabled={!!pending}
                className="primary"
                onClick={() => retryFailed(true)}
              >
                내 변경 다시 적용
              </Button>
            )}
          </footer>
        </Modal>
      )}
    </div>
  );
}
