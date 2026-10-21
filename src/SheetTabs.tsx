import useResourceSync from "./useResourceSync";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
} from "lucide-react";
import { api, send } from "./api";
import { Button, Modal } from "./components";
import type { Report, View } from "./types";
import { todayKey } from "../shared/domain.js";
import {
  MAX_REPORT_NAME_LENGTH,
  normalizeReportName,
} from "../shared/report-names.js";

type CopyInfo = { id: string; name: string; year: number };
type RenameDraft = { copy: CopyInfo; name: string };
export default function SheetTabs({
  teamId,
  year,
  view,
  taskIds,
  active,
  canEdit,
  disabled,
  status,
  onSelect,
  onPrepare,
  onRename,
  onDelete,
}: {
  teamId: string;
  year: number;
  view: View;
  taskIds: string[];
  active: Report | null;
  canEdit: boolean;
  disabled: boolean;
  status: string;
  onSelect: (id: string | null) => Promise<void>;
  onPrepare: () => Promise<void>;
  onRename: (id: string, name: string) => void;
  onDelete: (ids: string[]) => Promise<void>;
}) {
  const [copies, setCopies] = useState<CopyInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<CopyInfo | null>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<{
    kind: "create" | "delete";
    copy?: CopyInfo;
  } | null>(null);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<RenameDraft | null>(null);
  const renameDraft = useRef<RenameDraft | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameSave = useRef<Promise<boolean> | null>(null);
  const composing = useRef(false);
  const tabScroll = useRef<HTMLDivElement>(null);
  const tabItems = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState({ left: false, right: false });
  const createId = useRef<string>("");
  const root = useRef<HTMLDivElement>(null);
  useResourceSync(`/teams/${teamId}`, async (signal) => {
    if (busy || renaming || dialog) return false;
    const result = await api<{ reports: CopyInfo[] }>(
      `/reports?teamId=${teamId}`,
      { signal },
    );
    if (!signal.aborted) setCopies(result.reports);
    return true;
  });
  async function refresh() {
    const result = await api<{ reports: CopyInfo[] }>(
      `/reports?teamId=${teamId}`,
    );
    setCopies(result.reports);
    return result.reports;
  }
  useEffect(() => {
    let cancelled = false;
    api<{ reports: CopyInfo[] }>(`/reports?teamId=${teamId}`)
      .then((r) => {
        if (!cancelled) setCopies(r.reports);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);
  function updateScroll() {
    const el = tabScroll.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    setScrollable((current) =>
      current.left === left && current.right === right
        ? current
        : { left, right },
    );
  }
  useLayoutEffect(() => {
    const observer = new ResizeObserver(updateScroll);
    observer.observe(tabScroll.current!);
    observer.observe(tabItems.current!);
    updateScroll();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    root.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id]);
  useLayoutEffect(() => {
    if (!renaming) return;
    renameInput.current?.focus();
    renameInput.current?.select();
    renameInput.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [renaming?.copy.id]);
  function scrollTabs(direction: number) {
    const el = tabScroll.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.75),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    // Trackpads can keep a wheel sequence open while an arrow is clicked.
    // Refresh instant scrolling even when the browser coalesces its scroll event.
    updateScroll();
  }
  function changeRename(next: RenameDraft | null) {
    renameDraft.current = next;
    setRenaming(next);
  }
  function finishRename(): Promise<boolean> {
    if (renameSave.current) return renameSave.current;
    const draft = renameDraft.current;
    if (!draft) return Promise.resolve(true);
    const work = async () => {
      setBusy(true);
      setError("");
      try {
        const nextName = draft.name.trim().normalize("NFC");
        if (!nextName) throw new Error("사본 이름을 입력해 주세요.");
        if (nextName !== draft.copy.name) {
          const result = await send<CopyInfo>(
            `/reports/${draft.copy.id}/name`,
            { name: nextName, expectedName: draft.copy.name },
            "PATCH",
          );
          setCopies((current) =>
            current.map((copy) =>
              copy.id === result.id ? { ...copy, name: result.name } : copy,
            ),
          );
          onRename(result.id, result.name);
        }
        changeRename(null);
        return true;
      } catch (e) {
        setError((e as Error).message);
        requestAnimationFrame(() => renameInput.current?.focus());
        return false;
      } finally {
        setBusy(false);
      }
    };
    const promise = Promise.resolve()
      .then(work)
      .finally(() => {
        renameSave.current = null;
      });
    renameSave.current = promise;
    return promise;
  }
  async function startRename(copy: CopyInfo) {
    if (busy || disabled || !canEdit || !(await finishRename())) return;
    setMenu(null);
    setError("");
    changeRename({ copy, name: copy.name });
  }
  useLayoutEffect(() => {
    if (!menu) return;
    const place = () => {
      const anchor = menuAnchor.current;
      const popup = menuElement.current;
      const bar = root.current;
      const scroll = tabScroll.current;
      if (!anchor?.isConnected || !popup || !bar || !scroll) return;
      const target = anchor.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      if (target.right <= viewport.left || target.left >= viewport.right) {
        setMenu(null);
        return;
      }
      const left =
        target.right -
        bar.getBoundingClientRect().left -
        bar.clientLeft -
        popup.offsetWidth;
      popup.style.left = `${Math.max(4, Math.min(left, bar.clientWidth - popup.offsetWidth - 4))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root.current!);
    observer.observe(tabItems.current!);
    observer.observe(menuElement.current!);
    const scroll = tabScroll.current!;
    scroll.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  async function select(id: string | null) {
    if (busy || disabled) return;
    if (!(await finishRename()) || id === (active?.id || null)) return;
    setBusy(true);
    setError("");
    setMenu(null);
    try {
      await onSelect(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (busy || disabled || !(await finishRename())) return;
    setBusy(true);
    setError("");
    try {
      const existing = new Set(
        (await refresh()).map((copy) => normalizeReportName(copy.name)),
      );
      createId.current = crypto.randomUUID();
      const base = `${todayKey()}의 사본`;
      let candidate = base;
      let n = 1;
      while (existing.has(candidate)) candidate = `${base} (${++n})`;
      setName(candidate);
      setDialog({ kind: "create" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (dialog?.kind === "create") {
        await onPrepare();
        const created = await send<{ id: string }>("/reports", {
          id: createId.current,
          teamId,
          year: active?.year || year,
          name,
          referenceDate: todayKey(),
          view,
          taskIds,
          sourceId: active?.id,
        });
        setDialog(null);
        await onSelect(created.id);
        await refresh();
      } else if (dialog?.kind === "delete" && dialog.copy) {
        await onDelete([dialog.copy.id]);
        await refresh();
        setDialog(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const listed =
    active && !copies.some((copy) => copy.id === active.id)
      ? [active, ...copies]
      : copies;
  const items = [
    { id: null, name: "원본" },
    ...listed.map((copy) =>
      copy.id === active?.id ? { ...copy, name: active.name } : copy,
    ),
  ];
  return (
    <>
      <div
        className="sheet-tabs-bar"
        ref={root}
        onKeyDown={(e) => {
          if (e.key === "Escape") setMenu(null);
        }}
      >
        <div
          className="sheet-tabs"
          ref={tabScroll}
          onScroll={updateScroll}
          role="tablist"
          aria-label="원본과 사본"
          onKeyDown={(e) => {
            if (
              !(e.target instanceof HTMLElement) ||
              e.target.getAttribute("role") !== "tab"
            )
              return;
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              return;
            const index = items.findIndex(
              (item) => item.id === (active?.id || null),
            );
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : (index + (e.key === "ArrowLeft" ? -1 : 1) + items.length) %
                    items.length;
            e.preventDefault();
            void select(items[next].id).then(() =>
              root.current
                ?.querySelector<HTMLButtonElement>(
                  `[role=tab][data-sheet="${items[next].id || "original"}"]`,
                )
                ?.focus(),
            );
          }}
        >
          <div className="sheet-tab-items" ref={tabItems}>
            {items.map((item) => (
              <Fragment key={item.id || "original"}>
                <div
                  className={`sheet-tab-wrap${item.id === (active?.id || null) ? " selected" : ""}`}
                >
                  {renaming?.copy.id === item.id ? (
                    <span className="sheet-tab-name-editor">
                      <span
                        className="sheet-tab-name-measure"
                        aria-hidden="true"
                      >
                        {renaming.name || "\u00a0"}
                      </span>
                      <input
                        className="sheet-tab-name-input"
                        ref={renameInput}
                        aria-label="사본 이름"
                        aria-invalid={!!error}
                        aria-describedby={
                          error ? "sheet-tabs-error" : undefined
                        }
                        readOnly={busy}
                        maxLength={MAX_REPORT_NAME_LENGTH}
                        value={renaming.name}
                        onChange={(e) =>
                          changeRename({ ...renaming, name: e.target.value })
                        }
                        onBlur={() => {
                          if (!composing.current) void finishRename();
                        }}
                        onCompositionStart={() => {
                          composing.current = true;
                        }}
                        onCompositionEnd={(e) => {
                          composing.current = false;
                          changeRename({
                            ...renaming,
                            name: e.currentTarget.value,
                          });
                          if (document.activeElement !== e.currentTarget)
                            void finishRename();
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (
                            e.nativeEvent.isComposing ||
                            composing.current ||
                            e.keyCode === 229
                          )
                            return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void finishRename().then((ok) => {
                              if (ok)
                                root.current
                                  ?.querySelector<HTMLButtonElement>(
                                    `[data-sheet="${item.id}"]`,
                                  )
                                  ?.focus();
                            });
                          } else if (e.key === "Escape" && !busy) {
                            e.preventDefault();
                            changeRename(null);
                            setError("");
                            requestAnimationFrame(() =>
                              root.current
                                ?.querySelector<HTMLButtonElement>(
                                  `[data-sheet="${item.id}"]`,
                                )
                                ?.focus(),
                            );
                          }
                        }}
                      />
                    </span>
                  ) : (
                    <button
                      type="button"
                      role="tab"
                      data-sheet={item.id || "original"}
                      aria-selected={item.id === (active?.id || null)}
                      tabIndex={item.id === (active?.id || null) ? 0 : -1}
                      disabled={disabled || busy}
                      onClick={() => void select(item.id)}
                      onDoubleClick={() => {
                        if (item.id) void startRename(item as CopyInfo);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "F2" && item.id && canEdit) {
                          e.preventDefault();
                          void startRename(item as CopyInfo);
                        }
                      }}
                    >
                      {item.name}
                    </button>
                  )}
                  {item.id && canEdit && renaming?.copy.id !== item.id && (
                    <button
                      type="button"
                      className="sheet-tab-menu-trigger"
                      aria-label={`${item.name} 메뉴`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.id === item.id}
                      disabled={disabled || busy}
                      onClick={(e) => {
                        menuAnchor.current = e.currentTarget;
                        setMenu(
                          menu?.id === item.id ? null : (item as CopyInfo),
                        );
                      }}
                    >
                      <ChevronDown size={13} />
                    </button>
                  )}
                </div>
                {item.id === null && canEdit && (
                  <Button
                    className="sheet-add"
                    tooltip="사본 추가"
                    disabled={disabled || busy}
                    onClick={() => void create()}
                  >
                    <Plus size={17} />
                  </Button>
                )}
              </Fragment>
            ))}
          </div>
        </div>
        <span className="sheet-save-status visually-hidden" role="status">
          {status}
        </span>
        <div className="sheet-tab-scroll-controls">
          <Button
            tooltip="탭 왼쪽으로 스크롤"
            disabled={!scrollable.left}
            onClick={() => scrollTabs(-1)}
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            tooltip="탭 오른쪽으로 스크롤"
            disabled={!scrollable.right}
            onClick={() => scrollTabs(1)}
          >
            <ChevronRight size={16} />
          </Button>
        </div>
        {menu && (
          <div
            className="sheet-tab-menu"
            ref={menuElement}
            role="menu"
            aria-label={`${menu.name} 관리`}
          >
            <button role="menuitem" onClick={() => void startRename(menu)}>
              <Pencil size={14} />
              이름 변경
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setError("");
                setDialog({ kind: "delete", copy: menu });
                setMenu(null);
              }}
            >
              <Trash2 size={14} />
              사본 삭제
            </button>
          </div>
        )}
      </div>
      {error && !dialog && (
        <div className="board-error" role="alert" id="sheet-tabs-error">
          {error}
          <Button
            onClick={() => {
              setError("");
              void refresh().catch((e) => setError(e.message));
            }}
          >
            다시 불러오기
          </Button>
        </div>
      )}
      {dialog && (
        <Modal
          title={dialog.kind === "create" ? "사본 만들기" : "사본 삭제"}
          onClose={() => {
            if (!busy) {
              setDialog(null);
              setError("");
            }
          }}
          initialFocus={input}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {dialog.kind === "delete" ? (
              <p>‘{dialog.copy?.name}’ 사본을 삭제할까요?</p>
            ) : (
              <label>
                사본 이름
                <input
                  ref={input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={MAX_REPORT_NAME_LENGTH}
                  required
                  readOnly={busy}
                />
              </label>
            )}
            {error && (
              <p className="error-note" role="alert">
                {error}
              </p>
            )}
            <div className="sheet-copy-actions">
              <Button disabled={busy} onClick={() => setDialog(null)}>
                취소
              </Button>
              <Button
                type="submit"
                className={dialog.kind === "delete" ? "danger" : "primary"}
                disabled={busy}
              >
                {busy ? "처리 중…" : dialog.kind === "delete" ? "삭제" : "확인"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
