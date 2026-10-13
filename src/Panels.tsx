import Select from "./Select";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Upload,
  Plus,
  ChevronRight,
  Trash2,
  LoaderCircle,
  FileSpreadsheet,
  Copy,
  EyeOff,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  CalendarDays,
  CalendarPlus,
  Pencil,
} from "lucide-react";
import { api, send, download, taskQuery } from "./api";
import { Modal, Button, ErrorNote, Empty } from "./components";
import Toast, { useToast } from "./Toast";
import PropertyBadge from "./PropertyBadge";
import MemberValue from "./MemberValue";
import HistoryTime, { HistoryTimeline } from "./HistoryTime";
import { describeStyle } from "./history";
import { pack, compactStyle } from "../shared/compact.js";
import type { Task, User, View, Report, Point, Settings } from "./types";
import {
  fieldsFor,
  propertiesFor,
  displayValue,
  canEdit,
  canContribute,
  canManageTeam,
  cell,
  value,
  todayKey,
} from "../shared/domain.js";

const AUDIT_LABELS: Record<string, string> = {
  format: "공통 서식 변경",
  cells: "셀 편집",
  reorder: "업무 순서 변경",
  "property-convert": "속성 종류 변경",
  "team-update": "팀 정보 변경",
  "history-cleanup": "변경 이력 정리",
  "team-create": "팀 생성",
  "team-members": "구성원 변경",
  create: "업무 추가",
  delete: "업무 삭제",
  restore: "업무 복구",
  report: "보고서 스냅샷 저장",
  "report-delete": "보고서 스냅샷 삭제",
  settings: "설정 변경",
  export: "내보내기",
  import: "자료 가져오기",
  task: "업무 이동·이월",
  setup: "초기 설정",
};
const formatDateTime = (iso: string) => new Date(iso).toLocaleString("ko-KR");

export function RowPanel({
  settings,
  task,
  user,
  users,
  readOnly = false,
  onClose,
  onEdit,
  onAction,
}: {
  task: Task;
  settings: Settings;
  user: User;
  users: User[];
  // 스냅샷처럼 읽기 전용 화면에서는 권한과 무관하게 편집 동작을 숨긴다.
  readOnly?: boolean;
  onClose: () => void;
  onEdit: (p: Point) => void;
  onAction: (action: string) => void;
}) {
  const editable = !readOnly && canEdit(user, task);
  return (
    <Modal title="업무 상세" onClose={onClose} className="task-detail-modal">
      <div className="task-detail-heading">
        <p className="task-detail-year">
          <CalendarDays size={14} /> 관리 연도 {task.years.join(" · ")}
        </p>
        <h3 className="task-detail-title">
          {String(value(task, "title")) || "제목 없는 업무"}
        </h3>
      </div>
      <dl className="detail-fields">
        {propertiesFor(settings)
          .filter((f) => f.id !== "title")
          .map((f) => {
            const raw = value(task, f.id);
            const text = displayValue(task, f.id, users, settings);
            const wide =
              f.kind === "text" &&
              (f.id === "description" ||
                text.includes("\n") ||
                text.length > 60);
            return (
              <div key={f.id} className={wide ? "detail-field-wide" : ""}>
                <dt>{f.name}</dt>
                <dd>
                  <button
                    className={`detail-field-value ${text ? "" : "is-empty"}`}
                    aria-label={`${f.name} 수정`}
                    disabled={!editable}
                    onClick={() => onEdit({ taskId: task.id, key: f.id })}
                  >
                    <span>
                      {!text ? (
                        "미입력"
                      ) : f.kind === "option" ? (
                        <PropertyBadge property={f} value={String(raw)} />
                      ) : f.kind === "member" ? (
                        <MemberValue property={f} value={raw} users={users} />
                      ) : (
                        text
                      )}
                    </span>
                    {editable && (
                      <Pencil
                        className="detail-edit-icon"
                        size={13}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </dd>
              </div>
            );
          })}
      </dl>
      <details className="task-detail-meta">
        <summary>업무 정보</summary>
        <p>
          <span>업무 ID</span>
          <code>{task.id}</code>
        </p>
      </details>
      <footer className="task-detail-actions">
        <div className="task-utility-actions">
          <Button onClick={() => onAction("hide")}>
            <EyeOff size={16} />이 업무 숨기기
          </Button>
          {!readOnly && canContribute(user, task.teamId) && (
            <Button onClick={() => onAction("duplicate")}>
              <Copy size={16} />
              복제
            </Button>
          )}
          {editable && (
            <Button onClick={() => onAction("carry")}>
              <CalendarPlus size={16} />
              다음 연도에도 표시
            </Button>
          )}
        </div>
        {editable && (
          <div className="task-order-actions">
            <div role="group" aria-label="업무 순서 이동">
              <Button onClick={() => onAction("up")}>
                <ArrowUp size={16} />
                위로
              </Button>
              <Button onClick={() => onAction("down")}>
                <ArrowDown size={16} />
                아래로
              </Button>
            </div>
            <Button className="danger" onClick={() => onAction("delete")}>
              <Trash2 size={16} />
              휴지통으로 이동
            </Button>
          </div>
        )}
      </footer>
    </Modal>
  );
}

export function ExportPanel({
  teamId,
  year,
  startMonth,
  taskIds,
  keys,
  onClose,
}: {
  teamId: string;
  year: number;
  startMonth: number;
  taskIds: string[];
  keys: string[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState("xlsx"),
    [scope, setScope] = useState("view"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="업무 내보내기"
      help="필요한 범위와 파일 형식을 선택하세요."
      onClose={onClose}
    >
      <label>
        내보낼 범위
        <Select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="view">
            현재 보기 · {taskIds.length}개 업무 (숨김 제외)
          </option>
          <option value="all">
            기준 연도 {year}년 전체 · 필터와 숨김 포함
          </option>
        </Select>
      </label>
      <label>
        파일 형식
        <Select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="xlsx">Excel (.xlsx) · 값과 기본 서식</option>
          <option value="csv">CSV (.csv) · 값만</option>
          <option value="json">JSON (.json) · ID·서식·스냅샷 보관</option>
        </Select>
      </label>
      <p className="field-help">
        JSON 전체 반출은 스냅샷(관리자), 본인의 보기 설정과 담당자 정보를
        포함합니다. 계정 비밀번호와 로그인 정보는 포함하지 않습니다.
      </p>
      <ErrorNote error={error} />
      <footer className="form-actions">
        <Button onClick={onClose}>취소</Button>
        <Button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await download("/export", {
                teamId,
                year,
                startMonth: scope === "view" ? startMonth : 1,
                format,
                scope,
                taskIds,
                keys,
              });
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}
          내보내기
        </Button>
      </footer>
    </Modal>
  );
}
export function ImportPanel({
  teamId,
  year,
  onClose,
  onDone,
}: {
  teamId: string;
  year: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<any>(null),
    [sheet, setSheet] = useState(""),
    [personMap, setPersonMap] = useState<Record<string, string>>({}),
    [mode, setMode] = useState("tasks"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [accepted, setAccepted] = useState(false),
    [referenceDate, setReferenceDate] = useState(todayKey());
  const selected = preview?.sheets.find((s: any) => s.name === sheet);
  async function choose(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("teamId", teamId);
      body.set("year", String(year));
      const result = await api("/import/preview", { method: "POST", body });
      setPreview(result);
      setSheet(
        result.sheets.find((s: any) => s.count)?.name ||
          result.sheets[0]?.name ||
          "",
      );
      setPersonMap(result.personMap);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="기존 업무 가져오기"
      help="Google Sheets에서 다운로드한 XLSX 파일을 선택하세요. 미리보기를 확인한 뒤 반영합니다."
      wide
      onClose={onClose}
    >
      <label className="upload-zone">
        <FileSpreadsheet size={30} />
        <strong>{busy ? "파일을 확인하고 있습니다" : "XLSX 파일 선택"}</strong>
        <span>최대 25MB · 숨겨진 행과 주차도 포함합니다</span>
        <input
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
      <ErrorNote error={error} />
      {preview && (
        <>
          <div className="form-grid">
            <label>
              가져올 시트
              <Select
                value={sheet}
                onChange={(e) => {
                  setSheet(e.target.value);
                  setAccepted(false);
                }}
              >
                {preview.sheets.map((s: any) => (
                  <option key={s.name} value={s.name}>
                    {s.name} · {s.count}개
                  </option>
                ))}
              </Select>
            </label>
            <label>
              반영 방식
              <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="tasks">운영 업무로 추가</option>
                <option value="report">과거 보고서 스냅샷으로 보관</option>
              </Select>
            </label>
            {mode === "report" && (
              <label>
                보고 기준일
                <input
                  type="date"
                  value={referenceDate}
                  onChange={(e) => setReferenceDate(e.target.value)}
                />
              </label>
            )}
          </div>
          {selected && (
            <>
              <div className="preview-table">
                <table>
                  <thead>
                    <tr>
                      <th>원본 행</th>
                      <th>작업</th>
                      <th>팀원</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.preview.map((r: any) => (
                      <tr key={r.row}>
                        <td>
                          {r.row}
                          {r.hidden ? " (숨김)" : ""}
                        </td>
                        <td>{r.title}</td>
                        <td>{r.owner || "미지정"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>담당자 연결</h3>
              {selected.unresolved.length ? (
                <div className="mapping-grid">
                  {selected.unresolved.map((name: string) => (
                    <label key={name}>
                      {name}
                      <Select
                        value={personMap[name] || ""}
                        onChange={(e) =>
                          setPersonMap({ ...personMap, [name]: e.target.value })
                        }
                      >
                        <option value="">연결할 팀원 선택</option>
                        {preview.users.map((u: User) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                            {!u.active ? " (비활성)" : ""}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="field-help">
                  담당자가 없는 업무는 미지정 상태로 가져옵니다.
                </p>
              )}
              <details className="import-warnings">
                <summary>변환 확인 사항 {selected.warningCount}건</summary>
                <ul>
                  {selected.warnings.map((w: string, i: number) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
              <Button
                onClick={async () => {
                  try {
                    await download(`/import/${preview.id}/exceptions`, {});
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                전체 변환 확인 사항 다운로드
              </Button>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                변환 내용과 담당자 연결을 확인했습니다.
              </label>
              <p className="field-help">
                같은 파일·시트·반영 방식은 반복 실행해도 중복 추가되지 않습니다.
                서로 다른 주간 탭을 운영 업무로 가져오면 별개 업무로 보존됩니다.
              </p>
              <footer className="form-actions">
                <Button onClick={onClose}>닫기</Button>
                <Button
                  className="primary"
                  disabled={
                    busy ||
                    !accepted ||
                    !selected.count ||
                    selected.unresolved.some((n: string) => !personMap[n])
                  }
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await send(`/import/${preview.id}/apply`, {
                        sheet,
                        year,
                        personMap,
                        mode,
                        referenceDate,
                        acceptWarnings: true,
                      });
                      await onDone();
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Upload size={16} />
                  {selected.count}개 반영
                </Button>
              </footer>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
export function ReportsPanel({
  teamId,
  year,
  view,
  tasks,
  user,
  canSave,
  onClose,
  onOpen,
  onDelete,
}: {
  teamId: string;
  year: number;
  view: View;
  tasks: Task[];
  user: User;
  canSave: boolean;
  onClose: () => void;
  onOpen: (r: Report) => void;
  onDelete: (ids: string[]) => Promise<void>;
}) {
  const [reports, setReports] = useState<
      (Pick<Report, "id" | "name" | "year" | "referenceDate" | "createdAt"> & {
        author: string;
      })[]
    >([]),
    [name, setName] = useState(`${todayKey()} 보고서`),
    [date, setDate] = useState(todayKey()),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [savePhase, setSavePhase] = useState<"saving" | null>(null),
    [savedId, setSavedId] = useState<string | null>(null);
  const [message, setMessage] = useToast();
  const canManage = canManageTeam(user, teamId);
  const active = useRef(true);
  const saving = useRef(false);
  const listRequest = useRef(0);
  function close() {
    active.current = false;
    onClose();
  }
  const refresh = async () => {
    const request = ++listRequest.current;
    try {
      const result = await api(`/reports?teamId=${teamId}`);
      if (!active.current || request !== listRequest.current) return;
      setReports(result.reports);
      setSelected((ids) =>
        ids.filter((id) => result.reports.some((r: Report) => r.id === id)),
      );
    } catch (e) {
      if (active.current && request === listRequest.current)
        setError((e as Error).message);
    }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      listRequest.current++;
    };
  }, [teamId]);
  async function saveReport() {
    if (busy || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setSavedId(null);
    setMessage("");
    setSavePhase("saving");
    try {
      const saved = await send<{ id: string }>("/reports", {
        teamId,
        year,
        name,
        referenceDate: date,
        view,
        taskIds: tasks.map((t) => t.id),
      });
      if (!active.current) return;
      // 처음 목록을 읽던 요청이 저장 후 목록을 덮어쓰지 않도록 무효화한다.
      listRequest.current++;
      setSavePhase(null);
      setMessage("스냅샷을 저장했습니다.");
      let nextReports: typeof reports | undefined;
      let refreshError = "";
      try {
        const result = await api<{ reports: typeof reports }>(
          `/reports?teamId=${teamId}`,
        );
        nextReports = result.reports;
      } catch {
        refreshError =
          "스냅샷은 저장되었지만 목록을 불러오지 못했습니다. 목록을 다시 열어 확인해 주세요.";
      }
      if (!active.current) return;
      if (nextReports) {
        setReports(nextReports);
        setSelected((ids) =>
          ids.filter((id) => nextReports.some((r) => r.id === id)),
        );
        setSavedId(saved.id);
      }
      setError(refreshError);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      saving.current = false;
      if (active.current) {
        setSavePhase(null);
        setBusy(false);
      }
    }
  }
  async function removeSelected() {
    if (!selected.length || busy) return;
    if (
      !confirm(
        `선택한 스냅샷 ${selected.length}개를 삭제할까요? 원본 업무는 유지됩니다.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await onDelete(selected);
      setReports((rows) => rows.filter((r) => !selected.includes(r.id)));
      setSelected([]);
      setMessage(`스냅샷 ${selected.length}개를 삭제했습니다.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="보고서 스냅샷"
      help="저장 시점의 업무 내용과 서식을 보존합니다. 이후 원본을 수정해도 스냅샷은 바뀌지 않습니다."
      onClose={close}
    >
      {canManage && canSave && (
        <form
          className="report-save-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveReport();
          }}
        >
          <div className="report-save-fields">
            <label className="report-name-field">
              보고서 이름
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                disabled={busy}
              />
            </label>
            <label className="report-date-field">
              보고 기준일
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                disabled={busy}
              />
            </label>
          </div>
          <div className="report-save-actions">
            <small>현재 보기의 업무 {tasks.length}개</small>
            <Button className="primary" type="submit" disabled={busy}>
              <Plus size={16} />
              현재 보기 저장
            </Button>
          </div>
        </form>
      )}
      <ErrorNote error={error} />
      {canManage && (reports.length > 0 || savePhase) && (
        <div className="report-list-actions">
          <label>
            <input
              type="checkbox"
              checked={reports.length > 0 && selected.length === reports.length}
              ref={(input) => {
                if (input)
                  input.indeterminate =
                    selected.length > 0 && selected.length < reports.length;
              }}
              onChange={(e) =>
                setSelected(e.target.checked ? reports.map((r) => r.id) : [])
              }
              disabled={busy}
            />
            전체 선택
          </label>
          <Button disabled={busy || !selected.length} onClick={removeSelected}>
            <Trash2 size={14} />
            선택 삭제{selected.length > 0 && ` (${selected.length})`}
          </Button>
        </div>
      )}
      <Toast
        message={savePhase ? "스냅샷 저장 중…" : message}
        pending={!!savePhase}
      />
      <div className="report-list">
        {reports.length
          ? reports.map((r) => (
              <div
                className={`report-item${r.id === savedId ? " report-item-saved" : ""}`}
                key={r.id}
              >
                {canManage && (
                  <input
                    type="checkbox"
                    aria-label={`${r.name} 선택`}
                    checked={selected.includes(r.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, r.id]
                          : ids.filter((id) => id !== r.id),
                      )
                    }
                    disabled={busy}
                  />
                )}
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const snapshot = await api(`/reports/${r.id}`);
                      if (!active.current) return;
                      onOpen(snapshot);
                      close();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <span>
                    <strong>{r.name}</strong>
                    <small>
                      {r.referenceDate} · {r.author} ·{" "}
                      {formatDateTime(r.createdAt)}
                    </small>
                  </span>
                  <ExternalLink size={16} />
                </button>
              </div>
            ))
          : !savePhase && <Empty title="저장된 스냅샷이 없습니다" />}
      </div>
    </Modal>
  );
}

export function HistoryPanel({
  teamId,
  year,
  startMonth,
  tasks,
  settings,
  users,
  user,
  onClose,
  onRefresh,
}: {
  teamId: string;
  year: number;
  startMonth: number;
  tasks: Task[];
  settings: Settings;
  users: User[];
  user: User;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [taskFilter, setTaskFilter] = useState("");
  const [entries, setEntries] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const titleById = useMemo(
    () => new Map(tasks.map((t) => [t.id, String(value(t, "title") || "")])),
    [tasks],
  );
  const fieldLabels = useMemo(
    () => new Map(fieldsFor(settings).map((f) => [f.key, f.label])),
    [settings],
  );
  const refresh = () =>
    api(`/audit?teamId=${teamId}${taskFilter ? `&taskId=${taskFilter}` : ""}`)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [teamId, taskFilter]);
  return (
    <Modal
      title="변경 이력"
      help="팀 변경 이력을 최신순으로 최대 100개까지 표시합니다. 셀·공통 서식 변경 전 내용으로 복원할 수 있습니다."
      className="history-modal"
      onClose={onClose}
    >
      <label className="form-field">
        업무별 이력
        <Select
          aria-label="업무별 이력"
          value={taskFilter}
          onChange={(e) => setTaskFilter(e.target.value)}
        >
          <option value="">모든 업무</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {String(value(t, "title")) || "제목 없음"}
            </option>
          ))}
        </Select>
      </label>
      <ErrorNote error={error} />
      <HistoryTimeline>
        {entries.map((e) => (
          <details key={e.id}>
            <summary>
              <span className="audit-icon" aria-hidden="true">
                <ChevronRight size={16} />
              </span>
              <strong>{AUDIT_LABELS[e.action] || e.action}</strong>
              <span>{e.actor}</span>
              <HistoryTime iso={e.createdAt} />
            </summary>
            {e.action === "cells" || e.action === "format" ? (
              <>
                {e.action === "format" && (
                  <div className="audit-changes">
                    <p>{e.after.taskIds.length}개 업무의 공통 서식 변경</p>
                    {e.after.formatting.rules
                      .filter(
                        (r: any) =>
                          JSON.stringify(r) !==
                          JSON.stringify(
                            e.before.formatting.rules.find(
                              (b: any) => b.id === r.id,
                            ),
                          ),
                      )
                      .map((r: any) => (
                        <div key={r.id}>
                          <strong>
                            {r.rows ? `${r.rows.length}개 행` : "모든 행"} ·{" "}
                            {r.keys ? `${r.keys.length}개 열` : "전체 열"}
                          </strong>
                          <small>{describeStyle(r.style)}</small>
                        </div>
                      ))}
                  </div>
                )}
                {(e.action === "format" ? e.after.cells : e.after).length >
                  0 && (
                  <div className="audit-changes">
                    {(e.action === "format" ? e.after.cells : e.after).map(
                      (c: any, i: number) => (
                        <div key={i}>
                          <strong>
                            {titleById.get(c.taskId) || c.taskId.slice(0, 8)}
                          </strong>
                          <span>{fieldLabels.get(c.key) || c.key}</span>
                          <span>
                            {displayValue(
                              {
                                cells: {
                                  [c.key]: (e.action === "format"
                                    ? e.before.cells
                                    : e.before)[i] || { value: "" },
                                },
                              },
                              c.key,
                              users,
                              settings,
                            ) || "빈 값"}{" "}
                            →{" "}
                            {displayValue(
                              { cells: { [c.key]: c } },
                              c.key,
                              users,
                              settings,
                            ) || "빈 값"}
                          </span>
                          <small>
                            서식: {JSON.stringify(compactStyle(c.style))}
                          </small>
                        </div>
                      ),
                    )}
                  </div>
                )}
                {canManageTeam(user, teamId) && (
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !confirm(
                          "선택한 변경 전 내용으로 복원할까요? 현재 내용을 다시 확인한 후 적용됩니다.",
                        )
                      )
                        return;
                      setBusy(true);
                      setError("");
                      try {
                        const current = await api(
                          taskQuery(teamId, year, startMonth),
                        );
                        const versions: Record<string, number> = {};
                        for (const c of e.action === "format"
                          ? e.before.cells
                          : e.before) {
                          const task = current.tasks.find(
                            (t: Task) => t.id === c.taskId,
                          );
                          if (!task)
                            throw new Error(
                              "현재 연도에서 복원할 업무를 찾지 못했습니다. 해당 연도를 열어주세요.",
                            );
                          versions[`${c.taskId}:${c.key}`] = cell(
                            task,
                            c.key,
                          ).version;
                        }
                        await send(`/audit/${e.id}/restore`, {
                          versions,
                          formatRevision:
                            current.tasks[0]?.formatting?.revision ?? 0,
                        });
                        await refresh();
                        onRefresh();
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    변경 전으로 복원
                  </Button>
                )}
              </>
            ) : (
              <pre>{JSON.stringify(pack(e.after || e.before), null, 2)}</pre>
            )}
          </details>
        ))}
      </HistoryTimeline>
    </Modal>
  );
}
export function TrashPanel({
  teamId,
  year,
  onClose,
  onRefresh,
}: {
  teamId: string;
  year: number;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]),
    [error, setError] = useState("");
  const refresh = () =>
    api(`/tasks?teamId=${teamId}&year=${year}&deleted=1`)
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [teamId, year]);
  return (
    <Modal title="휴지통" onClose={onClose}>
      <ErrorNote error={error} />
      {tasks.length ? (
        <div className="report-list">
          {tasks.map((t) => (
            <div className="trash-item" key={t.id}>
              <span>
                {String(value(t, "title"))}
                <small>{t.deletedAt && formatDateTime(t.deletedAt)}</small>
              </span>
              <Button
                onClick={async () => {
                  try {
                    await send(`/tasks/${t.id}/restore`, {});
                    refresh();
                    onRefresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                복구
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="삭제한 업무가 없습니다" />
      )}
    </Modal>
  );
}
export function PasswordPanel({
  user,
  onClose,
}: {
  user: User;
  onClose: () => void;
}) {
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const [message, setMessage] = useToast();
  return (
    <Modal
      title="비밀번호 변경"
      className="password-modal"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <p className="password-identity">
        <strong>
          {user.name} · {user.username}
        </strong>
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (saving) return;
          const form = e.currentTarget;
          setError("");
          setMessage("");
          const f = new FormData(form);
          if (f.get("password") !== f.get("confirmPassword")) {
            setError("새 비밀번호와 비밀번호 확인이 일치하지 않습니다.");
            form
              .querySelector<HTMLInputElement>('[name="confirmPassword"]')
              ?.focus();
            return;
          }
          setSaving(true);
          try {
            await send("/auth/password", {
              currentPassword: f.get("currentPassword"),
              password: f.get("password"),
            });
            form.reset();
            setMessage("비밀번호를 변경했습니다.");
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          현재 비밀번호
          <input
            type="password"
            name="currentPassword"
            required
            autoComplete="current-password"
          />
        </label>
        <label>
          새 비밀번호
          <input
            type="password"
            name="password"
            minLength={10}
            maxLength={128}
            required
            autoComplete="new-password"
          />
        </label>
        <label>
          비밀번호 확인
          <input
            type="password"
            name="confirmPassword"
            minLength={10}
            maxLength={128}
            required
            autoComplete="new-password"
          />
        </label>
        <ErrorNote error={error} />
        <Toast message={message} />
        <footer className="form-actions">
          <Button onClick={onClose} disabled={saving}>
            닫기
          </Button>
          <Button type="submit" className="primary" disabled={saving}>
            비밀번호 변경
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
