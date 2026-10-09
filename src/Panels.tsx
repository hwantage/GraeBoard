import Select from "./Select";
import { useEffect, useState } from "react";
import {
  Download,
  Upload,
  Plus,
  History,
  Trash2,
  Check,
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
import { api, send, download } from "./api";
import { Modal, Button, ErrorNote, Empty, Avatar } from "./components";
import PropertyBadge from "./PropertyBadge";
import MemberValue from "./MemberValue";
import type { Task, User, Team, View, Report, Point, Settings } from "./types";
import {
  FIELDS,
  fieldsFor,
  propertiesFor,
  displayValue,
  canEdit,
  cell,
  value,
  todayKey,
} from "../shared/domain.js";

export function RowPanel({
  settings,
  task,
  user,
  users,
  onClose,
  onEdit,
  onAction,
}: {
  task: Task;
  settings: Settings;
  user: User;
  users: User[];
  onClose: () => void;
  onEdit: (p: Point) => void;
  onAction: (action: string) => void;
}) {
  const editable = canEdit(user, task);
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
          {user.role !== "viewer" && (
            <Button onClick={() => onAction("copy")}>
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
  taskIds,
  keys,
  onClose,
}: {
  teamId: string;
  year: number;
  taskIds: string[];
  keys: string[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState("xlsx"),
    [scope, setScope] = useState("view"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="업무 내보내기" onClose={onClose}>
      <p>필요한 범위와 파일 형식을 선택하세요.</p>
      <label>
        내보낼 범위
        <Select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="view">
            현재 보기 · {taskIds.length}개 업무 (숨김 제외)
          </option>
          <option value="all">이 연도 전체 · 필터와 숨김 포함</option>
        </Select>
      </label>
      <label>
        파일 형식
        <Select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="xlsx">Excel (.xlsx) · 값과 기본 서식</option>
          <option value="csv">CSV (.csv) · 값만</option>
          <option value="json">JSON (.json) · ID·서식·보고본 보관</option>
        </Select>
      </label>
      <p className="field-help">
        JSON 전체 반출은 보고본(관리자), 본인의 보기 설정과 담당자 정보를
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
  onDone: () => void;
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
    <Modal title="기존 업무 가져오기" wide onClose={onClose}>
      <p>
        Google Sheets에서 다운로드한 XLSX 파일을 선택하세요. 미리보기를 확인한
        뒤 반영합니다.
      </p>
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
                <option value="report">과거 주간 보고본으로 보관</option>
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
                  담당자가 없는 업무는 가져오는 사람에게 연결됩니다.
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
                      onDone();
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
  onClose,
  onOpen,
}: {
  teamId: string;
  year: number;
  view: View;
  tasks: Task[];
  user: User;
  onClose: () => void;
  onOpen: (r: Report) => void;
}) {
  const [reports, setReports] = useState<any[]>([]),
    [name, setName] = useState(`${todayKey()} 주간 보고`),
    [date, setDate] = useState(todayKey()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    api(`/reports?teamId=${teamId}`)
      .then((r) => setReports(r.reports))
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [teamId]);
  return (
    <Modal title="주간 보고본" onClose={onClose}>
      <p>
        저장 시점의 업무 내용과 서식을 보존합니다. 이후 원본을 수정해도 보고본은
        바뀌지 않습니다.
      </p>
      {["admin", "manager"].includes(user.role) && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await send("/reports", {
                teamId,
                year,
                name,
                referenceDate: date,
                view,
                taskIds: tasks.map((t) => t.id),
              });
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            보고본 이름
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label>
            보고 기준일
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
          <Button className="primary" type="submit" disabled={busy}>
            <Plus size={16} />
            현재 보기 {tasks.length}개 업무 저장
          </Button>
        </form>
      )}
      <ErrorNote error={error} />
      <div className="report-list">
        {reports.length ? (
          reports.map((r) => (
            <button
              key={r.id}
              onClick={async () => {
                try {
                  onOpen(await api(`/reports/${r.id}`));
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <span>
                <strong>{r.name}</strong>
                <small>
                  {r.referenceDate} · 버전 {r.id.slice(0, 8)} · {r.author} ·{" "}
                  {new Date(r.createdAt).toLocaleString("ko-KR")}
                </small>
              </span>
              <ExternalLink size={16} />
            </button>
          ))
        ) : (
          <Empty title="저장된 보고본이 없습니다" />
        )}
      </div>
    </Modal>
  );
}
export function HistoryPanel({
  teamId,
  year,
  tasks,
  settings,
  users,
  user,
  onClose,
  onRefresh,
}: {
  teamId: string;
  year: number;
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
  const labels: Record<string, string> = {
    cells: "셀 편집",
    reorder: "업무 순서 변경",
    "property-rename": "속성 값 이름 변경",
    "team-update": "팀 정보 변경",
    "team-create": "팀 생성",
    create: "업무 추가",
    delete: "업무 삭제",
    restore: "업무 복구",
    report: "보고본 저장",
    settings: "설정 변경",
    export: "내보내기",
    import: "자료 가져오기",
    task: "업무 이동·이월",
    setup: "팀 생성",
  };
  const refresh = () =>
    api(`/audit?teamId=${teamId}${taskFilter ? `&taskId=${taskFilter}` : ""}`)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [teamId, taskFilter]);
  return (
    <Modal title="변경 이력" wide onClose={onClose}>
      <p>
        최근 100개의 기록입니다. 셀 수정 이력에서 변경 전 내용으로 복원할 수
        있습니다.
      </p>
      <label>
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
      <div className="audit-list">
        {entries.map((e) => (
          <details key={e.id}>
            <summary>
              <span className="audit-icon">
                <History size={15} />
              </span>
              <strong>{labels[e.action] || e.action}</strong>
              <span>{e.actor}</span>
              <time>{new Date(e.createdAt).toLocaleString("ko-KR")}</time>
            </summary>
            {e.action === "cells" ? (
              <>
                <div className="audit-changes">
                  {e.after.map((c: any, i: number) => (
                    <div key={i}>
                      <strong>
                        {String(
                          value(
                            tasks.find((t) => t.id === c.taskId) || {
                              cells: {},
                            },
                            "title",
                          ) || c.taskId.slice(0, 8),
                        )}
                      </strong>
                      <span>
                        {fieldsFor(settings).find((f) => f.key === c.key)
                          ?.label || c.key}
                      </span>
                      <span>
                        {displayValue(
                          { cells: { [c.key]: e.before[i] || { value: "" } } },
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
                      <small>서식: {JSON.stringify(c.style)}</small>
                    </div>
                  ))}
                </div>
                {["admin", "manager"].includes(user.role) && (
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
                          `/tasks?teamId=${teamId}&year=${year}`,
                        );
                        const versions: Record<string, number> = {};
                        for (const c of e.before) {
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
                        await send(`/audit/${e.id}/restore`, { versions });
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
              <pre>{JSON.stringify(e.after || e.before, null, 2)}</pre>
            )}
          </details>
        ))}
      </div>
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
  }, []);
  return (
    <Modal title="휴지통" onClose={onClose}>
      <ErrorNote error={error} />
      {tasks.length ? (
        <div className="report-list">
          {tasks.map((t) => (
            <div className="trash-item" key={t.id}>
              <span>
                {String(value(t, "title"))}
                <small>
                  {t.deletedAt && new Date(t.deletedAt).toLocaleString("ko-KR")}
                </small>
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
export function AccountPanel({
  user,
  onClose,
  onLogout,
  logoutDisabled = false,
}: {
  user: User;
  onClose: () => void;
  onLogout: () => void;
  logoutDisabled?: boolean;
}) {
  const [error, setError] = useState(""),
    [done, setDone] = useState(false);
  return (
    <Modal title="내 계정" onClose={onClose}>
      <p>
        {user.name} · {user.username}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            await send("/auth/password", Object.fromEntries(f));
            setDone(true);
          } catch (err) {
            setError((err as Error).message);
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
        <ErrorNote error={error} />
        {done && <p className="success-note">비밀번호를 변경했습니다.</p>}
        {logoutDisabled && (
          <p className="muted">
            저장 중이거나 실패한 입력을 처리한 뒤 로그아웃할 수 있습니다.
          </p>
        )}
        <footer className="form-actions">
          <Button onClick={onLogout} disabled={logoutDisabled}>
            로그아웃
          </Button>
          <Button type="submit" className="primary">
            비밀번호 변경
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
