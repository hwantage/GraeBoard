import type { DocumentPanelHandle } from "./TaskDocumentPanel";
import type { DocumentSaveResult, SavedCell } from "./types";
import TaskPropertyEditor, {
  type PropertyEditorHandle,
  type PropertySaveRequest,
} from "./TaskPropertyEditor";
import Select from "./Select";
import DocumentLoading from "./DocumentLoading";
import LoadingState from "./LoadingState";
import {
  Component,
  forwardRef,
  useImperativeHandle,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Download,
  Upload,
  ChevronRight,
  Trash2,
  LoaderCircle,
  FileSpreadsheet,
  Copy,
  EyeOff,
  CalendarPlus,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { api, send, download, taskQuery } from "./api";
import { Modal, Button, ErrorNote } from "./components";
import Toast, { useToast } from "./Toast";
import HistoryTime, { HistoryTimeline } from "./HistoryTime";
import { describeStyle } from "./history";
import { pack, compactStyle } from "../shared/compact.js";
import type { Task, User, Settings } from "./types";
import {
  fieldsFor,
  displayValue,
  canEdit,
  canContribute,
  canManageTeam,
  cell,
  value,
  todayKey,
} from "../shared/domain.js";

const TaskDocumentPanel = lazy(() => import("./TaskDocumentPanel"));
class DocumentLoadBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? (
      <p className="error-note" role="alert">
        문서 편집기를 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 열어
        주세요.
      </p>
    ) : (
      this.props.children
    );
  }
}

const AUDIT_LABELS: Record<string, string> = {
  format: "공통 서식 변경",
  cells: "셀 편집",
  document: "업무 문서 편집",
  reorder: "업무 순서 변경",
  "property-convert": "속성 종류 변경",
  "team-update": "팀 정보 변경",
  "history-cleanup": "변경 이력 정리",
  "team-create": "팀 생성",
  "team-members": "구성원 변경",
  create: "업무 추가",
  delete: "업무 삭제",
  restore: "업무 복구",
  report: "사본 저장",
  "report-edit": "사본 수정",
  "report-rename": "사본 이름 변경",
  "report-restore": "업무 복구",
  "report-document": "업무 문서 편집",
  "report-delete": "사본 삭제",
  settings: "설정 변경",
  export: "내보내기",
  import: "자료 가져오기",
  task: "업무 이동·이월",
  setup: "초기 설정",
};

export type TaskDetailHandle = {
  flush: (keepDocumentDraft?: boolean) => Promise<boolean>;
  selectDocument: (id: string) => Promise<boolean>;
};
export const TaskDetailContent = forwardRef<
  TaskDetailHandle,
  {
    task: Task;
    settings: Settings;
    user: User;
    users: User[];
    readOnly?: boolean;
    reportMode?: boolean;
    documentReport?: { id: string; isNew: boolean };
    initialDocumentId?: string;
    onDocumentSelected?: (id: string) => void;
    onDocumentSaved: (result: DocumentSaveResult) => void;
    onSaveProperty: (request: PropertySaveRequest) => Promise<SavedCell[]>;
    onCloseWithDraft: () => void;
    copySaveError?: string;
    onRetryCopySave?: () => void;
  }
>(function TaskDetailContent(
  {
    task,
    settings,
    user,
    users,
    readOnly,
    reportMode,
    documentReport,
    initialDocumentId,
    onDocumentSelected,
    onDocumentSaved,
    onSaveProperty,
    onCloseWithDraft,
    copySaveError,
    onRetryCopySave,
  },
  ref,
) {
  const editable =
    !readOnly &&
    (reportMode ? canContribute(user, task.teamId) : canEdit(user, task));
  const documentRef = useRef<DocumentPanelHandle>(null);
  const propertyRef = useRef<PropertyEditorHandle>(null);
  const [documentLoading, setDocumentLoading] = useState(true);
  useImperativeHandle(ref, () => ({
    flush: async (keepDocumentDraft = false) => {
      if (propertyRef.current && !(await propertyRef.current.flush()))
        return false;
      return (
        keepDocumentDraft ||
        !documentRef.current ||
        (await documentRef.current.flush())
      );
    },
    selectDocument: async (id) => {
      if (propertyRef.current && !(await propertyRef.current.flush()))
        return false;
      return (await documentRef.current?.selectDocument(id)) ?? false;
    },
  }));
  return (
    <>
      <TaskPropertyEditor
        ref={propertyRef}
        task={task}
        settings={settings}
        users={users}
        readOnly={!editable}
        onSave={onSaveProperty}
      />
      {copySaveError && (
        <div className="task-property-error" role="alert">
          <span>{copySaveError}</span>
          <Button onClick={onRetryCopySave}>사본 저장 재시도</Button>
        </div>
      )}
      <div
        className="task-document-shell"
        data-loading={documentLoading || undefined}
      >
        {documentLoading && <DocumentLoading />}
        <div
          className="task-document-surface"
          aria-hidden={documentLoading || undefined}
          inert={documentLoading}
        >
          <DocumentLoadBoundary onError={() => setDocumentLoading(false)}>
            <Suspense fallback={null}>
              <TaskDocumentPanel
                ref={documentRef}
                task={task}
                userId={user.id}
                readOnly={!editable}
                report={documentReport}
                onSaved={onDocumentSaved}
                onCloseWithDraft={onCloseWithDraft}
                initialDocumentId={initialDocumentId}
                onDocumentSelected={onDocumentSelected}
                onLoadingChange={setDocumentLoading}
              />
            </Suspense>
          </DocumentLoadBoundary>
        </div>
      </div>
    </>
  );
});

export function RowPanel({
  settings,
  task,
  user,
  users,
  readOnly = false,
  reportMode = false,
  documentReport,
  onDocumentSaved,
  copySaveError,
  onRetryCopySave,
  onClose,
  onSaveProperty,
  onAction,
}: {
  task: Task;
  settings: Settings;
  user: User;
  users: User[];
  // 열람자·발표 화면에서는 편집 동작을 숨긴다.
  readOnly?: boolean;
  reportMode?: boolean;
  documentReport?: { id: string; isNew: boolean };
  onDocumentSaved: (result: DocumentSaveResult) => void;
  copySaveError?: string;
  onRetryCopySave?: () => void;
  onClose: () => void;
  onSaveProperty: (request: PropertySaveRequest) => Promise<SavedCell[]>;
  onAction: (action: string) => void;
}) {
  const editable =
    !readOnly &&
    (reportMode ? canContribute(user, task.teamId) : canEdit(user, task));
  const detailRef = useRef<TaskDetailHandle>(null);
  const [documentFullPage, setDocumentFullPage] = useState(false);
  const leaving = useRef(false);
  async function leave(
    action: () => void | Promise<void>,
    keepDocumentDraft = false,
  ) {
    if (leaving.current) return;
    leaving.current = true;
    try {
      if (
        detailRef.current &&
        !(await detailRef.current.flush(keepDocumentDraft))
      )
        return;
      await action();
    } finally {
      leaving.current = false;
    }
  }
  function act(action: string) {
    void leave(() => onAction(action));
  }
  return (
    <Modal
      title="업무 상세"
      titleAction={
        <Button
          tooltip={
            documentFullPage ? "전체 페이지 닫기" : "문서 전체 페이지로 보기"
          }
          className="document-expand"
          aria-pressed={documentFullPage}
          onClick={() => setDocumentFullPage((value) => !value)}
        >
          {documentFullPage ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
        </Button>
      }
      onClose={() => void leave(onClose)}
      className={`task-detail-modal${documentFullPage ? " document-full-page" : ""}`}
      headerActions={
        <div
          className="task-detail-actions"
          role="group"
          aria-label="업무 동작"
        >
          <Button tooltip="이 업무 숨기기" onClick={() => act("hide")}>
            <EyeOff size={16} aria-hidden="true" />
            <span className="task-detail-action-label">이 업무 숨기기</span>
          </Button>
          {!readOnly && canContribute(user, task.teamId) && (
            <Button tooltip="복제" onClick={() => act("duplicate")}>
              <Copy size={16} aria-hidden="true" />
              <span className="task-detail-action-label">복제</span>
            </Button>
          )}
          {editable && !reportMode && (
            <Button tooltip="다음 연도에도 표시" onClick={() => act("carry")}>
              <CalendarPlus size={16} aria-hidden="true" />
              <span className="task-detail-action-label">
                다음 연도에도 표시
              </span>
            </Button>
          )}
          {editable && (
            <Button
              className="danger"
              tooltip="업무 삭제"
              onClick={() => act("delete")}
            >
              <Trash2 size={16} aria-hidden="true" />
              <span className="task-detail-action-label">업무 삭제</span>
            </Button>
          )}
        </div>
      }
    >
      <TaskDetailContent
        ref={detailRef}
        task={task}
        settings={settings}
        user={user}
        users={users}
        readOnly={readOnly}
        reportMode={reportMode}
        documentReport={documentReport}
        onDocumentSaved={onDocumentSaved}
        onSaveProperty={onSaveProperty}
        copySaveError={copySaveError}
        onRetryCopySave={onRetryCopySave}
        onCloseWithDraft={() => void leave(onClose, true)}
      />
    </Modal>
  );
}

export function ExportPanel({
  teamId,
  report,
  year,
  startMonth,
  taskIds,
  keys,
  onClose,
}: {
  teamId: string;
  report?: { id: string; name: string; revision: string } | null;
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
            {report ? "현재 사본 전체" : `기준 연도 ${year}년 전체`} · 필터와
            숨김 포함
          </option>
        </Select>
      </label>
      <label>
        파일 형식
        <Select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="xlsx">Excel (.xlsx) · 값과 기본 서식</option>
          <option value="csv">CSV (.csv) · 값만</option>
          <option value="json">JSON (.json) · ID·서식·사본 보관</option>
        </Select>
      </label>
      <p className="field-help">
        {report
          ? `‘${report.name}’ 시트의 업무와 서식, 문서를 내보냅니다. 문서 본문은 JSON에 포함됩니다.`
          : "JSON 전체 반출은 사본(관리자), 본인의 보기 설정과 담당자 정보를 포함합니다. 계정 비밀번호와 로그인 정보는 포함하지 않습니다."}
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
                reportId: report?.id,
                revision: report?.revision,
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
  report,
  year,
  onClose,
  onDone,
}: {
  teamId: string;
  report?: { id: string; name: string; revision: string } | null;
  year: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<any>(null),
    [sheet, setSheet] = useState(""),
    [personMap, setPersonMap] = useState<Record<string, string>>({}),
    [mode, setMode] = useState(report ? "copy" : "tasks"),
    [phase, setPhase] = useState<"preview" | "apply" | null>(null),
    [error, setError] = useState(""),
    [accepted, setAccepted] = useState(false),
    [referenceDate, setReferenceDate] = useState(todayKey());
  const selected = preview?.sheets.find((s: any) => s.name === sheet);
  const busy = phase !== null;
  async function choose(file?: File) {
    if (!file) return;
    setPhase("preview");
    setError("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("teamId", teamId);
      body.set("year", String(year));
      if (report) body.set("reportId", report.id);
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
      setPhase(null);
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
        <span className="upload-presentation">
          {busy ? (
            <LoadingState
              label={
                phase === "preview"
                  ? "파일을 분석하고 미리보기를 준비하고 있습니다"
                  : "업무를 반영하고 있습니다"
              }
            />
          ) : (
            <>
              <FileSpreadsheet size={30} />
              <strong>XLSX 파일 선택</strong>
            </>
          )}
        </span>
        <span>최대 25MB · 숨겨진 행과 주차도 포함합니다</span>
        <input
          type="file"
          aria-label="XLSX 파일 선택"
          accept=".xlsx"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
      <ErrorNote error={error} />
      {report && (
        <p className="field-help">
          가져올 위치: <strong>{report.name}</strong> · 현재 사본에 업무를
          추가합니다.
        </p>
      )}
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
            {!report && (
              <label>
                반영 방식
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="tasks">운영 업무로 추가</option>
                  <option value="report">과거 사본으로 보관</option>
                </Select>
              </label>
            )}
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
                {report
                  ? "같은 파일의 같은 시트는 이 사본에 한 번만 추가됩니다."
                  : "같은 파일·시트·반영 방식은 반복 실행해도 중복 추가되지 않습니다. 서로 다른 주간 탭을 운영 업무로 가져오면 별개 업무로 보존됩니다."}
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
                    setPhase("apply");
                    setError("");
                    try {
                      await send(`/import/${preview.id}/apply`, {
                        sheet,
                        year,
                        personMap,
                        mode,
                        reportId: report?.id,
                        revision: report?.revision,
                        referenceDate,
                        acceptWarnings: true,
                      });
                      await onDone();
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setPhase(null);
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

export function HistoryPanel({
  teamId,
  report,
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
  report?: { id: string; name: string } | null;
  year: number;
  startMonth: number;
  tasks: Task[];
  settings: Settings;
  users: User[];
  user: User;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
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
    api(
      `/audit?teamId=${teamId}&sheetId=${report?.id || "original"}${taskFilter ? `&taskId=${taskFilter}` : ""}`,
    )
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, [teamId, report?.id, taskFilter]);
  return (
    <Modal
      title="변경 이력"
      help={`${report?.name || "원본"} 시트의 변경 이력을 최신순으로 최대 100개까지 표시합니다. 삭제한 업무를 이 시트로 복구할 수 있습니다.`}
      className="history-modal"
      onClose={onClose}
    >
      <p className="field-help">
        현재 시트: <strong>{report?.name || "원본"}</strong>
      </p>
      {!report && (
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
      )}
      <ErrorNote error={error} />
      <HistoryTimeline>
        {entries.map((e) => (
          <details key={e.id}>
            <summary>
              <span className="audit-icon" aria-hidden="true">
                <ChevronRight size={16} />
              </span>
              <strong>
                {e.before?.deletedTasks?.length
                  ? `업무 삭제 · ${e.before.deletedTasks.length}개`
                  : AUDIT_LABELS[e.action] || e.action}
              </strong>
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
            ) : e.action === "delete" || e.before?.deletedTasks?.length ? (
              <div className="audit-changes">
                {(e.action === "delete"
                  ? [e.before]
                  : e.before.deletedTasks
                ).map((task: Task) => (
                  <p key={task.id}>
                    {String(value(task, "title")) || "제목 없는 업무"}
                  </p>
                ))}
                {e.restorableTaskIds?.length > 0 &&
                  (report
                    ? canContribute(user, teamId)
                    : canManageTeam(user, teamId)) && (
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          const current = report
                            ? await api(`/reports/${report.id}`)
                            : null;
                          await send(
                            `/audit/${e.id}/restore`,
                            current ? { revision: current.revision } : {},
                          );
                          await refresh();
                          await onRefresh();
                        } catch (err) {
                          setError((err as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      삭제한 업무 복구
                    </Button>
                  )}
                {!e.restorableTaskIds?.length && (
                  <p className="field-help">
                    이미 복구되었거나 이후 삭제 이력이 있습니다.
                  </p>
                )}
              </div>
            ) : (
              <pre>{JSON.stringify(pack(e.after || e.before), null, 2)}</pre>
            )}
          </details>
        ))}
      </HistoryTimeline>
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
