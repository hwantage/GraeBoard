import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import Select from "./Select";
import Toast, { useToast } from "./Toast";
import LoadingState from "./LoadingState";
import { busyProps } from "./busyProps";
import type { Team } from "./types";

type Kind = "year" | "document" | "images";
type DocumentTarget = {
  entity: string;
  key: unknown[];
  generation: string;
  label: string;
};
type Retention = {
  id: string;
  kind: Kind;
  label: string;
  key?: unknown[];
  generation?: string;
  revision: number;
};
type Job = {
  jobId: string;
  kind?: string;
  phase: string;
  hasMore: boolean;
  deleted: { count: number; bytes: number };
  error?: string;
};
type Scope = {
  siteId: string;
  siteName: string;
  years: number[];
  documents: DocumentTarget[];
  retention: Retention[];
  job?: Job | null;
};
type Preview = {
  token: string;
  siteName: string;
  teamName: string;
  revision: string;
  items: { label: string; count: number }[];
  images: { count: number; bytes: number };
  protected: { label?: string; reason: string; count: number }[];
};
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;

export default function SiteMaintenance({
  teams,
  initialTeamId,
}: {
  teams: Team[];
  initialTeamId: string;
}) {
  const [teamId, setTeamId] = useState(initialTeamId);
  const [scope, setScope] = useState<Scope | null>(null);
  const [kind, setKind] = useState<Kind>("year");
  const [year, setYear] = useState("");
  const [documentIndex, setDocumentIndex] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useToast();
  const live = useRef(true),
    stop = useRef(false);
  const request = useRef<AbortController | null>(null);
  const prefix = `/admin/teams/${teamId}/maintenance`;
  const selectedTeam = teams.find((team) => team.id === teamId);
  function invalidate() {
    request.current?.abort();
    setPreview(null);
    setLoading(false);
    setError("");
    setMessage("");
  }
  async function load(signal?: AbortSignal) {
    const next = await api<Scope>(prefix, { signal });
    if (!live.current || signal?.aborted) return;
    setScope(next);
    setJob(next.job || null);
    setYear((current) =>
      next.years.includes(Number(current))
        ? current
        : String(next.years[0] || ""),
    );
    setDocumentIndex("");
  }
  useEffect(() => {
    live.current = true;
    stop.current = false;
    const controller = new AbortController();
    setScope(null);
    setPreview(null);
    setJob(null);
    setError("");
    setLoading(true);
    load(controller.signal)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      live.current = false;
      stop.current = true;
      controller.abort();
      request.current?.abort();
    };
  }, [teamId]);
  async function inspect(event: FormEvent) {
    event.preventDefault();
    invalidate();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const document = scope?.documents[Number(documentIndex)];
    try {
      const next = await api<Preview>(`${prefix}/preview`, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          kind,
          ...(kind === "year"
            ? { year: Number(year) }
            : kind === "document" && document
              ? {
                  entity: document.entity,
                  key: document.key,
                  generation: document.generation,
                }
              : {}),
        }),
      });
      if (!controller.signal.aborted && live.current) setPreview(next);
    } catch (e) {
      if (!controller.signal.aborted && live.current)
        setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted && live.current) setLoading(false);
    }
  }
  async function execute(resume = false) {
    if (busy || (!resume && !preview) || (resume && !job)) return;
    if (
      !resume &&
      preview &&
      !confirm(
        `${preview.siteName}의 “${preview.teamName}” 자료를 정리할까요?` +
          `\n\n${preview.items.map((item) => `${item.label} ${item.count}건`).join("\n")}\n삭제 가능한 이미지 ${preview.images.count}개 · ${bytes(preview.images.bytes)}\n\n이 서버에서만 정리합니다. 상대 서버와 Git 이력은 유지됩니다.`,
      )
    )
      return;
    setBusy(true);
    stop.current = false;
    setError("");
    setMessage("");
    try {
      let result = await send<Job>(
        `${prefix}/${resume ? "resume" : "execute"}`,
        resume
          ? { jobId: job!.jobId }
          : { token: preview!.token, confirmed: true },
      );
      if (live.current) setJob(result);
      while (result.hasMore && !stop.current) {
        result = await send<Job>(`${prefix}/resume`, { jobId: result.jobId });
        if (live.current) setJob(result);
      }
      if (!live.current) return;
      setMessage(
        result.hasMore
          ? "현재 묶음까지 처리하고 중단했습니다. 이어서 진행할 수 있습니다."
          : result.kind === "restore"
            ? "보관본에서 자료를 복원했습니다."
            : "선택한 자료를 이 서버에서 정리했습니다.",
      );
      setPreview(null);
      await load();
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        setPreview(null);
        await load().catch(() => {});
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function restore(retention: Retention) {
    setBusy(true);
    stop.current = false;
    setError("");
    setMessage("");
    try {
      let result = await send<Job>(`${prefix}/restore`, {
        retentionId: retention.id,
        expectedRevision: retention.revision,
      });
      if (live.current) setJob(result);
      while (result.hasMore && !stop.current) {
        result = await send<Job>(`${prefix}/resume`, { jobId: result.jobId });
        if (live.current) setJob(result);
      }
      if (!live.current) return;
      setPreview(null);
      await load();
      setMessage(
        result.hasMore
          ? "현재 묶음까지 복원하고 중단했습니다. 이어서 진행할 수 있습니다."
          : "보관본에서 자료를 복원했습니다.",
      );
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        await load().catch(() => {});
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="history-cleanup" aria-label="연도·문서·이미지 정리">
      <div className="settings-team-header">
        <div>
          <h3>연도·문서·이미지 정리</h3>
          <p>선택한 팀의 자료를 현재 서버에서 정리합니다.</p>
        </div>
      </div>
      <ErrorNote error={error} />
      <Toast message={message} />
      <form className="history-cleanup-form" onSubmit={inspect}>
        <label>
          정리할 팀
          <Select
            aria-label="정리할 팀"
            value={teamId}
            {...busyProps(busy)}
            onChange={(event) => {
              invalidate();
              setTeamId(event.target.value);
            }}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </label>
        {scope && (
          <>
            <p className="field-help">
              현재 서버: {scope.siteName} · {selectedTeam?.name}
            </p>
            <div className="history-cleanup-controls">
              <label>
                정리 대상
                <Select
                  aria-label="정리 대상"
                  value={kind}
                  {...busyProps(busy, !!job?.hasMore)}
                  onChange={(event) => {
                    invalidate();
                    setKind(event.target.value as Kind);
                  }}
                >
                  <option value="year">연도</option>
                  <option value="document">문서</option>
                  <option value="images">미사용 이미지</option>
                </Select>
              </label>
              {kind === "year" && (
                <label>
                  정리할 연도
                  <Select
                    aria-label="정리할 연도"
                    value={year}
                    {...busyProps(busy)}
                    onChange={(event) => {
                      invalidate();
                      setYear(event.target.value);
                    }}
                  >
                    {!scope.years.length && (
                      <option value="">정리할 연도가 없습니다</option>
                    )}
                    {scope.years.map((value) => (
                      <option key={value} value={value}>
                        {value}년
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {kind === "document" && (
                <label>
                  정리할 문서
                  <Select
                    aria-label="정리할 문서"
                    value={documentIndex}
                    {...busyProps(busy)}
                    onChange={(event) => {
                      invalidate();
                      setDocumentIndex(event.target.value);
                    }}
                  >
                    <option value="">문서 선택</option>
                    {scope.documents.map((document, index) => (
                      <option
                        key={JSON.stringify([
                          document.entity,
                          document.key,
                          document.generation,
                        ])}
                        value={index}
                      >
                        {document.label}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <Button
                type="submit"
                {...busyProps(
                  busy || loading,
                  !!job?.hasMore ||
                    (kind === "year" && !year) ||
                    (kind === "document" && !documentIndex),
                )}
              >
                정리 대상 확인
              </Button>
            </div>
          </>
        )}
      </form>
      {loading && <LoadingState label="정리할 자료를 확인하고 있습니다." />}
      {preview && (
        <section
          className="history-cleanup-preview"
          aria-label="사이트 정리 미리보기"
        >
          <h4>
            {preview.siteName} · {preview.teamName}
          </h4>
          <table className="history-cleanup-table">
            <thead>
              <tr>
                <th scope="col">대상</th>
                <th scope="col">건수</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((item, index) => (
                <tr key={index}>
                  <th scope="row">{item.label}</th>
                  <td>{item.count}건</td>
                </tr>
              ))}
              <tr>
                <th scope="row">삭제 가능한 이미지</th>
                <td>
                  {preview.images.count}개 · {bytes(preview.images.bytes)}
                </td>
              </tr>
              {preview.protected.map((item, index) => (
                <tr key={`protected-${index}`}>
                  <th scope="row">보호 중 · {item.label || item.reason}</th>
                  <td>{item.count}건</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-help">
            공유 기준본의 본문과 Git 이력은 남습니다. 다른 문서·미전송
            변경·충돌에서 사용하는 이미지는 보호합니다.
          </p>
          <div className="form-actions">
            <Button
              className="danger"
              {...busyProps(
                busy,
                !preview.items.some((item) => item.count) &&
                  !preview.images.count,
              )}
              onClick={() => void execute()}
            >
              이 서버에서 정리
            </Button>
          </div>
        </section>
      )}
      {job && (
        <div className="history-cleanup-latest" role="status">
          <p>
            이미지 {job.deleted?.count || 0}개 ·{" "}
            {bytes(job.deleted?.bytes || 0)} 처리{" "}
            {job.phase === "failed"
              ? "(오류로 중단)"
              : job.hasMore
                ? "(일부 정리)"
                : "(완료)"}
          </p>
          {job.error && <p className="field-help">{job.error}</p>}
          {busy ? (
            <Button
              onClick={() => {
                stop.current = true;
              }}
            >
              중단
            </Button>
          ) : (
            job.hasMore && (
              <Button onClick={() => void execute(true)}>
                {job.kind === "restore" ? "이어서 복원" : "이어서 정리"}
              </Button>
            )
          )}
        </div>
      )}
      {!!scope?.retention.length && (
        <section aria-label="정리한 자료 복원">
          <h4>정리한 자료 복원</h4>
          <div className="settings-table-scroll">
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">자료</th>
                  <th scope="col">복원</th>
                </tr>
              </thead>
              <tbody>
                {scope.retention.map((retention) => (
                  <tr key={retention.id}>
                    <th scope="row">{retention.label}</th>
                    <td>
                      <Button
                        {...busyProps(busy, !!job?.hasMore)}
                        onClick={() => void restore(retention)}
                      >
                        보관본에서 복원
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
