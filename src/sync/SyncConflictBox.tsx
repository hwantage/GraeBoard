import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { api, send, type ApiError } from "../platform/api";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Modal } from "../ui/Modal";
import LoadingState from "../ui/LoadingState";
import SyncConflictDiff, { type ConflictOrigin } from "./SyncConflictDiff";
import SyncConflictRaw, { conflictRawText } from "./SyncConflictRaw";
import { busyProps } from "../ui/busyProps";
import { syncTime } from "./sync-types";
import type { User } from "../types";
import {
  conflictEditors,
  conflictKinds,
} from "../../shared/sync/conflict-diff.js";
import {
  RESOLUTION_REJECTED,
  rejectedBecause,
} from "../../shared/sync/conflict-origin.js";
import { syncErrorMessage } from "../../shared/sync/sync-error-message.js";
import "./team-sync-settings.css";

type Choice = "current" | "submitted" | "edited";
// A resolution both servers refused because it would conflict again (see
// resolutionRejected in shared/sync/conflict-origin.js).
type Refusal = { choice: Choice; reason: string | null };
export type Conflict = {
  conflictId: string;
  opId: string;
  createdAt: string;
  target: string;
  result: string;
  // The list carries no values; they arrive when the conflict is opened.
  base?: unknown;
  current?: unknown;
  desired?: unknown;
  expectedHead: string;
  frontier?: string[];
  resolved?: boolean;
  origin?: {
    held: ConflictOrigin;
    writers: Record<string, ConflictOrigin | null>;
  };
  // A resolution saved on this site and not yet published.
  pendingResolution?: {
    opId: string;
    createdAt: string;
    choice: Choice;
  } | null;
};

type LoadedConflict = Conflict &
  Required<Pick<Conflict, "base" | "current" | "desired">>;

const choices: Record<Choice, string> = {
  current: "먼저 수정으로 유지",
  submitted: "나중에 수정으로 덮어쓰기",
  edited: "고친 내용 적용",
};

// The conflict box as one popup, opened from the header warning and from the
// sync settings. A conflict whose resolution is saved but not yet published
// keeps showing until the next sync, without buttons, so it cannot be
// resolved twice (the servers refuse that as well).
export default function SyncConflictBox({
  teamId,
  people = [],
  onClose,
  onChanged,
}: {
  teamId: string;
  people?: User[];
  onClose: () => void;
  onChanged?: () => void;
}) {
  const prefix = `/teams/${teamId}/sync`;
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refusals, setRefusals] = useState<Record<string, Refusal>>({});
  // Conflicts checked for a batch resolution, and its progress or result.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState("");
  // A copy conflict carries whole sheets: compare only the expanded cards and
  // summarize each card once per loaded list, not on every checkbox click.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Values of the opened conflicts, kept across reloads of the list.
  const [values, setValues] = useState<
    Record<string, Pick<Conflict, "base" | "current" | "desired">>
  >({});
  const [valueErrors, setValueErrors] = useState<Record<string, string>>({});
  const listed = useMemo(
    () =>
      conflicts &&
      conflicts.map((conflict) =>
        conflict.desired === undefined && values[conflict.conflictId]
          ? { ...conflict, ...values[conflict.conflictId] }
          : conflict,
      ),
    [conflicts, values],
  );
  async function loadValues(conflictId: string) {
    setValueErrors((current) => ({ ...current, [conflictId]: "" }));
    try {
      const { base, current, desired } = await api<Conflict>(
        `${prefix}/conflicts/${encodeURIComponent(conflictId)}`,
      );
      setValues((kept) => ({
        ...kept,
        [conflictId]: { base, current, desired },
      }));
    } catch (error) {
      setValueErrors((current) => ({
        ...current,
        [conflictId]: `내용을 불러오지 못했습니다: ${syncErrorMessage(error) || (error as Error).message}`,
      }));
    }
  }
  const summaries = useMemo(
    () =>
      new Map(
        (listed || []).map((conflict) => [
          conflict.conflictId,
          {
            kind: conflictKinds(conflict.target) || "업무 변경",
            editors: conflict.origin ? conflictEditors(conflict) : "",
          },
        ]),
      ),
    [listed],
  );
  async function load(signal?: AbortSignal) {
    const result = await api<{ conflicts: Conflict[] }>(`${prefix}/conflicts`, {
      signal,
    });
    if (signal?.aborted) return;
    setLoadError("");
    const open = result.conflicts.filter((conflict) => !conflict.resolved);
    setConflicts(open);
    setSelected(
      (current) =>
        new Set(
          open
            .filter(
              (conflict) =>
                !conflict.pendingResolution && current.has(conflict.conflictId),
            )
            .map((conflict) => conflict.conflictId),
        ),
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((error: Error) => {
      if (!controller.signal.aborted)
        setLoadError(syncErrorMessage(error) || error.message);
    });
    return () => controller.abort();
  }, [teamId]);
  const fail = (conflictId: string, message: string) =>
    setErrors((current) => ({ ...current, [conflictId]: message }));
  // Remember a refusal so its card can guide the person to keep the first
  // edit; any other error stays a plain error note. Returns whether refused.
  const refuse = (conflictId: string, choice: Choice, error?: unknown) => {
    const details = (error as ApiError | undefined)?.details;
    const refused = details?.code === RESOLUTION_REJECTED;
    setRefusals((current) => {
      const next = { ...current };
      if (refused)
        next[conflictId] = { choice, reason: details.reason ?? null };
      else delete next[conflictId];
      return next;
    });
    return refused;
  };
  const submit = (conflict: Conflict, choice: Choice, desired?: unknown) =>
    send(
      `${prefix}/conflicts/${encodeURIComponent(conflict.conflictId)}/resolve`,
      {
        choice,
        ...(choice === "edited" ? { desired } : {}),
        expectedHead: conflict.expectedHead,
        frontier: conflict.frontier || [conflict.opId],
      },
    );
  const failure = (error: unknown) =>
    `충돌 해결 실패: ${syncErrorMessage(error) || (error as Error).message}`;
  // One request per conflict, in order, through the same API as a single
  // resolution; a failed one is reported on its card and the rest go on.
  async function resolveSelected(choice: "current" | "submitted") {
    const targets = (listed || []).filter(
      (conflict) =>
        selected.has(conflict.conflictId) && !conflict.pendingResolution,
    );
    if (busy || !targets.length) return;
    if (
      !confirm(
        choice === "current"
          ? `선택한 충돌 ${targets.length}개의 나중에 수정을 모두 버리고 먼저 수정으로 유지합니다. 계속할까요?`
          : `선택한 충돌 ${targets.length}개를 모두 나중에 수정으로 덮어씁니다. 먼저 수정이 바꾼 부분도 나중에 수정의 값으로 돌아갑니다. 계속할까요?`,
      )
    )
      return;
    setBusy(true);
    setEditing("");
    let saved = 0,
      refused = 0;
    for (const [index, conflict] of targets.entries()) {
      setBatch(`${index + 1}/${targets.length} 처리 중…`);
      fail(conflict.conflictId, "");
      refuse(conflict.conflictId, choice);
      try {
        await submit(conflict, choice);
        saved++;
      } catch (error) {
        if (refuse(conflict.conflictId, choice, error)) refused++;
        else fail(conflict.conflictId, failure(error));
      }
    }
    const failed = targets.length - saved;
    setBatch(
      !failed
        ? `충돌 ${saved}개의 해결 방법을 저장했습니다. 다음 동기화 때 상대 사이트에도 반영됩니다.`
        : `${saved}개 저장, ${failed}개 실패했습니다. ` +
            (refused
              ? `이 중 ${refused}개는 반영하면 다시 충돌해 저장하지 않았습니다. "덮어쓰기 불가" 항목을 펼쳐 사라질 나중에 수정 내용을 확인하고 정리한 뒤 먼저 수정으로 유지하세요.` +
                (failed > refused
                  ? " 나머지는 항목을 펼쳐 이유를 확인하세요."
                  : "")
              : "실패한 항목을 펼쳐 이유를 확인하세요."),
    );
    if (saved) onChanged?.();
    await load().catch(() => {});
    setBusy(false);
  }
  async function resolve(conflict: Conflict, choice: Choice) {
    if (busy) return;
    let desired: unknown;
    if (choice === "edited") {
      try {
        desired =
          typeof conflict.desired === "string" ? draft : JSON.parse(draft);
      } catch {
        fail(conflict.conflictId, "적용할 내용의 형식을 확인하세요.");
        return;
      }
    }
    setBusy(true);
    fail(conflict.conflictId, "");
    refuse(conflict.conflictId, choice);
    try {
      await submit(conflict, choice, desired);
      setEditing("");
      onChanged?.();
    } catch (error) {
      // Keep manually edited text on a rejected or interrupted resolution.
      if (!refuse(conflict.conflictId, choice, error))
        fail(conflict.conflictId, failure(error));
    } finally {
      // Show the saved resolution, or what another tab already saved.
      await load().catch(() => {});
      setBusy(false);
    }
  }
  // Rendered at the body: opened from the top bar or the settings popup, it
  // would otherwise inherit their compact button and layout styles.
  return createPortal(
    <Modal
      title="충돌 보관함"
      help="같은 항목을 사내와 외부에서 함께 고쳐, 나중에 수정이 반영되지 않고 보관된 목록입니다. 항목을 펼쳐 두 수정을 비교한 뒤 해결 방법을 고르세요."
      wide
      className="sync-conflict-box"
      onClose={onClose}
    >
      {loadError ? (
        <ErrorNote error={loadError} />
      ) : !listed ? (
        <LoadingState label="충돌 보관함을 불러오는 중" />
      ) : !listed.length ? (
        <p className="field-help">보관된 충돌이 없습니다.</p>
      ) : (
        <>
          <BatchBar
            conflicts={listed}
            selected={selected}
            busy={busy}
            status={batch}
            onSelect={setSelected}
            onResolve={(choice) => void resolveSelected(choice)}
          />
          <section className="team-sync-conflicts" aria-label="충돌 보관함">
            {listed.map((conflict) => {
              const loaded = conflict.desired !== undefined,
                saved = conflict.pendingResolution,
                edit = editing === conflict.conflictId,
                refusal = saved ? undefined : refusals[conflict.conflictId],
                summary = summaries.get(conflict.conflictId)!;
              return (
                <details
                  key={conflict.conflictId}
                  className="team-sync-conflict"
                  onToggle={(event) => {
                    if (event.target !== event.currentTarget) return;
                    const open = event.currentTarget.open;
                    if (open && !loaded) void loadValues(conflict.conflictId);
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (open) next.add(conflict.conflictId);
                      else next.delete(conflict.conflictId);
                      return next;
                    });
                  }}
                >
                  <summary>
                    <input
                      type="checkbox"
                      className="team-sync-conflict-check"
                      aria-label={`${summary.kind} 충돌 선택`}
                      checked={selected.has(conflict.conflictId)}
                      disabled={!!saved || busy}
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (!next.delete(conflict.conflictId))
                            next.add(conflict.conflictId);
                          return next;
                        })
                      }
                    />
                    <ChevronRight
                      className="team-sync-conflict-chevron"
                      size={14}
                      aria-hidden="true"
                    />
                    <span className="team-sync-conflict-kind">
                      {summary.kind}
                    </span>
                    {conflict.origin && (
                      <span className="team-sync-conflict-people">
                        {summary.editors}
                      </span>
                    )}
                    {saved && (
                      <span className="tag team-sync-conflict-saved">
                        해결 저장됨
                      </span>
                    )}
                    {refusal && (
                      <span className="tag team-sync-conflict-refused">
                        {refusal.choice === "edited"
                          ? "고친 내용 충돌"
                          : "덮어쓰기 불가"}
                      </span>
                    )}
                    <time dateTime={conflict.createdAt}>
                      {syncTime(conflict.createdAt)}
                    </time>
                  </summary>
                  <div className="team-sync-conflict-body">
                    {saved && (
                      <p className="team-sync-conflict-notice" role="status">
                        해결 방법을 저장했습니다:{" "}
                        <strong>{choices[saved.choice]}</strong> (
                        {syncTime(saved.createdAt)}). 다음 동기화 때 상대
                        사이트에도 반영되고, 그 뒤 이 목록에서 사라집니다.
                      </p>
                    )}
                    {refusal && <RefusalGuide refusal={refusal} />}
                    {!loaded ? (
                      valueErrors[conflict.conflictId] ? (
                        <>
                          <ErrorNote error={valueErrors[conflict.conflictId]} />
                          <p className="field-help">
                            내용을 보지 않고도 아래에서 해결 방법을 고를 수
                            있습니다.
                          </p>
                        </>
                      ) : (
                        <LoadingState label="충돌 내용을 불러오는 중" />
                      )
                    ) : (
                      <>
                        {expanded.has(conflict.conflictId) && (
                          <SyncConflictDiff
                            conflict={conflict as LoadedConflict}
                            people={people}
                          />
                        )}
                        <SyncConflictRaw
                          conflict={conflict as LoadedConflict}
                        />
                      </>
                    )}
                    {!saved && edit && (
                      <label className="team-sync-conflict-edit">
                        적용할 내용
                        <textarea
                          aria-label="적용할 내용"
                          rows={8}
                          value={draft}
                          {...busyProps(busy)}
                          onChange={(event) => setDraft(event.target.value)}
                        />
                      </label>
                    )}
                    {!saved && (
                      <div className="form-actions">
                        {edit ? (
                          <>
                            <Button
                              {...busyProps(busy)}
                              onClick={() => setEditing("")}
                            >
                              편집 취소
                            </Button>
                            <Button
                              className="primary"
                              {...busyProps(busy)}
                              onClick={() => void resolve(conflict, "edited")}
                            >
                              고친 내용 적용
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              className={refusal ? "primary" : undefined}
                              {...busyProps(busy)}
                              onClick={() => void resolve(conflict, "current")}
                            >
                              {choices.current}
                            </Button>
                            <Button
                              {...busyProps(busy)}
                              onClick={() =>
                                void resolve(conflict, "submitted")
                              }
                            >
                              {choices.submitted}
                            </Button>
                            <Button
                              {...busyProps(busy, !loaded)}
                              onClick={() => {
                                setEditing(conflict.conflictId);
                                setDraft(conflictRawText(conflict.desired));
                              }}
                            >
                              직접 고치기
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    <ErrorNote error={errors[conflict.conflictId] || ""} />
                  </div>
                </details>
              );
            })}
          </section>
        </>
      )}
    </Modal>,
    document.body,
  );
}

/**
 * A refused resolution would only be archived again, so the card explains why
 * and how to settle it: review what keeping the first edit discards, copy what
 * must stay, then keep the first edit.
 */
function RefusalGuide({ refusal }: { refusal: Refusal }) {
  return (
    <div className="team-sync-conflict-guide" role="alert">
      <p>
        <strong>
          {refusal.choice === "edited"
            ? "고친 내용으로 해결할 수 없습니다."
            : "나중에 수정으로 덮어쓸 수 없습니다."}
        </strong>{" "}
        {rejectedBecause(refusal.reason)} 상황이 그대로면 다시 눌러도 같은
        이유로 저장되지 않으니 아래 순서로 정리하세요.
      </p>
      <ol>
        <li>
          아래 비교에서 <strong>나중에 수정</strong>을 눌러, 먼저 수정으로
          유지하면 사라질 내용을 확인합니다. 겹치지 않은 항목이 있으면 함께 펼쳐
          확인하세요.
        </li>
        <li>
          남겨야 할 내용은 복사해 두었다가, 충돌을 정리한 뒤 화면에서 다시
          입력합니다.
        </li>
        <li>
          <strong>먼저 수정으로 유지</strong>를 누릅니다. 나중에 수정은
          버려지고, 이 항목은 다음 동기화 뒤 목록에서 사라집니다.
        </li>
      </ol>
      {refusal.reason === "Duplicate name" && (
        <p>
          나중에 수정을 그대로 살리려면 <strong>직접 고치기</strong>에서
          이름(name)을 겹치지 않게 바꿔 적용할 수도 있습니다.
        </p>
      )}
    </div>
  );
}

/** Select all and resolve the checked conflicts the same way. */
function BatchBar({
  conflicts,
  selected,
  busy,
  status,
  onSelect,
  onResolve,
}: {
  conflicts: Conflict[];
  selected: Set<string>;
  busy: boolean;
  status: string;
  onSelect: (selected: Set<string>) => void;
  onResolve: (choice: "current" | "submitted") => void;
}) {
  const selectable = conflicts
    .filter((conflict) => !conflict.pendingResolution)
    .map((conflict) => conflict.conflictId);
  const all = selectable.length > 0 && selected.size === selectable.length;
  return (
    <div className="team-sync-conflict-batch">
      {/* The same names as on each card; this group applies them to the
          checked conflicts. */}
      <div
        className="team-sync-conflict-batch-bar"
        role="group"
        aria-label="선택한 충돌 일괄 해결"
      >
        <label>
          <input
            type="checkbox"
            checked={all}
            ref={(input) => {
              if (input) input.indeterminate = selected.size > 0 && !all;
            }}
            disabled={!selectable.length || busy}
            onChange={() => onSelect(new Set(all ? [] : selectable))}
          />
          전체 선택
        </label>
        <span className="team-sync-conflict-batch-count">
          {selected.size}개 선택
        </span>
        <Button
          {...busyProps(busy, !selected.size)}
          onClick={() => onResolve("current")}
        >
          {choices.current}
        </Button>
        <Button
          {...busyProps(busy, !selected.size)}
          onClick={() => onResolve("submitted")}
        >
          {choices.submitted}
        </Button>
      </div>
      {status && (
        <p className="team-sync-conflict-batch-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
