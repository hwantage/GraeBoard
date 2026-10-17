import { useEffect, useRef, useState, type FormEvent } from "react";
import { HardDrive, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { todayKey } from "../shared/domain.js";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import Toast, { useToast } from "./Toast";
import LoadingState from "./LoadingState";

type Count = { count: number; bytes: number };
type Summary = Count & { oldest: string | null; newest: string | null };
type Deleted = { audit: Count; operations: Count };
type CleanupResult = {
  deleted: Deleted;
  hasMore: boolean;
  completed: boolean;
  updatedAt: string;
  beforeDate: string;
};
type Storage = {
  id: string;
  name: string;
  currentBytes: number;
  reportBytes: number;
  importBytes: number;
  totalBytes: number;
  audit: Count;
  operations: Count;
  latest: (CleanupResult & { actor: string }) | null;
};
type Preview = {
  token: string;
  scope: { id: string; name: string };
  beforeDate: string;
  audit: { stored: Summary; before: Summary; eligible: Summary };
  operations: { stored: Summary; before: Summary; eligible: Summary };
};
const number = (value: number) => value.toLocaleString("ko-KR");
const bytes = (value: number) => {
  const units = ["B", "KiB", "MiB", "GiB"];
  const index = value
    ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024)))
    : 0;
  return `${index ? (value / 1024 ** index).toFixed(1) : number(value)} ${units[index]}`;
};
const date = (value: string) =>
  new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const totalCount = (value: Deleted) =>
  value.audit.count + value.operations.count;
function daysAgo(days: number) {
  const day = new Date(`${todayKey()}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
}

export default function HistoryCleanup({
  initialTeamId,
}: {
  initialTeamId: string;
}) {
  const [scopeId, setScopeId] = useState(initialTeamId);
  const [beforeDate, setBeforeDate] = useState(() => daysAgo(365));
  const [scopes, setScopes] = useState<Storage[]>([]);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useToast();
  const stop = useRef(false);
  const previewElement = useRef<HTMLElement | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const selected = scopes.find((scope) => scope.id === scopeId);
  useEffect(() => {
    stop.current = false;
    return () => {
      stop.current = true;
      previewRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (preview) previewElement.current?.scrollIntoView({ block: "nearest" });
  }, [preview]);
  useEffect(() => {
    const controller = new AbortController();
    setStorageLoading(true);
    api<{ scopes: Storage[] }>("/admin/history-cleanup/storage", {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setScopes(result.scopes);
        setScopeId((current) =>
          result.scopes.some((scope) => scope.id === current)
            ? current
            : result.scopes[0].id,
        );
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setStorageLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  function invalidatePreview() {
    previewRequest.current?.abort();
    setPreviewLoading(false);
    setPreview(null);
    setError("");
    setMessage("");
  }
  async function check(e: FormEvent) {
    e.preventDefault();
    if (!selected || running) return;
    invalidatePreview();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewLoading(true);
    try {
      const result = await api<Preview>(
        `/admin/history-cleanup?${new URLSearchParams({ scopeId, beforeDate })}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setPreview(result);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setPreviewLoading(false);
    }
  }
  async function cleanup() {
    if (
      !preview ||
      running ||
      preview.scope.id !== scopeId ||
      preview.beforeDate !== beforeDate
    )
      return;
    const count =
      preview.audit.eligible.count + preview.operations.eligible.count;
    if (
      !count ||
      !confirm(
        `“${preview.scope.name}”의 ${preview.beforeDate} 00:00 (한국 시간) 이전 데이터만 삭제할까요?\n\n변경 이력 ${number(preview.audit.eligible.count)}건 · ${bytes(preview.audit.eligible.bytes)}\n저장 재시도 기록 ${number(preview.operations.eligible.count)}건 · ${bytes(preview.operations.eligible.bytes)}\n\n삭제한 이력은 조회하거나 복원할 수 없습니다. 현재 업무·계정·사본·백업과 다른 팀의 이력은 유지됩니다.`,
      )
    )
      return;
    stop.current = false;
    setRunning(true);
    setProgress(0);
    setError("");
    setMessage("");
    try {
      let result: CleanupResult;
      do {
        result = await send<CleanupResult>("/admin/history-cleanup", {
          token: preview.token,
          confirmed: true,
        });
        setProgress(totalCount(result.deleted));
      } while (result.hasMore && !stop.current);
      setMessage(
        result.hasMore
          ? `${preview.scope.name}: ${number(totalCount(result.deleted))}건을 삭제하고 중단했습니다. 남은 용량을 다시 확인해 계속할 수 있습니다.`
          : `${preview.scope.name}: 변경 이력 ${number(result.deleted.audit.count)}건과 저장 재시도 기록 ${number(result.deleted.operations.count)}건을 삭제했습니다.`,
      );
      setPreview(null);
      setRevision((value) => value + 1);
    } catch (e) {
      setError(
        `${(e as Error).message} 이미 처리한 삭제는 유지됩니다. 용량을 다시 확인하세요.`,
      );
      setPreview(null);
    } finally {
      setRunning(false);
    }
  }
  const eligible = preview
    ? preview.audit.eligible.count + preview.operations.eligible.count
    : 0;
  const protectedCount = preview
    ? preview.audit.before.count + preview.operations.before.count - eligible
    : 0;
  return (
    <section
      className="history-cleanup"
      aria-labelledby="history-cleanup-heading"
    >
      <div className="settings-team-header">
        <div>
          <h3 id="history-cleanup-heading">변경 이력 정리</h3>
          <p>
            팀별 저장 용량을 확인하고, 선택한 날짜 이전의 이력만 정리합니다.
          </p>
        </div>
        <Button
          disabled={storageLoading || running}
          onClick={() => {
            invalidatePreview();
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw size={15} />
          현황 새로고침
        </Button>
      </div>
      <ErrorNote error={error} />
      <Toast message={message} />
      {storageLoading &&
        (scopes.length ? (
          <p className="history-cleanup-progress" role="status">
            <LoaderCircle size={16} className="spin" />
            저장 용량을 확인하고 있습니다.
          </p>
        ) : (
          <LoadingState label="저장 용량을 확인하고 있습니다." />
        ))}
      {!!scopes.length && (
        <>
          <div className="history-cleanup-table-wrap">
            <table className="history-cleanup-table history-storage-table">
              <caption>팀별 저장 용량</caption>
              <thead>
                <tr>
                  <th scope="col">팀</th>
                  <th scope="col">전체 데이터</th>
                  <th scope="col">변경 이력</th>
                  <th scope="col">사본</th>
                </tr>
              </thead>
              <tbody>
                {scopes.map((scope) => (
                  <tr
                    key={scope.id}
                    className={scope.id === scopeId ? "selected" : ""}
                  >
                    <th scope="row">
                      <label>
                        <input
                          type="radio"
                          name="cleanup-team"
                          aria-label={`${scope.name} 선택`}
                          checked={scope.id === scopeId}
                          disabled={running}
                          onChange={() => {
                            invalidatePreview();
                            setScopeId(scope.id);
                          }}
                        />
                        {scope.name}
                      </label>
                    </th>
                    <td>
                      <strong>{bytes(scope.totalBytes)}</strong>
                    </td>
                    <td>
                      {bytes(scope.audit.bytes)}
                      <small>{number(scope.audit.count)}건</small>
                    </td>
                    <td>{bytes(scope.reportBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <>
              <p className="history-storage-detail">
                {selected.name} · 업무·설정 {bytes(selected.currentBytes)} ·
                가져오기 {bytes(selected.importBytes)} · 저장 재시도{" "}
                {bytes(selected.operations.bytes)}
              </p>
              <p className="field-help">
                본문·설정·압축 사본의 저장 용량입니다. 계정 정보와 DB 공통
                공간은 제외합니다. 시스템 공통은 공통 이력과 여러 팀이 공유하는
                재시도 기록입니다.
              </p>
              <form className="history-cleanup-form" onSubmit={check}>
                <h4>{selected.name} 이력 삭제</h4>
                <div className="history-cleanup-controls">
                  <div
                    className="history-cleanup-presets"
                    role="group"
                    aria-label="기준 날짜 선택"
                  >
                    {([30, 90, 180, 365] as const).map((days) => {
                      const presetDate = daysAgo(days);
                      const active = beforeDate === presetDate;
                      return (
                        <Button
                          key={days}
                          active={active}
                          aria-pressed={active}
                          disabled={running}
                          onClick={() => {
                            invalidatePreview();
                            setBeforeDate(presetDate);
                          }}
                        >
                          {days}일 전
                        </Button>
                      );
                    })}
                    <input
                      className="history-cleanup-date"
                      type="date"
                      aria-label="기준 날짜"
                      value={beforeDate}
                      min="2000-01-01"
                      max={todayKey()}
                      required
                      disabled={running}
                      onChange={(e) => {
                        invalidatePreview();
                        setBeforeDate(e.target.value);
                      }}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="primary"
                    disabled={running || previewLoading || !beforeDate}
                  >
                    {previewLoading ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <HardDrive size={15} />
                    )}
                    데이터 용량 확인
                  </Button>
                </div>
                <p className="field-help">
                  선택한 날짜의 00:00 이전 기록을 확인합니다 (한국 시간, 해당
                  날짜 제외).
                </p>
              </form>
              {selected.latest && (
                <p className="field-help history-cleanup-latest">
                  최근 정리: {date(selected.latest.updatedAt)} ·{" "}
                  {selected.latest.actor} ·{" "}
                  {number(totalCount(selected.latest.deleted))}건
                  {selected.latest.completed ? " 완료" : " 처리 (일부 정리)"}
                </p>
              )}
            </>
          )}
        </>
      )}
      {preview && (
        <section
          ref={previewElement}
          className="history-cleanup-preview"
          aria-label="삭제 대상 미리보기"
        >
          <h4>
            {preview.scope.name} · {preview.beforeDate} 이전
          </h4>
          <div className="history-cleanup-table-wrap">
            <table className="history-cleanup-table">
              <caption>기준 날짜 이전 데이터</caption>
              <thead>
                <tr>
                  <th scope="col">항목</th>
                  <th scope="col">날짜 이전 전체</th>
                  <th scope="col">삭제 가능</th>
                  <th scope="col">삭제할 용량</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["변경 이력", preview.audit],
                    ["저장 재시도 기록", preview.operations],
                  ] as const
                ).map(([label, item]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>
                      {number(item.before.count)}건
                      <small>{bytes(item.before.bytes)}</small>
                    </td>
                    <td>
                      <strong>{number(item.eligible.count)}건</strong>
                    </td>
                    <td>{bytes(item.eligible.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {protectedCount > 0 && (
            <p className="field-help">
              {number(protectedCount)}건은 저장 재시도에 필요해 삭제에서
              제외됩니다. 재시도는 7일 동안 보호합니다.
            </p>
          )}
          {!eligible && (
            <p className="field-help">
              이 날짜 이전에 삭제할 수 있는 데이터가 없습니다.
            </p>
          )}
          <div className="settings-danger">
            <div>
              <h4>확인한 이력 영구 삭제</h4>
              <p>
                현재 업무·사본·백업과 최대 50회의 실행 취소는 유지됩니다. 삭제
                공간은 다음 저장에 재사용되며 DB 파일 크기는 바로 줄지 않을 수
                있습니다.
              </p>
            </div>
            <Button
              className="danger"
              disabled={running || !eligible}
              onClick={cleanup}
            >
              <Trash2 size={15} />
              이전 데이터 삭제
            </Button>
          </div>
        </section>
      )}
      {running && (
        <div className="history-cleanup-progress" role="status">
          <LoaderCircle size={16} className="spin" />
          {number(progress)}건 삭제 중
          <Button
            onClick={() => {
              stop.current = true;
            }}
          >
            중단
          </Button>
        </div>
      )}
    </section>
  );
}
