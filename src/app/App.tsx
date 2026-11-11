import SheetSummary from "../sheet/SheetSummary";
import useSheetRowCommands from "../sheet/useSheetRowCommands";
import useSheetCellCommands from "../sheet/useSheetCellCommands";
import useSheetUndo from "../sheet/useSheetUndo";
import useSheetHistory from "../sheet/useSheetHistory";
import useSheetLayout from "../sheet/useSheetLayout";
import useSheetOperations from "../sheet/useSheetOperations";
import useTaskData from "../sheet/useTaskData";
import useSavedFilters, { type SavedFilter } from "../sheet/useSavedFilters";
import SavedFilterDialog from "../sheet/SavedFilterDialog";
import { RecentColorsProvider } from "../ui/recent-colors";
import AnnualMemoPanel from "../documents/AnnualMemoPanel";

import Calendar from "../calendar/Calendar";
import { busyProps } from "../ui/busyProps";
import Select from "../ui/Select";
import LoadingState from "../ui/LoadingState";
import SheetTabs from "../sheet/SheetTabs";
import DocumentBrowser from "../documents/DocumentBrowser";
import useWorkspaceNavigation from "./useWorkspaceNavigation";
import Insights from "../insights/Insights";
import type { TaskMetrics } from "../insights/insights-types";
import DocumentLinkPanel, {
  loadDocumentLink,
  type OpenedDocumentLink,
} from "../documents/DocumentLinkPanel";
import {
  DocumentLinkContext,
  DocumentPageTitleContext,
  UNAVAILABLE_LINK_MESSAGE,
  documentLinkFullPage,
  documentLinkKey,
  refreshDocumentLinkTitles,
  type DocumentLinkOpener,
  type DocumentLinkTarget,
} from "../documents/document-links";
import { parseDocumentLinkPath } from "../../shared/documents/document-links.js";
import useCalendarTheme from "../calendar/useCalendarTheme";
import {
  THEMES,
  getTheme,
  themeVariables,
} from "../../shared/formatting/themes.js";

import {
  changeSelection,
  changedRules,
  coversAll,
  type ChangeTargets,
} from "../sheet/selection-areas.js";

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
  ChartColumn,
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Upload,
  History,
  Trash2,
  Settings,
  CloudOff,
  Bookmark,
  X,
  Presentation,
  Pencil,
  Users,
  UserRound,
  FunnelX,
  FolderOpen,
  Moon,
  Sun,
} from "lucide-react";
import {
  api,
  send,
  ApiError,
  logout,
  refreshExternalTeam,
} from "../platform/api";
import { siteFor } from "../platform/site";
import { SiteContext, useSite } from "../platform/site-context";
import TeamSyncIndicator from "../sync/TeamSyncIndicator";
import { mergeCellUpdates } from "../sheet/cell-updates.js";
import {
  fieldsFor,
  orderColumns,
  propertiesFor,
  normalizeView,
  savedFilter,
  teamRole,
  DEFAULT_SETTINGS,
  defaultView,
  visibleWeeks,
  weeksForPeriod,
  movePeriodView,
  filteredTasks,
  cell,
  value,
  canEdit,
  canContribute,
  canManageTeam,
  isAssignable,
  todayKey,
} from "../../shared/domain.js";
import type {
  Bootstrap,
  Task,
  View,
  Selection,
  Point,
  BatchResult,
  HistoryEntry,
  SheetClone,
  SavedCell,
  Property,
  FormatRule,
} from "../types";
import { Auth } from "../auth/Auth";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Empty } from "../ui/Empty";
import { ErrorNote } from "../ui/ErrorNote";
import { SessionLogin } from "../auth/SessionLogin";
import SettingsPanel from "../settings/SettingsPanel";
import Toast, { UndoToast, useToast } from "../ui/Toast";
import useResourceSync from "../platform/useResourceSync";
import useSheetCloneDraft from "../sheet/useSheetCloneDraft";
import { BrandMark, BrandWordmark } from "../ui/Brand";
import Grid from "../sheet/Grid";
import type { Column } from "../sheet/grid-types";
import { rangeOf, rangesOf } from "../sheet/grid-selection";
import Toolbar from "../sheet/Toolbar";
import SaveStatus from "./SaveStatus";
import ActiveFilterConditions from "../sheet/ActiveFilterConditions";
import PeriodPicker from "../sheet/PeriodPicker";
import PresentationTools from "./PresentationTools";
import AccountMenu from "../auth/AccountMenu";
import ProfilePanel from "../auth/ProfilePanel";
import AccessTokens from "../auth/AccessTokens";
import FindBar from "../sheet/FindBar";

import { describeStyle } from "../sheet/history";
import {
  RowPanel,
  ExportPanel,
  ImportPanel,
  HistoryPanel,
  PasswordPanel,
} from "../Panels";

function teamUnavailableFor(
  boot: Bootstrap,
  teamId: string,
  external: boolean,
) {
  const team = boot.teams.find((team) => team.id === teamId) || boot.teams[0];
  return (
    external &&
    !!team?.status &&
    ["unconnected", "importing", "maintenance"].includes(team.status)
  );
}
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
function fullCalendarView(view: View, year: number, startMonth = 1): View {
  return {
    ...view,
    year,
    startMonth,
    fromMonth: 1,
    toMonth: 12,
    fromWeek: "",
    toWeek: "",
    hiddenWeeks: [],
    collapsedMonths: [],
  };
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
      <LoadingState className="app-loading" label="기록을 불러오고 있습니다" />
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
    <SiteContext.Provider value={siteFor(boot)}>
      <RecentColorsProvider key={boot.user.id} userId={boot.user.id}>
        <Workspace
          key={boot.user.id}
          boot={boot}
          onBootstrap={setBoot}
          onLogout={() => setBoot(null)}
        />
      </RecentColorsProvider>
    </SiteContext.Provider>
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
  const site = useSite();
  // A copied link address opens the app at /links/…: clean the address before
  // the screen route reads it, and open the target once it is found. A
  // full-page button's new tab also asks for full page (document-links.ts).
  const [deepLink] = useState(() => {
    const target = parseDocumentLinkPath(location.pathname);
    if (!target) return null;
    const fullPage = documentLinkFullPage(location.search);
    history.replaceState(history.state, "", "/");
    return { target, fullPage };
  });
  const navigation = useWorkspaceNavigation({
    canLeaveSheet: () =>
      !(
        operations.isPending() ||
        operations.failure() ||
        editorRef.current ||
        sheetCloneDraft.dirty ||
        sheetCloneDraft.saving
      ),
    async prepareAnnual(fromDocuments) {
      if (fromDocuments) {
        closeSheetCloneNow();
        await refresh();
      } else await openSheetClone(null);
    },
    onAnnualReselect: () => closeSheetClone(),
    flushLayout: () => layout.flush(),
    onPrepared(next) {
      setViewMenu(false);
      if (next === "calendar" || next === "insights") setRowTask(null);
    },
    onError: (message) => setError(message),
  });
  const {
    workspaceRoute,
    screen,
    documentBrowser,
    annualMemoRef,
    documentBrowserRef,
    calendarBusy,
    setCalendarBusy,
    insightsBusy,
    setInsightsBusy,
    workspaceNavigating,
    setWorkspaceNavigating,
    navigateWorkspace,
    openAnnualWorkspace,
    closeDocumentBrowser,
  } = navigation;
  const calendarTheme = useCalendarTheme();
  const [insightsControlsHost, setInsightsControlsHost] =
    useState<HTMLDivElement | null>(null);
  const [insightTaskTarget, setInsightTaskTarget] = useState<{
    id: string;
    year: number;
    teamId: string;
  } | null>(null);
  const [initialBoard] = useState(() => rememberedBoard(boot));
  const [teamId, setTeamId] = useState(initialBoard.teamId),
    [year, setYear] = useState(initialBoard.year),
    [view, setView] = useState<View>(defaultView(initialBoard.year) as View),
    [panel, setPanel] = useState(""),
    [rowTask, setRowTask] = useState<Task | null>(null),
    [editor, setEditor] = useState<{
      point: Point;
      initial?: string;
      task: Task;
    } | null>(null),
    [pendingEdit, setPendingEdit] = useState<{
      point: Point;
      value: SavedCell["value"];
    } | null>(null),
    [selection, setSelection] = useState<Selection | null>(null),
    [error, setError] = useState(""),
    // 삭제 알림은 해당 작업이 여전히 최근 기록일 때만 행 실행취소를 제공한다.
    [undoToast, setUndoToast] = useState<
      | ({ message: string } & (
          | { kind: "filter"; undo: () => Promise<void> }
          | { kind: "rows"; sheet: string; target: HistoryEntry | Task[] }
        ))
      | null
    >(null),
    [presentation, setPresentation] = useState(false),
    [gridZoom, setGridZoom] = useState(100),
    [viewMenu, setViewMenu] = useState(false),
    [filterNameDialog, setFilterNameDialog] = useState<{
      filter?: SavedFilter;
    } | null>(null),
    [sheetClone, setSheetClone] = useState<SheetClone | null>(null),
    [jump, setJump] = useState<{
      key: string | null;
      taskId?: string;
      id: number;
      preserveHorizontalScroll?: boolean;
      scrollTop?: number;
      nearest?: boolean;
    } | null>(null),
    // 실행취소·재실행 결과를 다음 렌더의 보이는 행·열에서 선택한다.
    [changeReveal, setChangeReveal] = useState<{
      targets: ChangeTargets;
      sheet: string;
      selected: number;
      retain: boolean;
    } | null>(null),
    [viewError, setViewError] = useState("");
  const sheetHistory = useSheetHistory();
  const {
    undoStack,
    redoStack,
    recordCells: recordResult,
    recordTask: recordTaskResult,
  } = sheetHistory;
  const layout = useSheetLayout(teamId, year, setViewError);
  const operations = useSheetOperations({
    teamId,
    year,
    startMonth: view.startMonth,
    onStart: () => taskData.invalidate(),
    onSnapshot: (tasks) => taskData.replace(tasks),
    onResult(result, mode, selected) {
      const rules = taskData.snapshot()[0]?.formatting?.rules;
      applyResult(result);
      recordResult(result, mode);
      if (mode !== "normal") revealResult(result, rules, selected);
    },
    onSettled: () => setPendingEdit(null),
    onError: setError,
  });
  const { pending, failed } = operations;
  const taskData = useTaskData({
    teamId,
    year,
    startMonth: view.startMonth,
    viewYear: view.year,
    copy: !!sheetClone,
    active: screen !== "calendar",
    available: !teamUnavailableFor(boot, teamId, site.external),
    boot,
    onBootstrap,
    blocked: () =>
      !!(
        operations.isPending() ||
        operations.failure() ||
        editorRef.current ||
        insightsBusy
      ),
    onScopeChange() {
      setSelection(null);
      setError("");
    },
    onAccessLost: () => {
      void refreshBoot();
    },
  });
  const { tasks, loaded, loadedScope, ready, taskScope, queryError, refresh } =
    taskData;
  const handleInsightsBusy = useCallback(
    (busy: boolean) => {
      if (busy) taskData.invalidate();
      setInsightsBusy(busy);
    },
    [taskData.invalidate, setInsightsBusy],
  );
  const syncConfigured = !!boot.teams.find((t) => t.id === teamId)?.sync
    ?.configured;
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        // Membership and connection settings may change in another tab, even
        // while this tab is showing a calendar, document or sheetClone.
        const before = bootJsonRef.current;
        const latest = await api<Bootstrap>("/bootstrap", {
          signal: controller.signal,
        });
        if (controller.signal.aborted || before !== bootJsonRef.current) return;
        if (JSON.stringify(latest) !== bootJsonRef.current) onBootstrap(latest);
        const configured = !!latest.teams.find((t) => t.id === teamId)?.sync
          ?.configured;
        if (site.external && configured)
          await refreshExternalTeam(teamId, configured);
      } catch {
        // Existing data views own their connection errors and retry UI.
      } finally {
        running = false;
      }
    };
    // Initial task reads and mutations already pull on the external server.
    // Only returning to an existing page needs this explicit refresh.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [teamId, site.external, onBootstrap]);
  const [toast, setToast] = useToast();
  // Details opened from document links, over whatever is open below.
  const [linkPanels, setLinkPanels] = useState<
    {
      key: string;
      link: OpenedDocumentLink;
      fullPage?: boolean;
      browserTitle?: string;
    }[]
  >([]);
  const browserTitle =
    (deepLink && linkPanels.at(-1)?.browserTitle) ||
    {
      annual: "연간 업무",
      documents: "문서",
      calendar: "캘린더",
      insights: "인사이트",
    }[workspaceRoute.route];
  useEffect(() => {
    document.title = `${browserTitle} · 그래보드`;
    return () => {
      document.title = "그래보드";
    };
  }, [browserTitle]);
  const [linkReload, setLinkReload] = useState(0);
  // "사본에서 열기" on a copy's task moves to that copy (linkNavigation).
  const [linkNavigation, setLinkNavigation] = useState<{
    target: Extract<DocumentLinkTarget, { kind: "sheet-clone-task" }>;
    teamId: string;
  } | null>(null);
  // Detail windows open now, oldest first, with their own close paths.
  const openDetails = useRef<{ key: string; close: () => Promise<boolean> }[]>(
    [],
  );
  const openingTargets = useRef(new Set<string>());
  const openLink = useRef(async (_target: DocumentLinkTarget) => {});
  const documentLinks = useMemo<DocumentLinkOpener>(
    () => ({
      register(target, close) {
        const entry = { key: documentLinkKey(target), close };
        openDetails.current.push(entry);
        return () => {
          openDetails.current = openDetails.current.filter(
            (item) => item !== entry,
          );
        };
      },
      open: (target) => openLink.current(target),
    }),
    [],
  );
  // Every link opens over the current screen; closing returns to it. A
  // target whose window is already open stays as it is.
  openLink.current = async (target) => {
    const key = documentLinkKey(target);
    if (
      openDetails.current.some((entry) => entry.key === key) ||
      openingTargets.current.has(key)
    )
      return;
    openingTargets.current.add(key);
    try {
      const link = await loadDocumentLink(target);
      if (!openDetails.current.some((entry) => entry.key === key))
        setLinkPanels((panels) =>
          panels.some((panel) => panel.key === key)
            ? panels
            : [...panels, { key, link }],
        );
    } finally {
      openingTargets.current.delete(key);
    }
  };
  // Leaves the open windows through their own save paths, topmost first,
  // then moves to the copy and opens the task there.
  async function openInSheetClone(
    target: Extract<DocumentLinkTarget, { kind: "sheet-clone-task" }>,
    teamId: string,
  ) {
    for (const entry of [...openDetails.current].reverse())
      if (!(await entry.close())) return;
    if (annualMemoRef.current && !(await annualMemoRef.current.flush())) return;
    setLinkNavigation({ target, teamId });
  }
  // A link address has no screen to return to: open over the target's team,
  // and over the calendar for an entry.
  useEffect(() => {
    if (!deepLink) return;
    let active = true;
    loadDocumentLink(deepLink.target).then(
      (link) => {
        if (!active) return;
        const target =
          link.kind === "task"
            ? link.task.teamId
            : link.kind === "calendar"
              ? link.entry.teamId
              : link.kind === "memo"
                ? link.teamId
                : link.task.teamId;
        if (boot.teams.some((team) => team.id === target)) setTeamId(target);
        if (link.kind === "calendar") workspaceRoute.commit("calendar", true);
        setLinkPanels([
          {
            key: documentLinkKey(deepLink.target),
            link,
            fullPage: deepLink.fullPage,
          },
        ]);
      },
      (e) => {
        if (active) setError((e as Error).message);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  function closeLinkPanel(key: string) {
    setLinkPanels((panels) => panels.filter((panel) => panel.key !== key));
    // The detail may have renamed its target or changed what is shown below.
    refreshDocumentLinkTitles();
    setLinkReload((value) => value + 1);
    if (screen === "annual" && !documentBrowser) void refresh();
  }
  const currentTeam = useRef(teamId);
  currentTeam.current = teamId;
  const sheetCloneRef = useRef(sheetClone);
  sheetCloneRef.current = sheetClone;
  const savedSheetCloneDocuments = useRef({
    sheetCloneId: "",
    sequence: 0,
    tasks: new Map<
      string,
      { sequence: number; hasDocument: boolean; documentCount: number }
    >(),
  });
  const calendarNavigation = useRef<{
    teamId: string;
    year: number;
    view?: View;
  } | null>(null);
  const team = boot.teams.find((t) => t.id === teamId) || boot.teams[0];
  useEffect(() => {
    if (
      !insightTaskTarget ||
      workspaceRoute.route !== "annual" ||
      !ready ||
      year !== insightTaskTarget.year ||
      teamId !== insightTaskTarget.teamId
    )
      return;
    const task = tasks.find((task) => task.id === insightTaskTarget.id);
    setInsightTaskTarget(null);
    if (task) setRowTask(task);
    else setError("업무를 찾을 수 없습니다.");
  }, [insightTaskTarget, workspaceRoute.route, ready, tasks, year, teamId]);
  const teamUnavailable = teamUnavailableFor(boot, teamId, site.external);
  // Cell positions are shared only between people on the same internal server.
  const presenceTeamId =
    !site.external &&
    !sheetClone &&
    !presentation &&
    !teamUnavailable &&
    workspaceRoute.route === "annual"
      ? teamId
      : null;
  const sheetCloneDraft = useSheetCloneDraft(teamId, user.id);
  const editingSheetClone =
    !!sheetClone && sheetCloneDraft.draft?.sheetClone.id === sheetClone.id;
  const addTaskLabel = sheetClone ? "사본에 업무 추가" : "업무 추가";
  const viewYear = sheetClone ? view.year : year;
  // 화면 테마는 사본을 포함한 모든 보기에서 현재 팀 설정을 따른다.
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
  const users = useMemo(() => {
    if (!sheetClone) return boot.users;
    if (!editingSheetClone) return sheetClone.users;
    return [
      ...new Map([
        ...boot.users
          .filter((u) => isAssignable(u, teamId))
          .map((u) => [u.id, u] as const),
        ...sheetClone.users.map((u) => [u.id, u] as const),
      ]).values(),
    ];
  }, [sheetClone, editingSheetClone, boot.users, teamId]);
  const assignableUsers = useMemo(
    () => (sheetClone ? users : users.filter((u) => isAssignable(u, teamId))),
    [sheetClone, users, teamId],
  );
  const canManage = canManageTeam(user, teamId);
  const canManageFilters = teamRole(user, teamId) === "lead";
  const canAdd = canContribute(user, teamId);
  // 지금 보는 팀이 아니어도 팀장인 팀이 있으면 설정을 열 수 있다.
  const canOpenSettings =
    user.systemRole === "admin" ||
    Object.values(user.teamRoles).includes("lead");
  const settings = sheetClone?.settings || team?.settings || DEFAULT_SETTINGS;
  const fields = useMemo(() => fieldsFor(settings), [settings]);
  const properties = useMemo(
    () => propertiesFor(settings) as Property[],
    [settings],
  );
  const bootJsonRef = useRef(""),
    workspaceRef = useRef<HTMLDivElement>(null),
    viewMenuRef = useRef<HTMLDivElement>(null),
    presentationScroll = useRef<{ top: number; left: number } | null>(null),
    sheetCloneScroll = useRef<{ top: number; left: number } | null>(null),
    viewRef = useRef(view),
    editorRef = useRef(editor),
    lastView = useRef(view),
    boardKey = useRef(""),
    // 복사를 거절한 안내. 다음 복사가 성공하면 이 안내만 지운다.
    copyError = useRef(""),
    // 표나 찾기로 선택을 바꾸면 늘어난다. 그 뒤 끝난 실행취소는 선택을 옮기지 않는다.
    selectionEpoch = useRef(0);
  const filters = useSavedFilters({
    teamId,
    userId: user.id,
    enabled: !teamUnavailable,
    ready,
    copy: !!sheetClone,
    settings,
    onError: setViewError,
    onNotify: setToast,
    onDefinitionChange(data) {
      if (sheetCloneRef.current)
        lastView.current = { ...lastView.current, ...data };
      else {
        viewRef.current = { ...viewRef.current, ...data };
        setView(viewRef.current);
      }
    },
  });
  const {
    filters: savedFilters,
    active: activeSavedFilter,
    notice: filterUpdateNotice,
    deletingId: deletingFilterId,
  } = filters;
  function editTasks() {
    return sheetCloneRef.current
      ? sheetCloneDraft.ref.current?.tasks || sheetCloneRef.current.tasks
      : taskData.snapshot();
  }
  async function prepareCopySwitch() {
    if (annualMemoRef.current && !(await annualMemoRef.current.flush()))
      throw new Error("메모 저장을 마친 뒤 전환해 주세요.");
    if (editorRef.current || operations.isPending() || operations.failure())
      throw new Error("현재 셀 입력과 저장을 마친 뒤 전환해 주세요.");
    if (sheetCloneDraft.ref.current) await sheetCloneDraft.save();
  }
  async function openSheetClone(id: string | null) {
    if (
      currentTeam.current !== teamId ||
      id === (sheetCloneRef.current?.id || null)
    )
      return;
    const scope = boardKey.current;
    await prepareCopySwitch();
    if (!id) {
      closeSheetCloneNow();
      return;
    }
    const r = await api<SheetClone>(`/sheet-clones/${id}`);
    if (currentTeam.current !== teamId || boardKey.current !== scope) return;
    if (!sheetCloneRef.current) {
      lastView.current = viewRef.current;
      const grid = workspaceRef.current?.querySelector(".sheet-scroll");
      sheetCloneScroll.current = {
        left: grid?.scrollLeft || 0,
        top: grid?.scrollTop || 0,
      };
    }
    layout.flush();
    rowCommands.clearCopiedRow();
    setRowTask(null);
    setViewMenu(false);
    setError("");
    setJump(null);
    filters.enterCopy();
    const next = normalizeView(r.view, r.settings || team.settings) as View;
    sheetCloneRef.current = r;
    setSheetClone(r);
    sheetCloneDraft.begin(r);
    viewRef.current = next;
    setView(next);
    setSelection(null);
  }
  useEffect(() => {
    const saved = sheetCloneDraft.draft?.sheetClone;
    if (saved && saved.id === sheetCloneRef.current?.id) {
      sheetCloneRef.current = saved;
      setSheetClone(saved);
    }
  }, [sheetCloneDraft.draft?.sheetClone]);
  useLayoutEffect(() => {
    const grid =
      workspaceRef.current?.querySelector<HTMLElement>(".sheet-scroll");
    if (!grid || !ready) return;
    if (sheetClone) grid.scrollTo(0, 0);
    else if (sheetCloneScroll.current) {
      grid.scrollTo(
        sheetCloneScroll.current.left,
        sheetCloneScroll.current.top,
      );
      sheetCloneScroll.current = null;
    }
  }, [sheetClone?.id, ready]);
  // "사본에서 열기" moves to the copy's team and sheet one step per render,
  // then opens the copy's task detail.
  const linkStep = useRef({ navigation: linkNavigation, step: "" });
  useEffect(() => {
    const navigation = linkNavigation;
    if (linkStep.current.navigation !== navigation)
      linkStep.current = { navigation, step: "" };
    if (!navigation) return;
    const { target } = navigation;
    const stop = (message = "") => {
      setLinkNavigation(null);
      if (message) setError(message);
    };
    // The calendar stays busy until its closed window has rendered away.
    if (workspaceRoute.route !== "annual") {
      if (calendarBusy || insightsBusy || linkStep.current.step === "route")
        return;
      linkStep.current.step = "route";
      void workspaceRoute.navigate("annual").then((moved) => {
        if (!moved) stop();
      });
      return;
    }
    if (teamId !== navigation.teamId) {
      if (linkStep.current.step === "team") return stop();
      linkStep.current.step = "team";
      setTeamId(navigation.teamId);
      return;
    }
    // The board of this team, not the one being replaced.
    if (!loaded || loadedScope !== taskScope) return;
    if (sheetClone?.id !== target.sheetCloneId) {
      if (linkStep.current.step === "sheet") return;
      linkStep.current.step = "sheet";
      openSheetClone(target.sheetCloneId).catch((e) =>
        stop((e as Error).message),
      );
      return;
    }
    setLinkNavigation(null);
    const task = sheetClone.tasks.find((item) => item.id === target.id);
    if (task) setRowTask(task);
    else setError(UNAVAILABLE_LINK_MESSAGE);
  }, [
    linkNavigation,
    workspaceRoute.route,
    calendarBusy,
    insightsBusy,
    teamId,
    loaded,
    loadedScope,
    taskScope,
    sheetClone?.id,
  ]);
  function closeSheetCloneNow() {
    if (!sheetCloneRef.current) return;
    sheetCloneDraft.cancel();
    sheetCloneRef.current = null;
    setSheetClone(null);
    viewRef.current = lastView.current;
    setView(lastView.current);
    filters.leaveCopy();
    setSelection(null);
    setJump(null);
  }
  function closeSheetClone() {
    void openSheetClone(null).catch((e) => setError(e.message));
  }
  async function refreshSheet() {
    const current = sheetCloneRef.current;
    if (!current) {
      await refresh();
      return;
    }
    const latest = await api<SheetClone>(`/sheet-clones/${current.id}`);
    if (sheetCloneRef.current?.id !== current.id) return;
    sheetCloneRef.current = latest;
    setSheetClone(latest);
    sheetCloneDraft.begin(latest);
    const next = normalizeView(
      latest.view,
      latest.settings || team.settings,
    ) as View;
    viewRef.current = next;
    setView(next);
    setSelection(null);
  }
  async function deleteSheetClones(ids: string[]) {
    await prepareCopySwitch();
    await api("/sheet-clones", {
      method: "DELETE",
      body: JSON.stringify({ teamId, ids }),
    });
    if (sheetCloneRef.current && ids.includes(sheetCloneRef.current.id))
      closeSheetCloneNow();
  }
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
      // Let the topmost dialog handle Escape before leaving presentation mode.
      if (workspaceRef.current?.querySelector("dialog:modal")) return;
      if (
        e.target instanceof Element &&
        e.target.closest(".presentation-toolbar input")
      )
        return;
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
    if (
      (!teamId && boot.teams.length) ||
      (teamId && !boot.teams.some((t) => t.id === teamId))
    ) {
      boardKey.current = "";
      layout.cancel();
      setEditor(null);
      editorRef.current = null;
      operations.clearFailure();
      setError("");
      setViewError("");
      setTeamId(boot.teams[0]?.id || "");
    }
  }, [boot.teams, teamId]);
  useEffect(() => {
    bootJsonRef.current = JSON.stringify(boot);
  }, [boot]);
  viewRef.current = view;
  editorRef.current = editor;
  const undoToastCurrent =
    undoToast?.kind !== "rows" ||
    (undoToast.sheet === `${teamId}:${year}:${sheetClone?.id || "original"}` &&
      undoToast.target ===
        (sheetClone
          ? sheetCloneDraft.draft?.history[sheetCloneDraft.draft.cursor]
          : undoStack.at(-1)));
  useEffect(() => {
    if (!undoToastCurrent) setUndoToast(null);
  }, [undoToastCurrent]);
  useEffect(() => {
    if (undoToast) {
      const timer = setTimeout(() => setUndoToast(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [undoToast]);
  // 저장된 필터 팝업은 바깥을 누르거나 Esc로 닫는다. 실행취소 알림은
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
  useResourceSync(
    screen !== "calendar" && ready && !teamUnavailable
      ? sheetClone
        ? `/sheet-clones/${sheetClone.id}`
        : `/teams/${teamId}`
      : null,
    async (signal) => {
      const current = sheetCloneRef.current;
      if (!current) return (await refresh(signal)) !== false;
      if (
        operations.isPending() ||
        operations.failure() ||
        editorRef.current ||
        sheetCloneDraft.saving ||
        !!sheetCloneDraft.error
      )
        return false;
      try {
        const before = sheetCloneDraft.ref.current?.sheetClone;
        const remote = await api<SheetClone>(`/sheet-clones/${current.id}`, {
          signal,
        });
        if (signal.aborted || sheetCloneRef.current?.id !== current.id)
          return true;
        if (sheetCloneDraft.ref.current?.sheetClone !== before) return false;
        return sheetCloneDraft.receive(remote);
      } catch (error) {
        if (
          error instanceof ApiError &&
          [401, 403, 404].includes(error.status)
        ) {
          setError(error.message);
          return true;
        }
        throw error;
      }
    },
  );
  useEffect(() => {
    setFilterNameDialog(null);
  }, [teamId, user.id, teamUnavailable]);
  useEffect(() => {
    if (!teamId || teamUnavailable) return;
    const key = `${teamId}:${year}`;
    let cancelled = false;
    let loadingTasks = false;
    const controller = new AbortController();
    boardKey.current = key;
    setError("");
    setViewError("");
    setSelection(null);
    setSheetClone(null);
    sheetCloneDraft.cancel();
    sheetCloneScroll.current = null;
    sheetHistory.reset();
    setPendingEdit(null);
    rowCommands.clearCopiedRow();
    setJump(null);
    const navigation = calendarNavigation.current;
    calendarNavigation.current = null;
    Promise.all([
      api(`/views?teamId=${teamId}&year=${year}`, {
        signal: controller.signal,
      }),
      filters.waitForLoad(),
    ])
      .then(async ([v]) => {
        if (cancelled || boardKey.current !== key) return;
        const storedLayout = v.views.find((s: any) => s.name === "__current");
        const restored = storedLayout?.data || defaultView(year);
        const target =
          navigation && navigation.teamId === teamId && navigation.year === year
            ? navigation
            : null;
        let current = target
          ? target.view || fullCalendarView(restored, year)
          : restored;
        current = normalizeView(
          { ...current, ...filters.snapshot().data },
          team?.settings || DEFAULT_SETTINGS,
        ) as View;
        setView(current);
        viewRef.current = current;
        loadingTasks = true;
        if (!(await taskData.initialize(current.startMonth, controller.signal)))
          return;
        setJump({ key: null, id: Date.now() });
        if (target || !storedLayout) changeView(current);
      })
      .catch((e) => {
        if (!cancelled && boardKey.current === key) {
          taskData.failInitial(loadingTasks ? e : undefined);
          if (!loadingTasks) setError(e.message);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      boardKey.current = "";
      layout.flush();
    };
  }, [teamId, year, teamUnavailable]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      layout.flush();
      if (
        operations.isPending() ||
        operations.failure() ||
        editorRef.current ||
        sheetCloneDraft.ref.current?.cursor ||
        filters.hasPending() ||
        layout.hasPending()
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("pagehide", layout.flush);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("pagehide", layout.flush);
    };
  }, []);
  function changeView(part: Partial<View>, updateSelectedFilter = false) {
    setSelection(null);
    setViewError("");
    const next = { ...viewRef.current, ...part };
    if ("propertyFilters" in part || "propertyFilterModes" in part)
      filters.change(next, viewRef.current, updateSelectedFilter);
    viewRef.current = next;
    setView(next);
    if (sheetClone && canAdd) sheetCloneDraft.changeView(next);
    if (
      !sheetClone &&
      Object.keys(part).some(
        (key) => !["propertyFilters", "propertyFilterModes"].includes(key),
      )
    ) {
      layout.save(next);
    }
  }

  async function moveYear(direction: -1 | 1) {
    if (annualMemoRef.current && !(await annualMemoRef.current.flush())) return;
    if (
      !ready ||
      insightsBusy ||
      operations.isPending() ||
      operations.failure() ||
      editorRef.current
    )
      return;
    const current = viewRef.current;
    const nextYear =
      direction === -1 && current.startMonth > 1
        ? viewYear
        : viewYear + direction;
    if (nextYear < 2000 || nextYear > 2100) return;
    const next = fullCalendarView(current, nextYear);
    if (sheetClone || nextYear === year) changeView(next);
    else {
      layout.flush();
      // Restore this year's personal layout, but always show January–December.
      calendarNavigation.current = { teamId, year: nextYear };
      setView(next);
      setYear(nextYear);
    }
    setJump({ key: null, id: Date.now() });
  }
  async function moveCalendar(direction: -1 | 1) {
    if (annualMemoRef.current && !(await annualMemoRef.current.flush())) return;
    if (
      !ready ||
      insightsBusy ||
      operations.isPending() ||
      operations.failure() ||
      editorRef.current
    )
      return;
    const current = viewRef.current;
    const offset = current.startMonth - 1 + direction;
    const nextYear = viewYear + Math.floor(offset / 12);
    const startMonth = (((offset % 12) + 12) % 12) + 1;
    if (
      nextYear < 2000 ||
      nextYear > 2100 ||
      (nextYear === 2100 && startMonth > 1)
    )
      return;
    const next = movePeriodView(current, nextYear, startMonth);
    if (!sheetClone && nextYear !== year) {
      layout.flush();
      calendarNavigation.current = { teamId, year: nextYear, view: next };
      setView(next);
      setYear(nextYear);
    } else changeView(next);
    setJump({ key: null, id: Date.now() });
  }
  useEffect(() => {
    if (!ready || sheetClone) return;
    const next = normalizeView(viewRef.current, settings) as View;
    const memberIds = new Set(assignableUsers.map((u) => u.id));
    for (const property of properties.filter((p) => p.kind === "member")) {
      const values = next.propertyFilters?.[property.id];
      if (values && next.propertyFilters)
        next.propertyFilters[property.id] = values.filter(
          (id) => id === "" || memberIds.has(id),
        );
    }
    if (JSON.stringify(next) !== JSON.stringify(viewRef.current))
      changeView(next);
    // 저장된 보기를 불러온 뒤에도 돌아야 하므로 view도 의존성에 둔다.
  }, [settings, ready, sheetClone, boot.users, teamId, view]);
  function applySavedFilter(filter: SavedFilter, { scrollToTop = true } = {}) {
    const data = savedFilter(filter.data, settings);
    changeView({
      propertyFilters: data.propertyFilters,
      propertyFilterModes: data.propertyFilterModes,
    });
    filters.select(filter.id);
    setViewMenu(false);
    if (scrollToTop)
      setJump((previous) => ({
        key: null,
        id: Math.max(Date.now(), (previous?.id || 0) + 1),
        preserveHorizontalScroll: true,
        scrollTop: 0,
      }));
  }
  function clearFilters() {
    changeView({ propertyFilters: {}, propertyFilterModes: {} });
    filters.select("");
    setViewMenu(false);
    viewMenuRef.current
      ?.querySelector<HTMLButtonElement>(".saved-filter-trigger")
      ?.focus({ preventScroll: true });
  }
  function renameFilter(filter: SavedFilter) {
    if (!filter.canEdit) return;
    setFilterNameDialog({ filter });
    setViewMenu(false);
  }
  async function deleteFilter(filter: SavedFilter) {
    try {
      const deleted = await filters.remove(filter);
      if (!deleted) return;
      setToast("");
      setUndoToast({
        kind: "filter",
        message: deleted.message,
        async undo() {
          setUndoToast(null);
          await deleted.undo();
        },
      });
    } catch (e) {
      if (currentTeam.current === teamId) setError((e as Error).message);
    }
  }
  const allTasks = useMemo(() => {
    if (sheetClone) return sheetCloneDraft.draft?.tasks || sheetClone.tasks;
    if (!pendingEdit) return tasks;
    const { point, value } = pendingEdit;
    // 편집창을 닫는 렌더에서 확정한 값을 바로 표시한다. 서버 버전과
    // 저장 원본은 tasks에 유지해 충돌 검사·실행취소에 그대로 사용한다.
    return tasks.map((task) =>
      task.id === point.taskId
        ? {
            ...task,
            cells: {
              ...task.cells,
              [point.key]: { ...cell(task, point.key), value },
            },
          }
        : task,
    );
  }, [tasks, sheetClone, sheetCloneDraft.draft, pendingEdit]);
  // 행 높이·열 너비 같은 표시 설정이 바뀔 때는 업무를 다시 거르지 않는다.
  const filterView = useMemo(
    () => view,
    [
      view.propertyFilters,
      view.propertyFilterModes,
      view.groupBy,
      view.sortKey,
      view.sortDirection,
    ],
  );
  // 필터를 통과한 업무(숨긴 행 포함) → 그중 화면에 보이는 업무.
  const matchingTasks = useMemo(() => {
    // While typing, evaluate this row's filter/sort against the edit baseline.
    // Remote changes must not unmount the editor or discard an IME draft.
    const active = editor && allTasks.find((t) => t.id === editor.point.taskId);
    const source =
      active && editor
        ? allTasks.map((t) => (t.id === active.id ? editor.task : t))
        : allTasks;
    const matching = filteredTasks(
      source,
      filterView,
      settings,
      users,
    ) as Task[];
    return active
      ? matching.map((t) => (t.id === active.id ? active : t))
      : matching;
  }, [allTasks, filterView, settings, users, editor]);
  const visibleTasks = useMemo(() => {
    const hidden = new Set(view.hiddenRows);
    return matchingTasks.filter((t) => !hidden.has(t.id));
  }, [matchingTasks, view.hiddenRows]);
  function navigateToSearch(point: Point) {
    const current = viewRef.current;
    if (!current.visibleFields.includes(point.key)) return;
    const reveal: Partial<View> = {};
    if (current.hiddenRows.includes(point.taskId))
      reveal.hiddenRows = current.hiddenRows.filter(
        (id) => id !== point.taskId,
      );
    if (Object.keys(reveal).length) changeView(reveal);
    selectionEpoch.current++;
    setSelection({ anchor: point, focus: point });
    setJump((previous) => ({
      ...point,
      id: Math.max(Date.now(), (previous?.id || 0) + 1),
    }));
  }
  // 보기의 다른 설정(행 높이·열 너비 등)이 바뀔 때 열 객체를 새로 만들지 않는다.
  const weeks = useMemo(
    () => visibleWeeks(viewYear, view),
    [
      viewYear,
      view.startMonth,
      view.fromWeek,
      view.toWeek,
      view.fromMonth,
      view.toMonth,
      view.hiddenWeeks,
      view.collapsedMonths,
    ],
  );
  const periodWeeks = useMemo(
    () => weeksForPeriod(viewYear, view.startMonth),
    [viewYear, view.startMonth],
  );
  const yearWeekCount = periodWeeks.length;
  const columnOrder = useMemo(
    () => orderColumns(fields, periodWeeks),
    [fields, periodWeeks],
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
  function retainSheetCloneSelection(source: Task[]) {
    const currentView = viewRef.current;
    const hidden = new Set(currentView.hiddenRows);
    const visible = (
      filteredTasks(source, currentView, settings, users) as Task[]
    ).filter((task) => !hidden.has(task.id));
    const taskIds = new Set(visible.map((task) => task.id));
    const keys = new Set(columns.map((column) => column.key));
    const available = (point: Point) =>
      taskIds.has(point.taskId) && keys.has(point.key);
    // 사본 수정 진입·실행취소 후에도 서식을 계속 적용할 수 있게 한다.
    if (
      selection &&
      [selection, ...(selection.areas || [])].every(
        (area) => available(area.anchor) && available(area.focus),
      )
    )
      return;
    const point =
      visible[0] && columns[0]
        ? { taskId: visible[0].id, key: columns[0].key }
        : null;
    setSelection(point ? { anchor: point, focus: point } : null);
    if (point)
      setJump((previous) => ({
        ...point,
        id: Math.max(Date.now(), (previous?.id || 0) + 1),
      }));
  }
  const sheetKey = `${teamId}:${year}:${sheetClone?.id || "original"}`;
  function revealChange(
    targets: ChangeTargets,
    selected: number,
    retain = false,
  ) {
    setChangeReveal({ targets, sheet: sheetKey, selected, retain });
  }
  function revealResult(
    result: BatchResult,
    rules: FormatRule[] | undefined,
    selected: number,
  ) {
    revealChange(
      {
        cells: result.cells,
        rules: result.formatting
          ? changedRules(rules, result.formatting.rules)
          : [],
      },
      selected,
    );
  }
  // 되돌린 셀·행을 선택하고 화면 밖이면 그 위치로 옮긴다. 보이는 대상이 없으면
  // 선택을 그대로 둔다.
  useLayoutEffect(() => {
    if (!changeReveal) return;
    setChangeReveal(null);
    if (
      changeReveal.sheet !== sheetKey ||
      changeReveal.selected !== selectionEpoch.current
    )
      return;
    const next = changeSelection(changeReveal.targets, visibleTasks, columns);
    if (!next) {
      if (changeReveal.retain) retainSheetCloneSelection(allTasks);
      return;
    }
    const grid =
      workspaceRef.current?.querySelector<HTMLElement>(".sheet-scroll");
    const active = document.activeElement;
    const focused =
      !!grid && (!active || active === document.body || grid.contains(active));
    const target = next.jump;
    // 현재 선택이 바뀐 셀을 모두 담고 있으면 선택은 두고 위치만 옮긴다.
    if (
      !selection ||
      !coversAll(
        rangesOf(selection, visibleTasks, columns),
        rangesOf(next.selection, visibleTasks, columns),
      )
    )
      setSelection(next.selection);
    if (target)
      setJump((previous) => ({
        ...target,
        nearest: true,
        id: Math.max(Date.now(), (previous?.id || 0) + 1),
      }));
    // 단축키로 되돌렸거나 저장 중 잠긴 버튼에서 포커스가 사라졌으면 표에 두어
    // 새 선택에서 바로 방향키를 쓸 수 있게 한다. 다른 입력칸의 포커스는 그대로 둔다.
    if (focused)
      requestAnimationFrame(() => {
        if (grid && !grid.contains(document.activeElement))
          grid.focus({ preventScroll: true });
      });
  }, [changeReveal]);
  // 서식 범위는 숨김 전 행·열 순서로 계산한다. 값 편집·복사는 보이는 셀만 사용한다.
  const range = rangeOf(selection, matchingTasks, columnOrder);
  const count = range
    ? (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
    : 0;
  const selectedTask = selection
    ? allTasks.find((t) => t.id === selection.focus.taskId)
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
          ? `${visibleTasks.findIndex((t) => t.id === selection!.focus.taskId) + 1}행 · ${columns.find((c) => c.key === selection!.focus.key)?.label}`
          : count
            ? `${count.toLocaleString()}개 셀`
            : "";
  const editable =
    !!selectedTask &&
    (sheetClone ? canAdd : canEdit(user, selectedTask)) &&
    (!sheetClone || editingSheetClone) &&
    !failed;

  const rowCommands = useSheetRowCommands({
    teamId,
    year,
    user,
    view,
    properties,
    ready,
    canAdd,
    presentation,
    sheetClone,
    editingSheetClone,
    taskData,
    operations,
    sheetCloneDraft,
    recordTaskResult,
    refresh,
    editTasks,
    visibleTasks,
    selection,
    selectionEpoch,
    editorRef,
    rowTask,
    changeView,
    setSelection,
    setEditor,
    setJump,
    setRowTask,
    setError,
    setToast,
    setUndoToast,
    revealChange,
  });
  const {
    copiedRow,
    deleteTasks,
    restoreTasks,
    addTask,
    reorderTask,
    documentsForSheetCloneRows,
    rowCommand,
    detailAction,
  } = rowCommands;
  const cellCommands = useSheetCellCommands({
    teamId,
    year,
    user,
    canAdd,
    presentation,
    sheetClone,
    editingSheetClone,
    operations,
    sheetCloneDraft,
    editTasks,
    selection,
    selectionEpoch,
    editorRef,
    setSelection,
    setEditor,
    setError,
    changeView,
    allTasks,
    matchingTasks,
    visibleTasks,
    columns,
    columnOrder,
    fields,
    properties,
    assignableUsers,
    viewRef,
    editor,
    workspaceRef,
    editable,
    pending,
    failed,
    range,
    count,
    screen,
  });
  const {
    formatBrush,
    submitChanges,
    mutate,
    applyStyle,
    copyFormat,
    paintFormat,
    applyBorder,
    beginEdit,
    clearCells,
    paste,
  } = cellCommands;
  const undo = useSheetUndo({
    sheetClone,
    editingSheetClone,
    canAdd,
    presentation,
    editorRef,
    sheetCloneDraft,
    selectionEpoch,
    documentsForSheetCloneRows,
    setError,
    revealChange,
    visibleTasks,
    selection,
    setRowTask,
    redoStack,
    undoStack,
    operations,
    deleteTasks,
    restoreTasks,
    submitChanges,
    taskData,
    teamId,
  });

  function applyResult(result: BatchResult) {
    const updatedTasks = mergeCellUpdates(taskData.snapshot(), result);

    taskData.replace(updatedTasks);
    // Formatting one's own cell while typing advances its version without
    // changing the draft. Remote operations must never advance this baseline.
    let editing = editorRef.current;
    if (editing) {
      if (
        result.formatting &&
        result.formatTeamId === editing.task.teamId &&
        result.formatting.revision > (editing.task.formatting?.revision ?? 0)
      ) {
        const next = {
          ...editing,
          task: { ...editing.task, formatting: result.formatting },
        };
        editorRef.current = next;
        setEditor(next);
        editing = next;
      }
      const p = editing.point,
        baseline = cell(editing.task, p.key);
      const before = result.before.find(
        (c) => c.taskId === p.taskId && c.key === p.key,
      );
      const after = result.cells.find(
        (c) => c.taskId === p.taskId && c.key === p.key,
      );
      if (
        before?.version === baseline.version &&
        after &&
        JSON.stringify(after.value) === JSON.stringify(baseline.value)
      ) {
        const next = {
          ...editing,
          task: {
            ...editing.task,
            cells: { ...editing.task.cells, [p.key]: after },
          },
        };
        editorRef.current = next;
        setEditor(next);
      }
    }
  }

  async function retryFailed(overwrite = false) {
    if (await operations.retry(overwrite, selectionEpoch.current)) setPanel("");
  }
  if (!team)
    return (
      <main>
        <Empty
          title="참여한 팀이 없습니다"
          description="시스템 관리자에게 팀 배정을 요청하세요."
          action={
            <Button
              onClick={async () => {
                if (await logout()) onLogout();
              }}
            >
              로그아웃
            </Button>
          }
        />
        {user.systemRole === "admin" && (
          <Button onClick={() => setPanel("settings")}>설정</Button>
        )}
        {panel === "settings" && (
          <SettingsPanel
            user={user}
            teams={boot.teams}
            users={boot.users}
            onClose={() => setPanel("")}
            onRefresh={refreshBoot}
          />
        )}
      </main>
    );

  async function openInsightTask(metric: TaskMetrics) {
    // Rolling calendars already contain next-year tasks. Opening their detail
    // must keep the shared calendar and week selection instead of resetting it.
    const targetYear =
      taskData.snapshot().some((task) => task.id === metric.task.id) ||
      metric.task.years.includes(year)
        ? year
        : metric.task.years[0];
    if (!(await workspaceRoute.navigate("annual"))) return;
    if (targetYear !== year) setYear(targetYear);
    else await refresh();
    setInsightTaskTarget({ id: metric.task.id, year: targetYear, teamId });
  }
  // Both original-board views use these exact elements and View handlers.
  const annualHeading = (
    <section className="page-heading">
      <div className="heading-line">
        <h1>{sheetClone ? sheetClone.name : "연간 업무"}</h1>
        <span className="year-badge">{viewYear}</span>
      </div>
      {!sheetClone && <SheetSummary tasks={tasks} settings={settings} />}
      <Button
        className="insights-toggle"
        tooltip="인사이트"
        active={screen === "insights"}
        aria-pressed={screen === "insights"}
        disabled={
          insightsBusy ||
          !ready ||
          workspaceNavigating ||
          !!pending ||
          !!failed ||
          !!editor ||
          sheetCloneDraft.dirty ||
          sheetCloneDraft.saving
        }
        onClick={() =>
          screen === "insights"
            ? openAnnualWorkspace()
            : void workspaceRoute.navigate("insights")
        }
      >
        <ChartColumn size={15} aria-hidden="true" />
      </Button>
      <div className="heading-actions">
        {screen === "annual" && (
          <>
            <Button
              className="presentation-start"
              title="발표 모드"
              disabled={!ready || !!pending || !!failed || !!editor}
              onClick={async () => {
                if (
                  annualMemoRef.current &&
                  !(await annualMemoRef.current.flush())
                )
                  return;
                if (
                  operations.isPending() ||
                  operations.failure() ||
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
            {canManage && (
              <Button
                disabled={
                  !ready ||
                  !!pending ||
                  !!failed ||
                  !!editor ||
                  sheetCloneDraft.dirty ||
                  sheetCloneDraft.saving
                }
                onClick={() => setPanel("import")}
              >
                <Upload size={15} />
                가져오기
              </Button>
            )}
            <Button
              disabled={
                !ready ||
                !!pending ||
                !!failed ||
                !!editor ||
                sheetCloneDraft.dirty ||
                sheetCloneDraft.saving
              }
              onClick={() => setPanel("export")}
            >
              <Download size={15} />
              내보내기
            </Button>
          </>
        )}
      </div>
    </section>
  );
  const dateControls = (
    <div className="date-controls" aria-label="기간 설정">
      <div className="year-control" role="group" aria-label="연도 선택">
        <Button
          tooltip="이전 연도"
          disabled={
            !ready ||
            insightsBusy ||
            !!pending ||
            !!failed ||
            !!editor ||
            (viewYear <= 2000 && view.startMonth === 1)
          }
          onClick={() => moveYear(-1)}
        >
          <ChevronLeft size={15} />
        </Button>
        <Button
          className="year-value"
          disabled={insightsBusy}
          tooltip={
            view.startMonth === 1
              ? `${viewYear}년 전체 선택`
              : `${viewYear}~${viewYear + 1}년 표시 기간 전체 선택`
          }
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
          {viewYear}
          {view.startMonth > 1 && <span>~{viewYear + 1}</span>}
        </Button>
        <Button
          tooltip="다음 연도"
          disabled={
            !ready ||
            insightsBusy ||
            !!pending ||
            !!failed ||
            !!editor ||
            viewYear >= 2100
          }
          onClick={() => moveYear(1)}
        >
          <ChevronRight size={15} />
        </Button>
      </div>
      <PeriodPicker
        year={viewYear}
        view={view}
        disabled={!ready || insightsBusy}
        navigationDisabled={insightsBusy || !!pending || !!failed || !!editor}
        onNavigate={moveCalendar}
        onChange={(range) => {
          if (insightsBusy) return;
          changeView(range);
          setJump({ key: null, id: Date.now() });
        }}
      />
    </div>
  );
  const workspace = (
    <div
      ref={workspaceRef}
      className={`workspace ${presentation ? "presentation-mode" : ""}`}
      data-screen={screen}
      data-calendar-theme={
        screen === "calendar" ? calendarTheme.theme : undefined
      }
      data-calendar-palette={
        screen === "calendar" ? calendarTheme.palette : undefined
      }
      style={screen === "calendar" ? calendarTheme.style : undefined}
    >
      <main
        className="main-workspace"
        onKeyDown={(e) => {
          if (
            documentBrowser ||
            screen === "insights" ||
            presentation ||
            e.nativeEvent.isComposing ||
            e.defaultPrevented
          )
            return;
          const target = e.target instanceof HTMLElement ? e.target : null;
          if (
            (e.metaKey || e.ctrlKey) &&
            !e.altKey &&
            (e.code === "KeyB" || e.key.toLowerCase() === "b") &&
            target?.closest(".sheet-scroll,.format-toolbar") &&
            !target.closest("dialog,[role=dialog]") &&
            (!target.closest("input,textarea,select,[contenteditable=true]") ||
              target.closest(".inline-editor,.cell-input-ready"))
          ) {
            e.preventDefault();
            if (!e.repeat && editable && !pending)
              applyStyle({ bold: !selectedCell?.style.bold });
            return;
          }
          if (
            screen === "annual" &&
            (e.metaKey || e.ctrlKey) &&
            e.key.toLowerCase() === "z" &&
            e.target instanceof HTMLElement &&
            (!e.target.closest("input,textarea,select,dialog") ||
              e.target.closest(".cell-input-ready"))
          ) {
            e.preventDefault();
            undo(e.shiftKey);
          }
        }}
      >
        {presentation && (
          <PresentationTools
            workspaceRef={workspaceRef}
            initialZoom={gridZoom}
            onClose={() => setPresentation(false)}
          />
        )}
        <header className="topbar">
          <button
            type="button"
            className="brand brand-home"
            aria-label="그래보드 홈 (연간 업무)"
            onClick={openAnnualWorkspace}
            {...busyProps(
              calendarBusy || insightsBusy,
              workspaceNavigating ||
                !!pending ||
                !!failed ||
                !!editor ||
                sheetCloneDraft.dirty ||
                sheetCloneDraft.saving,
            )}
          >
            <BrandMark className="brand-symbol" />
            <BrandWordmark className="brand-wordmark" />
          </button>
          <Select
            className="team-select"
            aria-label="팀 선택"
            value={teamId}
            {...busyProps(
              calendarBusy || insightsBusy,
              workspaceNavigating ||
                !!pending ||
                !!failed ||
                sheetCloneDraft.dirty ||
                sheetCloneDraft.saving,
            )}
            onChange={(e) => {
              const id = e.target.value;
              void navigateWorkspace(() => setTeamId(id));
            }}
          >
            {boot.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          {screen !== "calendar" && (
            <nav
              className="top-navigation workspace-navigation"
              aria-label="주 메뉴"
            >
              <Button
                title={documentBrowser ? "연간 업무로 돌아가기" : "연간 업무"}
                active={screen === "annual" && !documentBrowser && !sheetClone}
                aria-pressed={
                  screen === "annual" && !documentBrowser && !sheetClone
                }
                onClick={openAnnualWorkspace}
                {...busyProps(
                  calendarBusy || insightsBusy,
                  workspaceNavigating ||
                    sheetCloneDraft.dirty ||
                    sheetCloneDraft.saving,
                )}
              >
                <CalendarDays size={15} />
                <span>연간 업무</span>
              </Button>
              <Button
                title="문서 브라우저"
                active={documentBrowser}
                {...busyProps(
                  calendarBusy || insightsBusy,
                  workspaceNavigating ||
                    (!documentBrowser && !ready) ||
                    !!pending ||
                    !!failed ||
                    !!editor ||
                    sheetCloneDraft.dirty ||
                    sheetCloneDraft.saving,
                )}
                onClick={() => void workspaceRoute.navigate("documents")}
              >
                <FolderOpen size={15} />
                <span>문서 브라우저</span>
              </Button>
              <Button
                className="calendar-launch"
                title="캘린더"
                {...busyProps(
                  calendarBusy || insightsBusy,
                  workspaceNavigating ||
                    !!pending ||
                    !!failed ||
                    !!editor ||
                    sheetCloneDraft.dirty ||
                    sheetCloneDraft.saving,
                )}
                onClick={() => void workspaceRoute.navigate("calendar")}
              >
                <svg
                  width="21"
                  height="21"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect
                    x="3"
                    y="4.5"
                    width="18"
                    height="17"
                    rx="3"
                    fill="#fffdf7"
                    stroke="#26201a"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M6 4.5h12a3 3 0 0 1 3 3V10H3V7.5a3 3 0 0 1 3-3Z"
                    fill="#ff5c2b"
                    stroke="#26201a"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M8 2.5v4M16 2.5v4"
                    stroke="#26201a"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <rect
                    x="6"
                    y="13"
                    width="4"
                    height="4"
                    rx="1"
                    fill="#b9e6a6"
                  />
                  <rect
                    x="13"
                    y="13"
                    width="4"
                    height="4"
                    rx="1"
                    fill="#c7b9ed"
                  />
                </svg>
              </Button>
            </nav>
          )}
          {documentBrowser ? null : editingSheetClone ? (
            <span className="tag" role="status">
              {sheetCloneDraft.saving
                ? "사본 저장 중…"
                : sheetCloneDraft.dirty
                  ? "사본 저장 대기 중…"
                  : "저장됨"}
            </span>
          ) : (
            <SaveStatus pending={pending > 0} failed={!!failed} />
          )}
          {teamId && syncConfigured && (
            <TeamSyncIndicator
              key={teamId}
              teamId={teamId}
              saving={pending > 0}
              failed={!!failed}
              canResolve={canAdd}
              people={boot.users}
            />
          )}
          {screen === "calendar" ? (
            <>
              <Select
                className="calendar-theme-select"
                aria-label="캘린더 테마"
                value={calendarTheme.palette}
                onChange={(event) =>
                  calendarTheme.selectPalette(event.target.value)
                }
              >
                <option value="cartoon">카툰</option>
                {THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </Select>
              <Button
                className="calendar-theme-toggle"
                title={
                  calendarTheme.theme === "dark"
                    ? "밝은 테마로 전환"
                    : "어두운 테마로 전환"
                }
                aria-pressed={calendarTheme.theme === "dark"}
                onClick={calendarTheme.toggle}
              >
                {calendarTheme.theme === "dark" ? (
                  <Sun size={17} />
                ) : (
                  <Moon size={17} />
                )}
              </Button>
              <Button
                className="calendar-close"
                title="캘린더 닫기"
                onClick={openAnnualWorkspace}
                {...busyProps(
                  calendarBusy || insightsBusy,
                  workspaceNavigating ||
                    sheetCloneDraft.dirty ||
                    sheetCloneDraft.saving,
                )}
              >
                <X size={18} />
              </Button>
            </>
          ) : (
            <>
              <nav className="top-navigation" aria-label="관리 메뉴">
                <Button
                  title="변경 이력"
                  onClick={() =>
                    void navigateWorkspace(() => setPanel("history"))
                  }
                  {...busyProps(
                    calendarBusy || insightsBusy,
                    workspaceNavigating ||
                      sheetCloneDraft.dirty ||
                      sheetCloneDraft.saving,
                  )}
                >
                  <History size={15} />
                  <span>변경 이력</span>
                </Button>
                {canOpenSettings && (
                  <Button
                    title="설정"
                    onClick={() =>
                      void navigateWorkspace(() => setPanel("settings"))
                    }
                    {...busyProps(
                      calendarBusy || insightsBusy,
                      workspaceNavigating ||
                        sheetCloneDraft.dirty ||
                        sheetCloneDraft.saving,
                    )}
                  >
                    <Settings size={15} />
                    <span>설정</span>
                  </Button>
                )}
              </nav>
              <AccountMenu
                user={user}
                onProfile={() =>
                  void navigateWorkspace(() => setPanel("profile"))
                }
                onAccessTokens={() =>
                  void navigateWorkspace(() => setPanel("access-tokens"))
                }
                onPassword={
                  site.external
                    ? undefined
                    : () => void navigateWorkspace(() => setPanel("password"))
                }
                logoutDisabled={
                  calendarBusy ||
                  insightsBusy ||
                  workspaceNavigating ||
                  !!pending ||
                  !!failed ||
                  sheetCloneDraft.dirty ||
                  sheetCloneDraft.saving
                }
                onLogout={async () => {
                  if (
                    operations.isPending() ||
                    operations.failure() ||
                    sheetCloneDraft.dirty
                  )
                    return;
                  await navigateWorkspace(async () => {
                    layout.flush();
                    if (await logout()) onLogout();
                  });
                }}
              />
            </>
          )}
        </header>
        {screen === "calendar" ? (
          <Calendar
            key={teamId}
            team={team}
            user={user}
            reloadKey={linkReload}
            onBusyChange={setCalendarBusy}
            onNotify={(message) => {
              setUndoToast(null);
              setToast(message);
            }}
          />
        ) : screen === "insights" ? (
          <>
            {annualHeading}
            <section className="board insights-board">
              <fieldset
                className="view-controls"
                disabled={!ready || insightsBusy}
              >
                <div className="date-search-controls insights-date-row">
                  {dateControls}
                  <div
                    className="insights-date-actions"
                    ref={setInsightsControlsHost}
                  />
                </div>
              </fieldset>
              {teamUnavailable ? (
                <Empty title="팀 자료를 가져와 주세요" />
              ) : !ready && loaded && (error || queryError) ? (
                <Empty
                  title="업무를 불러오지 못했습니다"
                  description={error || queryError}
                  action={
                    <Button onClick={() => location.reload()}>다시 연결</Button>
                  }
                />
              ) : ready ? (
                <Insights
                  key={teamId}
                  team={team}
                  user={user}
                  users={boot.users}
                  year={year}
                  startMonth={view.startMonth}
                  weeks={weeks}
                  source={taskData}
                  controlsHost={insightsControlsHost}
                  onBootstrap={onBootstrap}
                  onTask={openInsightTask}
                  onBusyChange={handleInsightsBusy}
                  onGeneralSettings={() => setPanel("settings")}
                />
              ) : (
                <LoadingState label="업무를 불러오고 있습니다" />
              )}
            </section>
          </>
        ) : documentBrowser ? (
          <DocumentBrowser
            ref={documentBrowserRef}
            boot={boot}
            teamId={team.id}
            initialYear={viewYear}
            initialGroupBy={view.groupBy || ""}
            onClose={closeDocumentBrowser}
            onNavigationChange={setWorkspaceNavigating}
          />
        ) : (
          <>
            {annualHeading}
            <section
              className="board"
              data-view-mode={
                ready
                  ? activeSavedFilter
                    ? "filter"
                    : sheetClone
                      ? "sheet-clone"
                      : undefined
                  : undefined
              }
            >
              <fieldset className="view-controls" disabled={!ready}>
                <div className="date-search-controls">
                  {dateControls}
                  <FindBar
                    key={`${teamId}:${year}:${sheetClone?.id || "live"}`}
                    tasks={matchingTasks}
                    properties={properties}
                    visibleFields={view.visibleFields}
                    users={users}
                    onNavigate={navigateToSearch}
                  />
                </div>
                <div className="view-bar" aria-label="보기 및 필터">
                  <div className="view-mode-controls">
                    <div className="popover-root" ref={viewMenuRef}>
                      <div className="saved-filter-control">
                        <button
                          type="button"
                          className="button saved-filter-trigger"
                          data-tooltip="저장된 필터"
                          aria-label="저장된 필터"
                          aria-expanded={viewMenu}
                          onClick={() => {
                            setViewMenu(!viewMenu);
                            filters.refresh().catch((e) => setError(e.message));
                          }}
                        >
                          <Bookmark size={14} aria-hidden="true" />
                          <span>저장된 필터</span>
                          <ChevronDown size={12} aria-hidden="true" />
                        </button>
                      </div>
                      {viewMenu && (
                        <div className="popover saved-views">
                          <div className="popover-title">
                            <strong>저장된 필터</strong>
                            <Button
                              title="저장된 필터 닫기"
                              onClick={() => setViewMenu(false)}
                            >
                              <X size={14} />
                            </Button>
                          </div>
                          {savedFilters.map((v) => (
                            <div key={v.id}>
                              <button
                                className="saved-filter-choice"
                                aria-label={v.name}
                                aria-description={
                                  v.scope === "team" ? "팀 공용" : "개인용"
                                }
                                aria-pressed={activeSavedFilter?.id === v.id}
                                onClick={() => applySavedFilter(v)}
                              >
                                <span className="saved-filter-name">
                                  {v.name}
                                </span>
                                <span className={`filter-scope-tag ${v.scope}`}>
                                  {v.scope === "team" ? (
                                    <Users size={12} aria-hidden="true" />
                                  ) : (
                                    <UserRound size={12} aria-hidden="true" />
                                  )}
                                  {v.scope === "team" ? "팀 공용" : "개인용"}
                                </span>
                              </button>
                            </div>
                          ))}
                          <Button
                            className="saved-filter-save"
                            onClick={() => {
                              setFilterNameDialog({});
                              setViewMenu(false);
                            }}
                          >
                            <Bookmark size={14} />
                            현재 필터 저장
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </fieldset>
              {(!sheetClone || editingSheetClone) && (
                <Toolbar
                  workColors={team.settings.insights?.workColors}
                  leadingAction={
                    (!sheetClone ? canAdd : editingSheetClone && canAdd) ? (
                      <Button
                        className="primary toolbar-add-task"
                        onClick={addTask}
                        disabled={!ready || !!pending || !!failed}
                      >
                        <Plus size={17} />
                        {addTaskLabel}
                      </Button>
                    ) : undefined
                  }
                  trailingAction={
                    <Button
                      tooltip="모든 필터 초기화"
                      disabled={
                        !ready ||
                        !!activeSavedFilter ||
                        !Object.values(view.propertyFilters || {}).some(
                          (values) => values.length > 0,
                        )
                      }
                      onClick={() =>
                        changeView({
                          propertyFilters: {},
                          propertyFilterModes: {},
                        })
                      }
                    >
                      <FunnelX size={16} aria-hidden="true" />
                    </Button>
                  }
                  style={selectedCell?.style || {}}
                  formatPainting={!!formatBrush}
                  canCopyFormat={!editor}
                  onPaintFormat={copyFormat}
                  disabled={!editable || !!pending}
                  onStyle={(s) => applyStyle(s)}
                  onBorder={applyBorder}
                  onUndo={() => undo()}
                  onRedo={() => undo(true)}
                  canUndo={
                    sheetClone
                      ? editingSheetClone &&
                        canAdd &&
                        sheetCloneDraft.canUndo &&
                        !editor
                      : !!undoStack.length && !pending && !failed
                  }
                  canRedo={
                    sheetClone
                      ? editingSheetClone &&
                        canAdd &&
                        sheetCloneDraft.canRedo &&
                        !editor
                      : !!redoStack.length && !pending && !failed
                  }
                  selectionLabel={selectionLabel}
                  zoom={gridZoom}
                  onZoom={setGridZoom}
                />
              )}
              {ready && activeSavedFilter && (
                <section
                  className="active-filter-banner active-saved-filter-banner"
                  aria-label="필터 보기"
                >
                  <Bookmark size={17} aria-hidden="true" />
                  <span className="active-filter-heading">
                    <strong title={activeSavedFilter.name}>
                      {activeSavedFilter.name}
                    </strong>
                    <span
                      className={`filter-scope-tag ${activeSavedFilter.scope}`}
                    >
                      {activeSavedFilter.scope === "team" ? (
                        <Users size={12} aria-hidden="true" />
                      ) : (
                        <UserRound size={12} aria-hidden="true" />
                      )}
                      {activeSavedFilter.scope === "team"
                        ? "팀 공용"
                        : "개인용"}
                      {!activeSavedFilter.canEdit && " · 읽기 전용"}
                    </span>
                  </span>
                  <ActiveFilterConditions
                    key={`${teamId}:${sheetClone?.id || "live"}:${activeSavedFilter.id}`}
                    properties={properties}
                    tasks={allTasks}
                    users={assignableUsers}
                    view={view}
                    onChange={(part) => changeView(part, true)}
                  >
                    <span
                      className={`active-filter-notice${filterUpdateNotice?.state === "error" ? " is-error" : ""}`}
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {filterUpdateNotice &&
                        filterUpdateNotice.teamId === teamId &&
                        filterUpdateNotice.filterId === activeSavedFilter.id &&
                        (filterUpdateNotice.state === "saving"
                          ? "필터 변경사항 저장 중…"
                          : filterUpdateNotice.state === "error"
                            ? "필터 변경사항을 저장하지 못했습니다."
                            : "")}
                    </span>
                  </ActiveFilterConditions>
                  <div className="active-filter-actions">
                    {activeSavedFilter.canEdit && (
                      <>
                        <Button
                          title="필터 이름 변경"
                          disabled={deletingFilterId === activeSavedFilter.id}
                          onClick={() => renameFilter(activeSavedFilter)}
                        >
                          <Pencil size={14} />
                          <span>필터 이름 변경</span>
                        </Button>
                        <Button
                          className="active-filter-delete"
                          title="저장된 필터 삭제"
                          disabled={!!deletingFilterId}
                          onClick={() => deleteFilter(activeSavedFilter)}
                        >
                          <Trash2 size={14} />
                          <span>삭제</span>
                        </Button>
                      </>
                    )}
                    <Button
                      className="active-filter-exit"
                      title="필터 보기 종료"
                      onClick={clearFilters}
                    >
                      <X size={17} />
                    </Button>
                  </div>
                </section>
              )}
              {sheetCloneDraft.error && (
                <div className="board-error" role="alert">
                  <span>{sheetCloneDraft.error}</span>
                  <Button
                    onClick={() => void sheetCloneDraft.save().catch(() => {})}
                  >
                    저장 재시도
                  </Button>
                  <Button
                    onClick={async () => {
                      if (
                        !sheetClone ||
                        !confirm(
                          "저장하지 못한 표 변경을 폐기하고 최신 사본을 불러올까요?",
                        )
                      )
                        return;
                      try {
                        const latest = await api<SheetClone>(
                          `/sheet-clones/${sheetClone.id}`,
                        );
                        sheetCloneDraft.begin(latest);
                        sheetCloneRef.current = latest;
                        setSheetClone(latest);
                        viewRef.current = latest.view;
                        setView(latest.view);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    최신 내용 불러오기
                  </Button>
                </div>
              )}
              {(error || viewError || queryError) && (
                <div className="board-error" role="alert">
                  <span>{error || viewError || queryError}</span>
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
                  <span>
                    저장하지 못한 변경이 있습니다. {failed.error.message}
                  </span>
                  <Button onClick={() => setPanel("failed")}>입력 확인</Button>
                </div>
              )}
              {teamUnavailable ? (
                <Empty
                  title={
                    team.status === "unconnected"
                      ? "팀 자료를 가져와 주세요"
                      : "팀 연결을 확인해 주세요"
                  }
                  description={
                    canManageTeam(user, team.id)
                      ? "설정 → 시스템 → 외부 동기화에서 ‘팀 가져오기’를 실행하세요."
                      : "팀장이 업무 자료를 가져온 뒤 사용할 수 있습니다."
                  }
                  action={
                    canManageTeam(user, team.id) ? (
                      <Button onClick={() => setPanel("settings")}>
                        설정 열기
                      </Button>
                    ) : (
                      <Button onClick={() => location.reload()}>
                        다시 확인
                      </Button>
                    )
                  }
                />
              ) : !ready && loaded && (error || queryError) ? (
                <Empty
                  title="업무를 불러오지 못했습니다"
                  description={
                    error ||
                    queryError ||
                    "서비스 연결을 확인한 뒤 다시 시도하세요."
                  }
                  action={
                    <Button onClick={() => location.reload()}>다시 연결</Button>
                  }
                />
              ) : !ready ? (
                <LoadingState
                  className="board-loading"
                  label="업무를 불러오는 중"
                />
              ) : (
                <Grid
                  scopeKey={sheetKey}
                  zoom={gridZoom / 100}
                  tasks={visibleTasks}
                  matchingTasks={matchingTasks}
                  allTasks={allTasks}
                  columns={columns}
                  columnOrder={columnOrder}
                  view={view}
                  user={user}
                  users={users}
                  assignableUsers={assignableUsers}
                  canAdd={canAdd}
                  addTaskLabel={addTaskLabel}
                  footer={
                    <AnnualMemoPanel
                      key={`${user.id}:${teamId}:${sheetClone?.id || year}`}
                      ref={annualMemoRef}
                      teamId={teamId}
                      year={year}
                      userId={user.id}
                      readOnly={
                        presentation ||
                        !canAdd ||
                        (!!sheetClone && !editingSheetClone)
                      }
                      sheetCloneId={sheetClone?.id}
                    />
                  }
                  canEditPeople={canAdd}
                  selection={selection}
                  presenceTeamId={presenceTeamId}
                  settings={settings}
                  editor={editor}
                  onCancelEdit={() => setEditor(null)}
                  onCommit={(point, v) => {
                    const editing = editorRef.current;
                    const baseline =
                      editing &&
                      editing.point.taskId === point.taskId &&
                      editing.point.key === point.key
                        ? cell(editing.task, point.key)
                        : undefined;
                    const task = editTasks().find((t) => t.id === point.taskId);
                    if (
                      (baseline &&
                        JSON.stringify(baseline.value) === JSON.stringify(v)) ||
                      (task &&
                        JSON.stringify(cell(task, point.key).value) ===
                          JSON.stringify(v))
                    ) {
                      setEditor(null);
                      return true;
                    }
                    if (operations.isPending() || operations.failure()) {
                      setError(
                        "앞선 변경을 처리한 뒤 저장하세요. 입력은 셀에 남아 있습니다.",
                      );
                      return false;
                    }
                    if (!task || !(sheetClone ? canAdd : canEdit(user, task))) {
                      setError(
                        "업무 편집 권한이 변경되어 저장할 수 없습니다. 입력은 셀에 남아 있습니다.",
                      );
                      return false;
                    }
                    if (
                      !mutate([point], () => ({
                        value: v,
                        ...(baseline
                          ? { expectedVersion: baseline.version }
                          : {}),
                      }))
                    )
                      return false;
                    if (!sheetClone) setPendingEdit({ point, value: v });
                    editorRef.current = null;
                    setEditor(null);
                    return true;
                  }}
                  onSelect={(next) => {
                    selectionEpoch.current++;
                    setSelection(next);
                  }}
                  formatPainting={!!formatBrush}
                  onPaintFormat={paintFormat}
                  onEdit={beginEdit}
                  onPaste={paste}
                  onClear={clearCells}
                  onRowMenu={(t) => setRowTask(t)}
                  onRowCommand={rowCommand}
                  canPasteRow={copiedRow?.task.teamId === teamId}
                  rowActionsDisabled={!!pending || !!editor}
                  onReorder={reorderTask}
                  onView={(part) => changeView(part, true)}
                  onAdd={addTask}
                  onError={setError}
                  onCopied={(message) => {
                    if (message) setError(message);
                    else if (copyError.current) {
                      const shown = copyError.current;
                      setError((current) => (current === shown ? "" : current));
                    }
                    copyError.current = message;
                  }}
                  copyEditable={!!sheetClone && canAdd}
                  readOnly={
                    (!!sheetClone && (!editingSheetClone || !canAdd)) ||
                    !!failed ||
                    presentation
                  }
                  presentation={presentation}
                  jump={jump}
                />
              )}
            </section>
            {!presentation && (
              <SheetTabs
                key={teamId}
                teamId={teamId}
                year={year}
                view={view}
                taskIds={allTasks.map((task) => task.id)}
                active={sheetClone}
                canEdit={canAdd}
                available={!teamUnavailable}
                disabled={
                  teamUnavailable || !ready || !!pending || !!failed || !!editor
                }
                status={
                  sheetClone
                    ? sheetCloneDraft.error
                      ? "저장 실패"
                      : sheetCloneDraft.saving || sheetCloneDraft.dirty
                        ? "저장 중…"
                        : "저장됨"
                    : ""
                }
                onPrepare={prepareCopySwitch}
                onSelect={openSheetClone}
                onDelete={deleteSheetClones}
                onRename={(id, name) => {
                  if (sheetCloneRef.current?.id === id) {
                    const next = { ...sheetCloneRef.current, name };
                    sheetCloneRef.current = next;
                    setSheetClone(next);
                    sheetCloneDraft.rename(name);
                  }
                }}
              />
            )}
          </>
        )}
      </main>
      {undoToast &&
      undoToastCurrent &&
      !presentation &&
      !documentBrowser &&
      screen === "annual" ? (
        <UndoToast
          message={undoToast.message}
          disabled={
            undoToast.kind === "rows" &&
            (!!pending || !!failed || !!editor || (!!sheetClone && !canAdd))
          }
          onUndo={() => {
            if (undoToast.kind === "rows") {
              if (
                operations.isPending() ||
                operations.failure() ||
                editorRef.current
              )
                return;
              setUndoToast(null);
              void undo();
            } else {
              undoToast.undo().catch((e) => setError((e as Error).message));
            }
          }}
        />
      ) : (
        !presentation && <Toast message={toast} />
      )}
      {rowTask && !editor && (
        <RowPanel
          key={`${sheetClone?.id || "live"}:${rowTask.id}`}
          task={allTasks.find((t) => t.id === rowTask.id) || rowTask}
          settings={settings}
          user={user}
          readOnly={
            presentation || (!!sheetClone && (!editingSheetClone || !canAdd))
          }
          sheetCloneMode={!!sheetClone}
          copySaveError={sheetClone ? sheetCloneDraft.error : undefined}
          onRetryCopySave={() => void sheetCloneDraft.save().catch(() => {})}
          documentSheetClone={
            sheetClone
              ? {
                  id: sheetClone.id,
                  isNew: !sheetClone.tasks.some((t) => t.id === rowTask.id),
                }
              : undefined
          }
          onDocumentSaved={(result) => {
            if (sheetClone) {
              const current = sheetCloneRef.current;
              if (current?.id !== sheetClone.id) return;
              const documents = savedSheetCloneDocuments.current;
              if (documents.sheetCloneId !== sheetClone.id) {
                documents.sheetCloneId = sheetClone.id;
                documents.tasks.clear();
              }
              documents.tasks.set(rowTask.id, {
                sequence: ++documents.sequence,
                hasDocument: result.hasDocument,
                documentCount: result.documentCount,
              });
              const next = {
                ...current,
                tasks: current.tasks.map((task) =>
                  task.id === rowTask.id
                    ? {
                        ...task,
                        hasDocument: result.hasDocument,
                        documentCount: result.documentCount,
                      }
                    : task,
                ),
              };
              sheetCloneRef.current = next;
              setSheetClone(next);
              sheetCloneDraft.updateDocument(
                rowTask.id,
                result.hasDocument,
                result.documentCount,
              );
              return;
            }
            taskData.invalidate();
            let recheck = false;
            const next = taskData.snapshot().map((task) => {
              if (task.id !== rowTask.id) return task;
              if (task.updatedAt > result.taskUpdatedAt) {
                // A newer cell event carries no document metadata. Re-read the
                // current flag without overwriting newer cells or documents.
                recheck = true;
                return task;
              }
              return {
                ...task,
                hasDocument: result.hasDocument,
                documentCount: result.documentCount,
                updatedAt: result.taskUpdatedAt,
              };
            });

            taskData.replace(next);
            if (recheck) void refresh();
          }}
          users={users}
          onClose={() => setRowTask(null)}
          onSaveProperty={async (payload) => {
            const task = editTasks().find((t) => t.id === rowTask.id);
            if (
              !task ||
              !(sheetClone ? canAdd : canEdit(user, task)) ||
              presentation
            )
              throw new Error("업무를 수정할 권한이 없습니다.");
            if (sheetClone) {
              if (
                !editingSheetClone ||
                !canAdd ||
                !sheetCloneDraft.apply({
                  kind: "cells",
                  changes: payload.changes,
                })
              )
                throw new Error(
                  "사본을 수정할 수 없습니다. 수정 상태를 확인하세요.",
                );
              const updated = editTasks().find((t) => t.id === rowTask.id)!;
              return payload.changes.map(({ taskId, key }) => ({
                taskId,
                key,
                ...cell(updated, key),
              }));
            }
            if (operations.failure() || operations.isPending())
              throw new Error(
                "앞선 셀 변경을 처리 중입니다. 잠시 후 다시 저장하세요.",
              );
            const submittedBoard = boardKey.current;
            const finishOperation = operations.begin();
            try {
              const result = await send<BatchResult>("/cells/batch", payload);
              if (boardKey.current !== submittedBoard)
                throw new Error(
                  "화면이 변경되었습니다. 업무를 다시 열어 확인하세요.",
                );
              applyResult(result);
              recordResult(result, "normal");
              return result.cells;
            } finally {
              finishOperation();
            }
          }}
          onAction={presentation ? undefined : detailAction}
        />
      )}
      {linkPanels.map(({ key, link, fullPage }) => (
        <DocumentPageTitleContext.Provider
          key={key}
          value={
            deepLink
              ? (title) =>
                  setLinkPanels((panels) => {
                    const panel = panels.find((item) => item.key === key);
                    return !panel || panel.browserTitle === title
                      ? panels
                      : panels.map((item) =>
                          item === panel
                            ? { ...item, browserTitle: title }
                            : item,
                        );
                  })
              : null
          }
        >
          <DocumentLinkPanel
            link={link}
            user={user}
            readOnly={presentation}
            fullPage={fullPage}
            calendarTheme={calendarTheme}
            onClose={() => closeLinkPanel(key)}
            onDeleted={() => closeLinkPanel(key)}
            onOpenSheetClone={(target) =>
              void openInSheetClone(
                target,
                link.kind === "sheet-clone-task" ? link.task.teamId : teamId,
              )
            }
          />
        </DocumentPageTitleContext.Provider>
      ))}
      {panel === "export" && (
        <ExportPanel
          teamId={teamId}
          sheetClone={sheetClone}
          year={viewYear}
          startMonth={view.startMonth}
          taskIds={visibleTasks.map((t) => t.id)}
          keys={columns.map((c) => c.key)}
          onClose={() => setPanel("")}
        />
      )}
      {panel === "import" && (
        <ImportPanel
          teamId={teamId}
          sheetClone={sheetClone}
          year={viewYear}
          onClose={() => setPanel("")}
          onDone={async () => {
            if (sheetClone) {
              await refreshSheet();
              setToast("사본에 자료 가져오기를 완료했습니다.");
              return;
            }
            const key = `${teamId}:${year}`;
            if (boardKey.current !== key) return;
            const { views } = await api(`/views?teamId=${teamId}&year=${year}`);
            await refresh();
            const latest = await refreshBoot();
            if (boardKey.current !== key) return;
            const imported = views.find((v: any) => v.name === "__current");
            if (imported) {
              const next = normalizeView(
                { ...imported.data, ...filters.snapshot().data },
                latest?.teams.find((t) => t.id === teamId)?.settings ||
                  settings,
              ) as View;
              changeView(next);
            }
            setToast("자료 가져오기를 완료했습니다.");
          }}
        />
      )}
      {panel === "history" && (
        <HistoryPanel
          key={sheetClone?.id || "original"}
          sheetClone={sheetClone}
          settings={settings}
          users={users}
          teamId={teamId}
          year={viewYear}
          startMonth={view.startMonth}
          tasks={sheetClone ? editTasks() : tasks}
          user={user}
          onClose={() => setPanel("")}
          onRefresh={refreshSheet}
        />
      )}
      {panel === "settings" && (
        <SettingsPanel
          user={user}
          team={team}
          teams={boot.teams}
          users={boot.users}
          onClose={() => setPanel("")}
          onRefresh={async () => {
            const latest = await refreshBoot();
            if (latest?.teams.some((t) => t.id === teamId)) await refresh();
            return latest;
          }}
        />
      )}
      {panel === "access-tokens" && (
        <AccessTokens onClose={() => setPanel("")} onNotify={setToast} />
      )}
      {panel === "profile" && (
        <ProfilePanel
          user={user}
          onClose={() => setPanel("")}
          onSaved={(updated) => {
            onBootstrap({
              ...boot,
              user: updated,
              users: boot.users.map((item) =>
                item.id === updated.id ? updated : item,
              ),
            });
          }}
        />
      )}
      {panel === "password" && (
        <PasswordPanel user={user} onClose={() => setPanel("")} />
      )}
      {filterNameDialog && (
        <SavedFilterDialog
          key={teamId}
          filter={filterNameDialog.filter}
          canManageFilters={canManageFilters}
          onClose={() => setFilterNameDialog(null)}
          onSave={async (name, scope) => {
            const filter = await filters.save({
              id: filterNameDialog.filter?.id,
              name,
              scope,
              data: view,
            });
            if (filter) applySavedFilter(filter, { scrollToTop: false });
          }}
        />
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
            {failed.payload.format && (
              <p>
                {failed.payload.format.restore
                  ? "공통 서식 실행취소·재실행"
                  : "선택한 행·열의 공통 서식 변경"}
              </p>
            )}
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
                operations.clearFailure();
                setPanel("");
                await refresh();
              }}
            >
              입력 취소·최신 내용 보기
            </Button>
            <Button
              disabled={!!pending || (failed.error as ApiError).status === 410}
              onClick={() => retryFailed(false)}
            >
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
  return (
    <DocumentLinkContext.Provider value={documentLinks}>
      {workspace}
    </DocumentLinkContext.Provider>
  );
}
