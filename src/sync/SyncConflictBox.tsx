import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { api, send } from "../platform/api";
import { Button, ErrorNote, Modal } from "../components";
import LoadingState from "../ui/LoadingState";
import SyncConflictDiff, { type ConflictOrigin } from "./SyncConflictDiff";
import { busyProps } from "../ui/busyProps";
import { syncTime } from "./sync-types";
import type { User } from "../types";
import { conflictEditors, conflictKinds } from "../../shared/sync/conflict-diff.js";
import { syncErrorMessage } from "../../shared/sync/sync-error-message.js";
import "./team-sync-settings.css";

type Choice = "current" | "submitted" | "edited";
export type Conflict = {
  conflictId: string;
  opId: string;
  createdAt: string;
  target: string;
  result: string;
  base: unknown;
  current: unknown;
  desired: unknown;
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

const choices: Record<Choice, string> = {
  current: "먼저 수정으로 유지",
  submitted: "나중에 수정으로 덮어쓰기",
  edited: "고친 내용 적용",
};

const display = (value: unknown) =>
  typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "없음");

const raw = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

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
  // Conflicts checked for a batch resolution, and its progress or result.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState("");
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
    const targets = (conflicts || []).filter(
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
    let saved = 0;
    for (const [index, conflict] of targets.entries()) {
      setBatch(`${index + 1}/${targets.length} 처리 중…`);
      fail(conflict.conflictId, "");
      try {
        await submit(conflict, choice);
        saved++;
      } catch (error) {
        fail(conflict.conflictId, failure(error));
      }
    }
    const failed = targets.length - saved;
    setBatch(
      failed
        ? `${saved}개 저장, ${failed}개 실패했습니다. 실패한 항목을 펼쳐 이유를 확인하세요.`
        : `충돌 ${saved}개의 해결 방법을 저장했습니다. 다음 동기화 때 상대 사이트에도 반영됩니다.`,
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
    try {
      await submit(conflict, choice, desired);
      setEditing("");
      onChanged?.();
    } catch (error) {
      // Keep manually edited text on a rejected or interrupted resolution.
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
      ) : !conflicts ? (
        <LoadingState label="충돌 보관함을 불러오는 중" />
      ) : !conflicts.length ? (
        <p className="field-help">보관된 충돌이 없습니다.</p>
      ) : (
        <>
          <BatchBar
            conflicts={conflicts}
            selected={selected}
            busy={busy}
            status={batch}
            onSelect={setSelected}
            onResolve={(choice) => void resolveSelected(choice)}
          />
          <section className="team-sync-conflicts" aria-label="충돌 보관함">
            {conflicts.map((conflict) => {
              const saved = conflict.pendingResolution,
                edit = editing === conflict.conflictId;
              return (
                <details
                  key={conflict.conflictId}
                  className="team-sync-conflict"
                >
                  <summary>
                    <input
                      type="checkbox"
                      className="team-sync-conflict-check"
                      aria-label={`${conflictKinds(conflict.target) || "업무 변경"} 충돌 선택`}
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
                      {conflictKinds(conflict.target) || "업무 변경"}
                    </span>
                    {conflict.origin && (
                      <span className="team-sync-conflict-people">
                        {conflictEditors(conflict)}
                      </span>
                    )}
                    {saved && (
                      <span className="tag team-sync-conflict-saved">
                        해결 저장됨
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
                    <SyncConflictDiff conflict={conflict} people={people} />
                    <details className="sync-conflict-raw">
                      <summary>원본 JSON 보기</summary>
                      <dl>
                        <dt>원래 내용</dt>
                        <dd>
                          <pre style={raw}>{display(conflict.base)}</pre>
                        </dd>
                        <dt>지금 내용(먼저 수정 반영)</dt>
                        <dd>
                          <pre style={raw}>{display(conflict.current)}</pre>
                        </dd>
                        <dt>나중에 수정</dt>
                        <dd>
                          <pre style={raw}>{display(conflict.desired)}</pre>
                        </dd>
                      </dl>
                    </details>
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
                              {...busyProps(busy)}
                              onClick={() => {
                                setEditing(conflict.conflictId);
                                setDraft(display(conflict.desired));
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
