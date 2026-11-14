import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Search,
  StickyNote,
} from "lucide-react";
import { api, send } from "../platform/api";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import Select from "../ui/Select";
import { TaskDetailContent, type TaskDetailHandle } from "../Panels";
import AnnualMemoDocumentPanel, {
  annualMemoPath,
} from "./AnnualMemoDocumentPanel";
import type { DocumentPanelHandle } from "./DocumentPanel";
import DocumentLoading from "./DocumentLoading";
import type { PropertySaveRequest } from "../sheet/TaskPropertyEditor";
import type {
  Bootstrap,
  Task,
  Settings,
  User,
  SavedCell,
  SheetClone,
} from "../types";
import {
  cell,
  propertiesFor,
  canEdit,
  canContribute,
} from "../../shared/domain.js";
import "./document-browser.css";

type Source = {
  id: string;
  name: string;
  taskCount: number;
  documentCount: number;
};
type Entry = {
  id: string;
  title: string;
  ownerId: string;
  documentCount: number;
  groupKey: string;
  documents: {
    id: string;
    title: string;
    hasContent: boolean;
    preview: string;
  }[];
};
type Group = {
  key: string;
  label: string;
  taskCount: number;
  documentCount: number;
  matchedTaskCount: number;
  matchedDocumentCount: number;
};
type Listing = {
  tasks: Entry[];
  owners: Record<
    string,
    Pick<User, "id" | "name"> &
      Partial<Pick<User, "color" | "avatarInitials" | "avatarImage">>
  >;
  groups: Group[];
  taskCount: number;
  documentCount: number;
  matchedTaskCount: number;
  matchedDocumentCount: number;
  nextOffset: number | null;
  properties: { id: string; name: string }[];
};
type ListState = { data?: Listing; loading?: boolean; error?: string };
// A task document or tail memo in the list. The memo list API answers with
// these listing fields too, previews included (?preview=1).
type BrowserDocument = Entry["documents"][number];
type MemoState = { memos?: BrowserDocument[]; error?: string };
type Detail = {
  task: Task;
  settings: Settings;
  users: User[];
  revision?: string;
};
type Selection = {
  source: string;
  // Empty for the source's tail memos.
  taskId: string;
  documentId: string;
  sourceName: string;
  memo?: boolean;
};
// Copies are sheetClones; the original is "live".
const sheetCloneOf = (source: string) =>
  source === "live" ? undefined : source;
// Runs `work` for each item, at most `limit` at a time, until aborted.
async function runBounded<T>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !signal.aborted) await work(items[next++]);
    }),
  );
}

// A task or the tail memos in a source's list: the toggle that shows its
// documents and the button that opens it.
function EntryHeader({
  kind,
  title,
  icon,
  tooltip,
  count,
  opened,
  onToggle,
  onOpen,
  children,
}: {
  kind: "task" | "memo";
  title: string;
  icon?: ReactNode;
  tooltip?: string;
  count?: { value: number; label: string };
  opened: boolean;
  onToggle: () => void;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="document-browser-task-header">
      <button
        // Tests count the tasks by their toggles.
        className={`document-browser-entry-toggle${kind === "task" ? " document-browser-task-toggle" : ""}`}
        aria-expanded={opened}
        aria-label={`${title} ${kind === "task" ? "문서 " : ""}${opened ? "접기" : "펼치기"}`}
        onClick={onToggle}
      >
        {opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <button
        className="document-browser-entry-open"
        aria-label={title}
        title={tooltip}
        onClick={onOpen}
      >
        <span className="document-browser-task-heading">
          {icon}
          <span
            className="document-browser-task-title"
            title={tooltip ?? title}
          >
            {title}
          </span>
          {count && (
            <span
              className="document-browser-document-count"
              role="img"
              aria-label={count.label}
              title={count.label}
            >
              <FileText size={11} aria-hidden="true" />
              <span aria-hidden="true">{count.value}</span>
            </span>
          )}
        </span>
        {children}
      </button>
    </div>
  );
}
// A task document or a tail memo with its preview.
function DocumentRow({
  doc,
  empty,
  tooltip,
  current,
  onSelect,
}: {
  doc: BrowserDocument;
  empty: string;
  tooltip: string;
  current: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className="document-browser-document"
      aria-label={doc.title}
      aria-description={doc.hasContent ? doc.preview : empty}
      aria-current={current ? "true" : undefined}
      title={tooltip}
      onClick={onSelect}
    >
      <FileText size={14} aria-hidden="true" />
      <span className="document-browser-document-title">{doc.title}</span>
      <span
        className="document-browser-document-preview"
        title={doc.preview || undefined}
      >
        {doc.hasContent ? doc.preview : empty}
      </span>
    </button>
  );
}

export type DocumentBrowserHandle = {
  navigate: (action: () => void | Promise<void>) => Promise<boolean>;
};

export default function DocumentBrowser({
  ref,
  boot,
  teamId,
  initialYear,
  initialGroupBy,
  onClose,
  onNavigationChange,
}: {
  ref?: Ref<DocumentBrowserHandle>;
  boot: Bootstrap;
  teamId: string;
  initialYear: number;
  initialGroupBy: string;
  onClose: () => Promise<void>;
  onNavigationChange: (busy: boolean) => void;
}) {
  const [year, setYear] = useState(initialYear);
  const [scope, setScope] = useState("live");
  const [groupBy, setGroupBy] = useState(initialGroupBy);
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  // The team and year `sources` were listed for.
  const [sourcesScope, setSourcesScope] = useState("");
  const [lists, setLists] = useState<Record<string, ListState>>({});
  const [expanded, setExpanded] = useState(new Set(["live"]));
  const [tasksOpen, setTasksOpen] = useState(new Set<string>());
  const [memosOpen, setMemosOpen] = useState(new Set<string>());
  const [memoLists, setMemoLists] = useState<Record<string, MemoState>>({});
  const [groupsClosed, setGroupsClosed] = useState(new Set<string>());
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const [memoRefresh, setMemoRefresh] = useState(0);
  const sourceVersions = useRef(new Map<string, number>());
  const loadedVersions = useRef(new Map<string, number>());
  // Memo lists load apart from the task pages: a memo save reloads only its
  // source's memo list.
  const memoVersions = useRef(new Map<string, number>());
  const loadedMemoVersions = useRef(new Map<string, number>());
  const memoListScope = useRef("");
  const memoListRefresh = useRef(refresh);
  const loadedSourcesKey = useRef("");
  const previousRefresh = useRef(refresh);
  const content = useRef<TaskDetailHandle>(null);
  const memoPanel = useRef<DocumentPanelHandle>(null);
  // A memo chosen before the memo panel had its list; opened once it has.
  const pendingMemo = useRef("");
  const [memoLoading, setMemoLoading] = useState(true);
  const navigation = useRef(false);
  const split = useRef<HTMLDivElement>(null);
  const requestEpoch = useRef(0);
  const saveRevision = useRef<{
    operationId: string;
    revision?: string;
  } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const memoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const widthKey = `graeboard:document-browser:width:${boot.user.id}`;
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(widthKey));
      return saved >= 28 && saved <= 55 ? saved : 38;
    } catch {
      return 38;
    }
  });
  const team = boot.teams.find((team) => team.id === teamId)!;
  const previousTeam = useRef(teamId);
  useLayoutEffect(() => {
    if (previousTeam.current === teamId) return;
    previousTeam.current = teamId;
    setScope("live");
    setGroupBy("");
    setGroupsClosed(new Set());
    setTasksOpen(new Set());
    setMemosOpen(new Set());
    setExpanded(new Set(["live"]));
    resetSelection();
  }, [teamId]);
  const params = () =>
    new URLSearchParams({
      teamId,
      year: String(year),
    });
  const scopeKey = `${teamId}:${year}`;
  const listKey = JSON.stringify([
    scopeKey,
    scope,
    query,
    groupBy,
    team.settings.revision,
  ]);
  const previousKey = useRef("");
  const previousScope = useRef("");
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const shownSources = sources.filter(
    (source) =>
      scope === "all" ||
      (scope === "copies" ? source.id !== "live" : source.id === scope),
  );
  const sourceOpen = (id: string) =>
    query ? !groupsClosed.has(`source:${id}`) : expanded.has(id);
  // Sources whose lists, and so tail memos, are shown.
  const openedSources =
    sourcesScope === scopeKey
      ? shownSources
          .filter((source) => sourceOpen(source.id))
          .map((source) => source.id)
          .join(",")
      : "";
  const properties = useMemo(
    () => [
      ...new Map([
        ...propertiesFor(team.settings).map(
          ({ id, name }) => [id, { id, name }] as const,
        ),
        ...Object.values(lists).flatMap(
          (list) => list.data?.properties.map((p) => [p.id, p] as const) || [],
        ),
      ]).values(),
    ],
    [team.settings, lists],
  );

  async function leave(action: () => void | Promise<void>, keepDraft = false) {
    if (navigation.current) return false;
    navigation.current = true;
    setNavigating(true);
    onNavigationChange(true);
    setError("");
    try {
      const saved = content.current
        ? await content.current.flush(keepDraft)
        : keepDraft || !memoPanel.current || (await memoPanel.current.flush());
      if (!saved) {
        setError(
          "저장을 완료하지 못했습니다. 상세 화면에서 입력을 확인한 뒤 다시 이동하세요.",
        );
        return false;
      }
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      navigation.current = false;
      setNavigating(false);
      onNavigationChange(false);
    }
  }
  useImperativeHandle(ref, () => ({ navigate: leave }));
  useEffect(() => {
    if (input.trim() === query) return;
    const timer = setTimeout(() => {
      void leave(() => {
        setQuery(input.trim());
        setGroupsClosed(new Set());
      }).then((saved) => {
        if (!saved)
          setInput((current) => (current === input ? query : current));
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [input, query]);
  useEffect(
    () => () => {
      clearTimeout(refreshTimer.current);
      clearTimeout(memoTimer.current);
    },
    [],
  );
  function changed(source: string) {
    sourceVersions.current.set(
      source,
      (sourceVersions.current.get(source) || 0) + 1,
    );
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(
      () => setSourceRefresh((n) => n + 1),
      250,
    );
  }
  function memosChanged(source: string) {
    memoVersions.current.set(
      source,
      (memoVersions.current.get(source) || 0) + 1,
    );
    clearTimeout(memoTimer.current);
    memoTimer.current = setTimeout(() => setMemoRefresh((n) => n + 1), 250);
  }
  function refreshAll() {
    clearTimeout(refreshTimer.current);
    clearTimeout(memoTimer.current);
    setRefresh((n) => n + 1);
  }
  async function loadList(source: string, signal?: AbortSignal, offset = 0) {
    const p = params();
    p.set("source", source);
    p.set("q", query);
    p.set("groupBy", groupBy);
    p.set("offset", String(offset));
    return api<Listing>(`/document-browser/tasks?${p}`, { signal });
  }
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    const isNew = previousKey.current !== listKey;
    previousKey.current = listKey;
    if (isNew || previousRefresh.current !== refresh)
      loadedVersions.current.clear();
    previousRefresh.current = refresh;
    const versions = new Map(sourceVersions.current);
    const sourcesKey = JSON.stringify([scopeKey, refresh, sourceRefresh]);
    if (previousScope.current !== scopeKey) {
      previousScope.current = scopeKey;
      setSources([]);
    }
    const counts = Object.fromEntries(
      Object.entries(listsRef.current).map(([id, list]) => [
        id,
        isNew ? 0 : list.data?.tasks.length || 0,
      ]),
    );
    if (isNew) setLists({});
    setLoading(true);
    setError("");
    // Expansion reuses counts and completed lists; saves invalidate one source.
    const loadSources =
      loadedSourcesKey.current === sourcesKey
        ? Promise.resolve({ sources: sourcesRef.current })
        : api<{ sources: Source[] }>(`/document-browser/sources?${params()}`, {
            signal: controller.signal,
          });
    void loadSources
      .then(async ({ sources }) => {
        if (controller.signal.aborted) return;
        loadedSourcesKey.current = sourcesKey;
        sourcesRef.current = sources;
        setSources(sources);
        setSourcesScope(scopeKey);
        const targets = sources.filter(
          (source) =>
            (scope === "all" ||
              (scope === "copies"
                ? source.id !== "live"
                : source.id === scope)) &&
            (query || expanded.has(source.id)) &&
            loadedVersions.current.get(source.id) !==
              (versions.get(source.id) || 0),
        );
        setLists((previous) => ({
          ...previous,
          ...Object.fromEntries(
            targets.map((source) => [
              source.id,
              {
                data: isNew ? undefined : previous[source.id]?.data,
                loading: true,
              },
            ]),
          ),
        }));
        // Keep concurrent search requests bounded even with many copies.
        await runBounded(targets, 3, controller.signal, async (source) => {
          try {
            let data = await loadList(source.id, controller.signal);
            // Refresh only the pages the user has already opened.
            while (
              data.nextOffset !== null &&
              data.tasks.length < (counts[source.id] || 0) &&
              !controller.signal.aborted
            ) {
              const next = await loadList(
                source.id,
                controller.signal,
                data.nextOffset,
              );
              data = {
                ...next,
                tasks: [...data.tasks, ...next.tasks],
                owners: { ...data.owners, ...next.owners },
              };
            }
            if (!controller.signal.aborted) {
              loadedVersions.current.set(
                source.id,
                versions.get(source.id) || 0,
              );
              setLists((previous) => ({
                ...previous,
                [source.id]: { data },
              }));
            }
          } catch (e) {
            if (!controller.signal.aborted)
              setLists((previous) => ({
                ...previous,
                [source.id]: { error: (e as Error).message },
              }));
          }
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (epoch === requestEpoch.current && !controller.signal.aborted)
          setLoading(false);
      });
    return () => controller.abort();
  }, [listKey, expanded, refresh, sourceRefresh]);
  // Tail memos do not depend on the search, grouping or scope selection;
  // opened sources load theirs once and again after a memo change or refresh.
  useEffect(() => {
    if (memoListScope.current !== scopeKey) {
      memoListScope.current = scopeKey;
      loadedMemoVersions.current.clear();
      setMemoLists({});
    }
    if (memoListRefresh.current !== refresh) {
      memoListRefresh.current = refresh;
      loadedMemoVersions.current.clear();
    }
    const versions = new Map(memoVersions.current);
    const targets = (openedSources ? openedSources.split(",") : []).filter(
      (id) => loadedMemoVersions.current.get(id) !== (versions.get(id) || 0),
    );
    const controller = new AbortController();
    // At most three requests at once, as for the task pages.
    void runBounded(targets, 3, controller.signal, async (id) => {
      // A retry shows the loading line again instead of the last error.
      setMemoLists((previous) => ({
        ...previous,
        [id]: { memos: previous[id]?.memos },
      }));
      let state: MemoState;
      try {
        const { documents } = await api<{ documents: BrowserDocument[] }>(
          `${annualMemoPath({ teamId, year, sheetCloneId: sheetCloneOf(id) })}?preview=1`,
          { signal: controller.signal },
        );
        state = { memos: documents };
      } catch (e) {
        state = { error: (e as Error).message };
      }
      if (controller.signal.aborted) return;
      if (!state.error)
        loadedMemoVersions.current.set(id, versions.get(id) || 0);
      setMemoLists((previous) => ({ ...previous, [id]: state }));
    });
    return () => controller.abort();
  }, [scopeKey, refresh, memoRefresh, openedSources]);
  function resetSelection() {
    setSelected(null);
    setDetail(null);
    setMobileDetail(false);
    saveRevision.current = null;
  }
  function changeYear(value: number) {
    if (value === year || value < 2000 || value > 2100) return;
    void leave(() => {
      setYear(value);
      setScope("live");
      setGroupsClosed(new Set());
      setTasksOpen(new Set());
      setMemosOpen(new Set());
      setExpanded(new Set(["live"]));
      resetSelection();
    });
  }
  async function selectDocument(
    source: Source,
    taskId: string,
    documentId: string,
  ) {
    await leave(async () => {
      if (selected?.source === source.id && selected.taskId === taskId) {
        if (!(await content.current?.selectDocument(documentId))) return;
      } else {
        const p = params();
        p.set("source", source.id);
        p.set("taskId", taskId);
        const loaded = await api<Detail>(`/document-browser/task?${p}`);
        setDetail(loaded);
        saveRevision.current = null;
      }
      setSelected({
        source: source.id,
        sourceName: source.name,
        taskId,
        documentId,
      });
      const key = `${source.id}:${taskId}`;
      if (query)
        setGroupsClosed((old) => {
          const next = new Set(old);
          next.delete(`task:${key}`);
          return next;
        });
      else setTasksOpen((old) => new Set(old).add(key));
      setMobileDetail(true);
    });
  }
  // Opens the source's tail memos in the detail pane, at `documentId` when a
  // listed memo was chosen, as task titles and documents do.
  async function selectMemo(source: Source, documentId = "") {
    await leave(async () => {
      if (selected?.memo && selected.source === source.id) {
        if (
          documentId &&
          !(await memoPanel.current?.selectDocument(documentId))
        ) {
          // The loading panel cannot switch tabs yet; it does when it opens.
          if (!memoLoading) return;
          pendingMemo.current = documentId;
        }
      } else {
        pendingMemo.current = "";
        setDetail(null);
        setMemoLoading(true);
        saveRevision.current = null;
      }
      setSelected((previous) => ({
        source: source.id,
        sourceName: source.name,
        taskId: "",
        memo: true,
        documentId:
          documentId ||
          (previous?.memo && previous.source === source.id
            ? previous.documentId
            : ""),
      }));
      setMemosOpen((old) => new Set(old).add(source.id));
      setMobileDetail(true);
    });
  }
  function showMemo(documentId: string) {
    setSelected((previous) =>
      previous?.memo && previous.documentId !== documentId
        ? { ...previous, documentId }
        : previous,
    );
  }
  async function saveProperty(
    payload: PropertySaveRequest,
  ): Promise<SavedCell[]> {
    if (!selected || !detail) throw new Error("업무를 다시 선택하세요.");
    let saved: SavedCell[];
    if (selected.source === "live") {
      const result = await send<{ cells: SavedCell[] }>(
        "/cells/batch",
        payload,
      );
      saved = result.cells;
      setDetail(
        (current) =>
          current && {
            ...current,
            task: {
              ...current.task,
              cells: {
                ...current.task.cells,
                ...Object.fromEntries(
                  saved.map((c) => [
                    c.key,
                    { value: c.value, style: c.style, version: c.version },
                  ]),
                ),
              },
            },
          },
      );
    } else {
      if (saveRevision.current?.operationId !== payload.operationId)
        saveRevision.current = {
          operationId: payload.operationId,
          revision: detail.revision,
        };
      const result = await send<SheetClone>(
        `/sheet-clones/${selected.source}`,
        {
          operationId: payload.operationId,
          revision: saveRevision.current.revision,
          operations: [
            { kind: "cells", changes: payload.changes, at: payload.createdAt },
          ],
        },
        "PATCH",
      );
      const task = result.tasks.find((task) => task.id === selected.taskId)!;
      saved = payload.changes.map(({ taskId, key }) => ({
        taskId,
        key,
        ...cell(task, key),
      }));
      setDetail(
        (current) => current && { ...current, task, revision: result.revision },
      );
      saveRevision.current = null;
    }
    changed(selected.source);
    return saved;
  }
  function resize(value: number) {
    const next = Math.max(28, Math.min(55, value));
    setWidth(next);
    try {
      localStorage.setItem(widthKey, String(next));
    } catch {
      /* optional preference */
    }
  }
  const resultDocuments = shownSources.reduce(
    (sum, source) => sum + (lists[source.id]?.data?.matchedDocumentCount || 0),
    0,
  );
  const resultTasks = shownSources.reduce(
    (sum, source) => sum + (lists[source.id]?.data?.matchedTaskCount || 0),
    0,
  );
  const failedSearch = shownSources.some((source) => lists[source.id]?.error);
  const hasLoadedLists =
    shownSources.length > 0 &&
    shownSources.every((source) => lists[source.id]?.data);
  return (
    <div className="document-browser">
      <section className="page-heading document-browser-heading">
        <div className="heading-line">
          <h1>문서 브라우저</h1>
          <div
            className="document-browser-year"
            role="group"
            aria-label="문서 조회 연도"
          >
            <Button
              title="이전 연도"
              disabled={navigating || year <= 2000}
              onClick={() => changeYear(year - 1)}
            >
              <ChevronLeft size={14} />
            </Button>
            <Select
              className="year-badge"
              aria-label="문서 브라우저 연도"
              title="연도 선택"
              value={year}
              disabled={navigating}
              onChange={(e) => changeYear(Number(e.target.value))}
            >
              {Array.from(
                new Set([
                  ...boot.years,
                  year,
                  new Date().getFullYear(),
                  year - 1,
                  year + 1,
                ]),
              )
                .filter((y) => y >= 2000 && y <= 2100)
                .sort((a, b) => b - a)
                .map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
            </Select>
            <Button
              title="다음 연도"
              disabled={navigating || year >= 2100}
              onClick={() => changeYear(year + 1)}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
        <div
          className="board-summary document-browser-summary"
          role="group"
          aria-label="선택한 연도 문서 통계"
          title={`${year}년 원본·사본별 합계입니다. 같은 작업도 원본과 사본에서 각각 집계하며 검색·분류에 영향을 받지 않습니다.`}
        >
          <span>
            <i className="summary-dot" />
            전체 문서{" "}
            <strong>
              {sources.length
                ? sources.reduce((n, s) => n + s.documentCount, 0)
                : "—"}
            </strong>
          </span>
          <span>
            <i className="summary-dot" />
            문서 보유 작업{" "}
            <strong>
              {sources.length
                ? sources.reduce((n, s) => n + s.taskCount, 0)
                : "—"}
            </strong>
          </span>
          <span>
            <i className="summary-dot" />
            사본{" "}
            <strong>
              {sources.length
                ? sources.filter((s) => s.id !== "live").length
                : "—"}
            </strong>
          </span>
        </div>
      </section>
      <div className="document-browser-filters">
        <Select
          className="document-browser-scope-select"
          aria-label="문서 검색 범위"
          value={scope}
          disabled={navigating}
          onChange={(e) => {
            const value = e.target.value;
            void leave(() => setScope(value));
          }}
        >
          <option value="all">원본 + 모든 사본</option>
          <option value="live">원본</option>
          <option value="copies">모든 사본</option>
          {sources
            .filter((s) => s.id !== "live")
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </Select>
        <Select
          className="document-browser-group-select"
          aria-label="문서 묶음 보기"
          value={groupBy}
          disabled={navigating}
          onChange={(e) => {
            const value = e.target.value;
            void leave(() => {
              setGroupBy(value);
              setGroupsClosed(new Set());
            });
          }}
        >
          <option value="">묶음 없음</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <div
          className="search-box document-browser-search"
          role="search"
          aria-label="문서 찾기"
        >
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="작업 이름 검색"
            placeholder="작업 이름 검색"
            maxLength={200}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
        <span
          className="document-browser-search-status"
          role="status"
          aria-busy={loading}
        >
          {query
            ? loading && !hasLoadedLists
              ? "검색 중…"
              : failedSearch || error
                ? "일부 검색에 실패했습니다. 해당 목록에서 다시 시도하세요."
                : `검색 결과 · 작업 ${resultTasks}개 · 문서 ${resultDocuments}개`
            : ""}
        </span>
        <Button
          className="document-browser-refresh"
          onClick={() => void leave(refreshAll)}
          disabled={loading || navigating}
        >
          새로고침
        </Button>
      </div>
      {error && (
        <div className="document-browser-error">
          <ErrorNote error={error} />
          <Button onClick={() => void leave(refreshAll)}>다시 시도</Button>
        </div>
      )}
      <div
        ref={split}
        className="document-browser-split"
        data-detail={mobileDetail || undefined}
        style={{ "--browser-width": `${width}%` } as CSSProperties}
      >
        <aside
          id="document-browser-tree"
          className="document-browser-tree"
          aria-label="문서 탐색"
        >
          {!loading && !error && !shownSources.length && (
            <p className="document-browser-empty">이 범위에 사본이 없습니다.</p>
          )}
          {hasLoadedLists &&
            query &&
            !resultDocuments &&
            !failedSearch &&
            !error && (
              <p className="document-browser-empty">
                검색 결과가 없습니다. 다른 검색어나 범위를 선택하세요.
              </p>
            )}
          {shownSources.map((source) => {
            const list = lists[source.id];
            const open = sourceOpen(source.id);
            const memoList = memoLists[source.id];
            const memosShown = memosOpen.has(source.id);
            return (
              <section
                className="document-browser-source"
                key={source.id}
                data-source={source.id}
              >
                <button
                  className="document-browser-source-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    void leave(() => {
                      if (query)
                        setGroupsClosed((old) => {
                          const next = new Set(old);
                          const key = `source:${source.id}`;
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      else
                        setExpanded((old) => {
                          const next = new Set(old);
                          if (next.has(source.id)) next.delete(source.id);
                          else next.add(source.id);
                          return next;
                        });
                    })
                  }
                >
                  {open ? (
                    <ChevronDown size={17} />
                  ) : (
                    <ChevronRight size={17} />
                  )}
                  <span>
                    <strong title={source.name}>{source.name}</strong>
                    <small>
                      문서 보유 작업 {source.taskCount}개 · 문서{" "}
                      {source.documentCount}개
                    </small>
                    {query && list?.data && (
                      <small className="document-browser-match">
                        검색 · 작업 {list.data.matchedTaskCount}개 · 문서{" "}
                        {list.data.matchedDocumentCount}개
                      </small>
                    )}
                  </span>
                  <em>{source.id === "live" ? "원본" : "사본"}</em>
                </button>
                {open && (
                  <div
                    className="document-browser-source-body"
                    aria-busy={list?.loading || undefined}
                  >
                    {list?.loading && !list.data && (
                      <p role="status">
                        {query ? "검색 중…" : "목록 불러오는 중…"}
                      </p>
                    )}
                    {list?.error && (
                      <div role="alert">
                        {list.error}
                        <Button onClick={() => changed(source.id)}>
                          다시 시도
                        </Button>
                      </div>
                    )}
                    {list?.data && !list.data.tasks.length && (
                      <p className="document-browser-empty">
                        {query
                          ? "일치하는 문서가 없습니다."
                          : "등록된 문서가 없습니다. 연간 업무의 작업 상세에서 문서를 작성해 보세요."}
                      </p>
                    )}
                    {list?.data?.groups
                      .filter((group) =>
                        list.data!.tasks.some(
                          (task) => task.groupKey === group.key,
                        ),
                      )
                      .map((group, groupIndex) => {
                        const key = `${source.id}:${group.key}`;
                        const closed = groupsClosed.has(key);
                        const groupId = `document-browser-group-${source.id}-${groupIndex}`;
                        return (
                          <div
                            className="document-browser-group"
                            key={group.key}
                            data-grouped={groupBy ? true : undefined}
                          >
                            {groupBy && (
                              <button
                                id={`${groupId}-toggle`}
                                className="document-browser-group-toggle"
                                aria-expanded={!closed}
                                aria-controls={groupId}
                                onClick={() =>
                                  void leave(() =>
                                    setGroupsClosed((old) => {
                                      const next = new Set(old);
                                      if (closed) next.delete(key);
                                      else next.add(key);
                                      return next;
                                    }),
                                  )
                                }
                              >
                                {closed ? (
                                  <ChevronRight size={14} />
                                ) : (
                                  <ChevronDown size={14} />
                                )}
                                <span title={group.label}>{group.label}</span>
                                <small>
                                  {query
                                    ? `검색 ${group.matchedTaskCount} / 전체 ${group.taskCount}개 작업`
                                    : `${group.taskCount}개 작업`}
                                </small>
                              </button>
                            )}
                            {!closed && (
                              <div
                                id={groupId}
                                className="document-browser-group-body"
                                role={groupBy ? "group" : undefined}
                                aria-labelledby={
                                  groupBy ? `${groupId}-toggle` : undefined
                                }
                              >
                                {list
                                  .data!.tasks.filter(
                                    (task) => task.groupKey === group.key,
                                  )
                                  .map((task) => {
                                    const key = `${source.id}:${task.id}`;
                                    const owner =
                                      list.data!.owners[task.ownerId];
                                    const opened = query
                                      ? !groupsClosed.has(`task:${key}`)
                                      : tasksOpen.has(key);
                                    return (
                                      <div
                                        className="document-browser-task"
                                        key={task.id}
                                      >
                                        <EntryHeader
                                          kind="task"
                                          title={task.title}
                                          count={{
                                            value: task.documentCount,
                                            label: `등록된 문서 ${task.documentCount}개`,
                                          }}
                                          opened={opened}
                                          onToggle={() =>
                                            void leave(() =>
                                              (query
                                                ? setGroupsClosed
                                                : setTasksOpen)((old) => {
                                                const next = new Set(old);
                                                const entry = query
                                                  ? `task:${key}`
                                                  : key;
                                                if (next.has(entry))
                                                  next.delete(entry);
                                                else next.add(entry);
                                                return next;
                                              }),
                                            )
                                          }
                                          onOpen={() =>
                                            void selectDocument(
                                              source,
                                              task.id,
                                              task.documents[0].id,
                                            )
                                          }
                                        >
                                          <span
                                            className="document-browser-owner"
                                            title={`담당자: ${owner?.name || "미지정"}`}
                                            role="img"
                                            aria-label={`담당자: ${owner?.name || "미지정"}`}
                                          >
                                            <Avatar user={owner} small />
                                            <span className="document-browser-owner-name">
                                              {owner?.name || "미지정"}
                                            </span>
                                          </span>
                                        </EntryHeader>
                                        {opened && (
                                          <div className="document-browser-documents">
                                            {task.documents.map((doc) => (
                                              <DocumentRow
                                                key={doc.id}
                                                doc={doc}
                                                empty="빈 문서"
                                                tooltip={`${source.name} / ${task.title} / ${doc.title}`}
                                                current={
                                                  selected?.source ===
                                                    source.id &&
                                                  selected.taskId === task.id &&
                                                  selected.documentId === doc.id
                                                }
                                                onSelect={() =>
                                                  void selectDocument(
                                                    source,
                                                    task.id,
                                                    doc.id,
                                                  )
                                                }
                                              />
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    {list?.data?.nextOffset != null && (
                      <Button
                        disabled={list.loading}
                        onClick={() =>
                          void leave(async () => {
                            const epoch = requestEpoch.current;
                            const data = await loadList(
                              source.id,
                              undefined,
                              list.data!.nextOffset!,
                            );
                            if (epoch === requestEpoch.current)
                              setLists((old) => ({
                                ...old,
                                [source.id]: {
                                  data: {
                                    ...data,
                                    tasks: [...list.data!.tasks, ...data.tasks],
                                    owners: {
                                      ...list.data!.owners,
                                      ...data.owners,
                                    },
                                  },
                                },
                              }));
                          })
                        }
                      >
                        다음 작업 더 보기 ({list.data.tasks.length} /{" "}
                        {list.data.matchedTaskCount})
                      </Button>
                    )}
                    <div className="document-browser-memos">
                      <EntryHeader
                        kind="memo"
                        title="꼬리 메모"
                        icon={<StickyNote size={14} aria-hidden="true" />}
                        tooltip={`${source.name} / 꼬리 메모`}
                        count={
                          memoList?.memos && {
                            value: memoList.memos.length,
                            label: `등록된 메모 ${memoList.memos.length}개`,
                          }
                        }
                        opened={memosShown}
                        onToggle={() =>
                          void leave(() =>
                            setMemosOpen((old) => {
                              const next = new Set(old);
                              if (memosShown) next.delete(source.id);
                              else next.add(source.id);
                              return next;
                            }),
                          )
                        }
                        onOpen={() => void selectMemo(source)}
                      />
                      {memosShown && (
                        <div className="document-browser-documents">
                          {memoList?.error ? (
                            <div role="alert">
                              {memoList.error}
                              <Button onClick={() => memosChanged(source.id)}>
                                다시 시도
                              </Button>
                            </div>
                          ) : !memoList?.memos ? (
                            <p role="status">목록 불러오는 중…</p>
                          ) : !memoList.memos.length ? (
                            <p className="document-browser-empty">
                              등록된 메모가 없습니다.
                            </p>
                          ) : (
                            memoList.memos.map((memo) => (
                              <DocumentRow
                                key={memo.id}
                                doc={memo}
                                empty="빈 메모"
                                tooltip={`${source.name} / 꼬리 메모 / ${memo.title}`}
                                current={
                                  !!selected?.memo &&
                                  selected.source === source.id &&
                                  selected.documentId === memo.id
                                }
                                onSelect={() =>
                                  void selectMemo(source, memo.id)
                                }
                              />
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </aside>
        <div
          className="document-browser-divider"
          role="separator"
          tabIndex={0}
          aria-label="탐색 영역 너비"
          aria-controls="document-browser-tree"
          aria-orientation="vertical"
          aria-valuemin={28}
          aria-valuemax={55}
          aria-valuenow={Math.round(width)}
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              resize(
                e.key === "Home"
                  ? 28
                  : e.key === "End"
                    ? 55
                    : width + (e.key === "ArrowLeft" ? -2 : 2),
              );
            }
          }}
          onPointerDown={(e) => {
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
          }}
          onPointerMove={(e) => {
            if (
              e.currentTarget.hasPointerCapture(e.pointerId) &&
              split.current
            ) {
              const bounds = split.current.getBoundingClientRect();
              resize(((e.clientX - bounds.left) / bounds.width) * 100);
            }
          }}
          onPointerUp={(e) =>
            e.currentTarget.releasePointerCapture(e.pointerId)
          }
        />
        <section
          className="document-browser-detail"
          aria-label="문서 상세"
          aria-busy={navigating}
        >
          {selected?.memo ? (
            <>
              <div className="document-browser-detail-bar">
                <Button
                  className="document-browser-back"
                  onClick={() => void leave(() => setMobileDetail(false))}
                >
                  <ArrowLeft size={16} />
                  목록으로
                </Button>
                <span title={`${selected.sourceName} / 꼬리 메모`}>
                  {selected.sourceName} / 꼬리 메모
                </span>
                <small>
                  {canContribute(boot.user, teamId) ? "자동 저장" : "읽기 전용"}
                </small>
              </div>
              <div className="document-browser-detail-scroll task-detail-modal">
                <div
                  className="task-document-shell"
                  data-loading={memoLoading || undefined}
                >
                  {memoLoading && <DocumentLoading />}
                  <div
                    className="task-document-surface"
                    aria-hidden={memoLoading || undefined}
                    inert={memoLoading}
                  >
                    <AnnualMemoDocumentPanel
                      key={`${selected.source}:memos`}
                      ref={memoPanel}
                      memoTabs
                      teamId={teamId}
                      year={year}
                      sheetCloneId={sheetCloneOf(selected.source)}
                      userId={boot.user.id}
                      readOnly={!canContribute(boot.user, teamId)}
                      initialDocumentId={selected.documentId || undefined}
                      onDocumentSelected={(id) => {
                        const pending = pendingMemo.current;
                        pendingMemo.current = "";
                        if (pending && pending !== id)
                          void memoPanel.current
                            ?.selectDocument(pending)
                            .then((opened) => {
                              if (!opened) showMemo(id);
                            });
                        else showMemo(id);
                      }}
                      onSaved={() => memosChanged(selected.source)}
                      onListChanged={() => memosChanged(selected.source)}
                      onLoadingChange={setMemoLoading}
                      onCloseWithDraft={() => void leave(onClose, true)}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : selected && detail ? (
            <>
              <div className="document-browser-detail-bar">
                <Button
                  className="document-browser-back"
                  onClick={() => void leave(() => setMobileDetail(false))}
                >
                  <ArrowLeft size={16} />
                  목록으로
                </Button>
                <span
                  title={`${selected.sourceName} / ${String(detail.task.cells.title?.value || "")}`}
                >
                  {selected.sourceName} /{" "}
                  {String(detail.task.cells.title?.value || "제목 없는 업무")}
                </span>
                <small>
                  {(
                    selected.source === "live"
                      ? canEdit(boot.user, detail.task)
                      : canContribute(boot.user, teamId)
                  )
                    ? "자동 저장"
                    : "읽기 전용"}
                </small>
              </div>
              <div className="document-browser-detail-scroll task-detail-modal">
                <TaskDetailContent
                  key={`${selected.source}:${selected.taskId}`}
                  ref={content}
                  task={detail.task}
                  settings={
                    selected.source === "live" ? team.settings : detail.settings
                  }
                  user={boot.user}
                  users={detail.users}
                  documentSheetClone={
                    selected.source === "live"
                      ? undefined
                      : { id: selected.source, isNew: false }
                  }
                  initialDocumentId={selected.documentId}
                  onDocumentSelected={(id) =>
                    setSelected((previous) =>
                      previous && previous.documentId !== id
                        ? { ...previous, documentId: id }
                        : previous,
                    )
                  }
                  onSaveProperty={saveProperty}
                  onDocumentSaved={() => changed(selected.source)}
                  onCloseWithDraft={() => void leave(onClose, true)}
                />
              </div>
            </>
          ) : (
            <div className="document-browser-placeholder">
              <FolderOpen size={42} strokeWidth={1.2} />
              <h2>살펴볼 문서를 선택하세요</h2>
              <p>
                왼쪽에서 원본 또는 사본의 작업을 펼쳐보세요.
                <br />
                문서를 선택하면 여기에서 바로 편집할 수 있습니다.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
