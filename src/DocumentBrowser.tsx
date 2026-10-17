import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
} from "lucide-react";
import { api, send } from "./api";
import { Avatar, Button, ErrorNote } from "./components";
import Select from "./Select";
import { TaskDetailContent, type TaskDetailHandle } from "./Panels";
import type { PropertySaveRequest } from "./TaskPropertyEditor";
import type {
  Bootstrap,
  Task,
  Settings,
  User,
  SavedCell,
  Report,
} from "./types";
import {
  cell,
  propertiesFor,
  canEdit,
  canContribute,
} from "../shared/domain.js";
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
type Detail = {
  task: Task;
  settings: Settings;
  users: User[];
  revision?: string;
};
type Selection = {
  source: string;
  taskId: string;
  documentId: string;
  sourceName: string;
};

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
  const [lists, setLists] = useState<Record<string, ListState>>({});
  const [expanded, setExpanded] = useState(new Set(["live"]));
  const [tasksOpen, setTasksOpen] = useState(new Set<string>());
  const [groupsClosed, setGroupsClosed] = useState(new Set<string>());
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const sourceVersions = useRef(new Map<string, number>());
  const loadedVersions = useRef(new Map<string, number>());
  const loadedSourcesKey = useRef("");
  const previousRefresh = useRef(refresh);
  const content = useRef<TaskDetailHandle>(null);
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
      if (content.current && !(await content.current.flush(keepDraft))) {
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
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
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
  function refreshAll() {
    clearTimeout(refreshTimer.current);
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
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, targets.length) }, async () => {
            while (next < targets.length && !controller.signal.aborted) {
              const source = targets[next++];
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
            }
          }),
        );
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
      const result = await send<Report>(
        `/reports/${selected.source}`,
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
            const open = query
              ? !groupsClosed.has(`source:${source.id}`)
              : expanded.has(source.id);
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
                                        <div className="document-browser-task-header">
                                          <button
                                            className="document-browser-task-toggle"
                                            aria-expanded={opened}
                                            aria-label={`${task.title} 문서 ${opened ? "접기" : "펼치기"}`}
                                            onClick={() =>
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
                                          >
                                            {opened ? (
                                              <ChevronDown size={14} />
                                            ) : (
                                              <ChevronRight size={14} />
                                            )}
                                          </button>
                                          <button
                                            className="document-browser-task-open"
                                            aria-label={task.title}
                                            onClick={() =>
                                              void selectDocument(
                                                source,
                                                task.id,
                                                task.documents[0].id,
                                              )
                                            }
                                          >
                                            <span className="document-browser-task-heading">
                                              <span
                                                className="document-browser-task-title"
                                                title={task.title}
                                              >
                                                {task.title}
                                              </span>
                                              <span
                                                className="document-browser-document-count"
                                                role="img"
                                                aria-label={`등록된 문서 ${task.documentCount}개`}
                                                title={`등록된 문서 ${task.documentCount}개`}
                                              >
                                                <FileText
                                                  size={11}
                                                  aria-hidden="true"
                                                />
                                                <span aria-hidden="true">
                                                  {task.documentCount}
                                                </span>
                                              </span>
                                            </span>
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
                                          </button>
                                        </div>
                                        {opened && (
                                          <div className="document-browser-documents">
                                            {task.documents.map((doc) => (
                                              <button
                                                key={doc.id}
                                                className="document-browser-document"
                                                aria-label={doc.title}
                                                aria-description={
                                                  doc.hasContent
                                                    ? doc.preview
                                                    : "빈 문서"
                                                }
                                                aria-current={
                                                  selected?.source ===
                                                    source.id &&
                                                  selected.taskId === task.id &&
                                                  selected.documentId === doc.id
                                                    ? "true"
                                                    : undefined
                                                }
                                                title={`${source.name} / ${task.title} / ${doc.title}`}
                                                onClick={() =>
                                                  void selectDocument(
                                                    source,
                                                    task.id,
                                                    doc.id,
                                                  )
                                                }
                                              >
                                                <FileText
                                                  size={14}
                                                  aria-hidden="true"
                                                />
                                                <span className="document-browser-document-title">
                                                  {doc.title}
                                                </span>
                                                <span
                                                  className="document-browser-document-preview"
                                                  title={
                                                    doc.preview || undefined
                                                  }
                                                >
                                                  {doc.hasContent
                                                    ? doc.preview
                                                    : "빈 문서"}
                                                </span>
                                              </button>
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
          {selected && detail ? (
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
                  reportMode={selected.source !== "live"}
                  documentReport={
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
