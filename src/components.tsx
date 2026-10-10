import Select from "./Select";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  X,
  LoaderCircle,
  Check,
  ArrowRight,
  LockKeyhole,
} from "lucide-react";
import { api, send } from "./api";
import { BrandLockup, Grae } from "./Brand";
import type {
  Bootstrap,
  Cell,
  Point,
  Task,
  Team,
  User,
  View,
  Settings,
} from "./types";
import {
  FIELDS,
  fieldsFor,
  cell,
  value,
  displayValue,
  weeksForYear,
} from "../shared/domain.js";

export function Button({
  children,
  onClick,
  title,
  disabled = false,
  active = false,
  className = "",
  type = "button",
  ...attributes
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  type?: "button" | "submit";
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      {...attributes}
      type={type}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`button ${active ? "active" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const el = ref.current;
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <Button title="닫기" onClick={onClose}>
          <X size={18} />
        </Button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Grae className="empty-grae" />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function ErrorNote({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="error-note">
      {error}
    </div>
  ) : null;
}
export function SessionLogin({
  username,
  onSuccess,
}: {
  username: string;
  onSuccess: () => Promise<void>;
}) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await send("/auth/login", { username, password });
          setPassword("");
          await onSuccess();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="field-help">
        로그인이 만료되었습니다. {username} 계정으로 다시 로그인하면 보존한
        입력을 재시도합니다.
      </p>
      <label>
        계정 비밀번호
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          maxLength={128}
        />
      </label>
      <ErrorNote error={error} />
      <Button type="submit" className="primary" disabled={busy}>
        로그인 후 재시도
      </Button>
    </form>
  );
}
export function Avatar({
  user,
  small = false,
}: {
  user?: Partial<User>;
  small?: boolean;
}) {
  const backgroundColor = user?.color || "#65818f";
  const initials = user?.avatarInitials || user?.name?.slice(0, 1) || "?";
  const rgb = [1, 3, 5].map((start) =>
    parseInt(backgroundColor.slice(start, start + 2), 16),
  );
  const color =
    rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 170
      ? "#243642"
      : "#ffffff";
  return (
    <span
      className={`avatar ${small ? "small" : ""} ${initials.length === 3 ? "long-initials" : ""}`}
      style={{ backgroundColor, color }}
    >
      {user?.avatarImage ? <img src={user.avatarImage} alt="" /> : initials}
    </span>
  );
}
export function Auth({ onLogin }: { onLogin: (data: Bootstrap) => void }) {
  const [setup, setSetup] = useState<{
      required: boolean;
      tokenRequired: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/setup")
      .then(setSetup)
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      await send(
        setup?.required ? "/auth/setup" : "/auth/login",
        Object.fromEntries(
          [...form.entries()].map(([k, v]) => [
            k,
            k === "sample" ? v === "on" : v,
          ]),
        ),
      );
      onLogin(await api("/bootstrap"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <BrandLockup className="auth-lockup" />
        <div>
          <span className="story-line" />
          <h1>
            한 주의 일,
            <br />한 해의 흐름.
          </h1>
          <p>
            팀의 업무와 일정을 한곳에 모으세요.
            <br />
            필요한 사람과 기간만 남겨 가볍게 살펴봅니다.
          </p>
          <div className="auth-stage" aria-hidden="true">
            <div className="mini-schedule">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <i />
              <i />
              <i />
            </div>
            <Grae variant="3d" className="auth-grae" />
            <span className="auth-bubble">그래, 같이 그려보자!</span>
          </div>
        </div>
        <p className="auth-foot">
          <LockKeyhole size={15} />
          우리 팀의 기록을 우리 공간에
        </p>
      </section>
      <section className="auth-form">
        <div className="auth-card">
          <BrandLockup className="auth-mobile-brand" />
          <h2>
            {setup?.required ? "우리 팀의 공간 만들기" : "다시 만나 반가워요"}
          </h2>
          <p>
            {setup?.required
              ? "관리자 계정을 만들고 업무 기록을 시작하세요."
              : "계정으로 로그인해 이번 주 업무를 확인하세요."}
          </p>
          {!setup && !error ? (
            <LoaderCircle className="spin" />
          ) : (
            <form onSubmit={submit}>
              {setup?.required && (
                <>
                  <label>
                    이름
                    <input
                      name="name"
                      autoComplete="name"
                      required
                      maxLength={50}
                    />
                  </label>
                  <label>
                    팀 이름
                    <input
                      name="teamName"
                      defaultValue="UX기획팀"
                      required
                      maxLength={80}
                    />
                  </label>
                </>
              )}
              <label>
                아이디
                <input
                  name="username"
                  autoComplete="username"
                  required
                  maxLength={60}
                  placeholder="아이디를 입력하세요"
                />
              </label>
              <label>
                비밀번호
                <input
                  type="password"
                  name="password"
                  autoComplete={
                    setup?.required ? "new-password" : "current-password"
                  }
                  minLength={setup?.required ? 10 : 1}
                  maxLength={128}
                  placeholder={
                    setup?.required
                      ? "10자 이상 입력하세요"
                      : "비밀번호를 입력하세요"
                  }
                  required
                />
              </label>
              {setup?.required && (
                <>
                  <label className="checkbox">
                    <input type="checkbox" name="sample" defaultChecked />
                    예시 업무로 기능 살펴보기
                  </label>
                  {setup.tokenRequired && (
                    <label>
                      초기 설정 키
                      <input name="token" type="password" required />
                    </label>
                  )}
                  <p className="field-help">
                    예시 담당자는 로그인할 수 없는 비활성 계정으로 생성됩니다.
                  </p>
                </>
              )}
              <ErrorNote error={error} />
              <button className="button primary auth-submit" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={18} className="spin" />
                ) : setup?.required ? (
                  "공간 만들기"
                ) : (
                  "로그인"
                )}
                <ArrowRight size={18} />
              </button>
              {!setup?.required && (
                <p className="field-help">
                  비밀번호를 잊었다면 시스템 관리자에게 재설정을 요청하세요.
                </p>
              )}
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
export function ViewOptions({
  settings,
  view,
  onChange,
  onClose,
  tasks,
}: {
  settings: Settings;
  view: View;
  onChange: (v: Partial<View>) => void;
  onClose: () => void;
  tasks: Task[];
}) {
  const fields = fieldsFor(settings);
  const freezableFields = fields.filter(
    (f) => view.visibleFields.includes(f.key) && f.placement !== "afterWeeks",
  );
  return (
    <Modal title="보기 설정" onClose={onClose}>
      <h3>업무 정보 열</h3>
      <div className="check-grid">
        {fields.map((f) => (
          <label className="checkbox" key={f.key}>
            <input
              type="checkbox"
              checked={view.visibleFields.includes(f.key)}
              disabled={f.key === "title"}
              onChange={(e) =>
                onChange({
                  visibleFields: e.target.checked
                    ? fields
                        .map((f) => f.key)
                        .filter(
                          (k) => k === f.key || view.visibleFields.includes(k),
                        )
                    : view.visibleFields.filter((k) => k !== f.key),
                })
              }
            />
            {f.label}
          </label>
        ))}
      </div>
      <h3>주차 범위</h3>
      <div className="form-grid">
        <label>
          시작 주
          <Select
            aria-label="시작 주"
            value={view.fromWeek || ""}
            onChange={(e) =>
              onChange({
                fromWeek: e.target.value,
                toWeek:
                  view.toWeek && view.toWeek < e.target.value
                    ? e.target.value
                    : view.toWeek || "",
                fromMonth: 1,
                toMonth: 12,
              })
            }
          >
            <option value="">연초부터</option>
            {weeksForYear(view.year).map((w) => (
              <option key={w.key} value={w.key}>
                {w.index}주 · {w.key} ~ {w.end}
              </option>
            ))}
          </Select>
        </label>
        <label>
          마지막 주
          <Select
            aria-label="마지막 주"
            value={view.toWeek || ""}
            onChange={(e) =>
              onChange({
                toWeek: e.target.value,
                fromWeek:
                  view.fromWeek &&
                  e.target.value &&
                  view.fromWeek > e.target.value
                    ? e.target.value
                    : view.fromWeek || "",
                fromMonth: 1,
                toMonth: 12,
              })
            }
          >
            <option value="">연말까지</option>
            {weeksForYear(view.year).map((w) => (
              <option key={w.key} value={w.key}>
                {w.index}주 · {w.key} ~ {w.end}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <h3>월 접기</h3>
      <div className="month-choices">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <Button
            key={m}
            active={view.collapsedMonths.includes(m)}
            onClick={() =>
              onChange({
                collapsedMonths: view.collapsedMonths.includes(m)
                  ? view.collapsedMonths.filter((x) => x !== m)
                  : [...view.collapsedMonths, m],
              })
            }
          >
            {m}월
          </Button>
        ))}
      </div>
      <p className="field-help">
        선택한 월은 접힙니다. 나의 보기만 변경됩니다.
      </p>
      <details className="week-visibility">
        <summary>주차 숨기기 · {view.hiddenWeeks.length}개 숨김</summary>
        <div className="check-grid">
          {weeksForYear(view.year).map((w) => (
            <label className="checkbox" key={w.key}>
              <input
                type="checkbox"
                aria-label={`${w.label} 주차 숨기기`}
                checked={view.hiddenWeeks.includes(w.key)}
                onChange={(e) =>
                  onChange({
                    hiddenWeeks: e.target.checked
                      ? [...view.hiddenWeeks, w.key]
                      : view.hiddenWeeks.filter((k) => k !== w.key),
                  })
                }
              />
              {w.label}
            </label>
          ))}
        </div>
      </details>
      <h3>숨긴 업무 {view.hiddenRows.length}개</h3>
      <div className="hidden-list">
        {view.hiddenRows.length ? (
          view.hiddenRows.map((id) => (
            <div key={id}>
              <span>
                {String(
                  value(
                    tasks.find((t) => t.id === id) || { cells: {} },
                    "title",
                  ) || "다른 조건의 업무",
                )}
              </span>
              <Button
                onClick={() =>
                  onChange({
                    hiddenRows: view.hiddenRows.filter((x) => x !== id),
                  })
                }
              >
                다시 표시
              </Button>
            </div>
          ))
        ) : (
          <p>숨긴 업무가 없습니다.</p>
        )}
      </div>
      <h3>왼쪽 열 고정</h3>
      <Select
        aria-label="고정할 업무 정보 열 수"
        value={Math.min(view.frozenColumns ?? 0, freezableFields.length)}
        onChange={(e) => onChange({ frozenColumns: Number(e.target.value) })}
      >
        {Array.from({ length: freezableFields.length + 1 }, (_, i) => (
          <option key={i} value={i}>
            {i === 0 ? "고정 안 함" : `앞에서 ${i}개 열`}
          </option>
        ))}
      </Select>
      <p className="field-help">
        주차 날짜 앞에 있는 업무 정보 열만 고정할 수 있습니다.
      </p>
      <h3>셀 높이</h3>
      <Select
        aria-label="셀 높이"
        value={view.density}
        onChange={(e) =>
          onChange({ density: e.target.value as View["density"] })
        }
      >
        <option value="comfortable">넉넉하게</option>
        <option value="compact">편안하게</option>
        <option value="dense">촘촘하게</option>
      </Select>
      <footer className="form-actions">
        <Button
          onClick={() =>
            onChange({ hiddenRows: [], hiddenWeeks: [], collapsedMonths: [] })
          }
        >
          모든 숨김 해제
        </Button>
        <Button className="primary" onClick={onClose}>
          완료
        </Button>
      </footer>
    </Modal>
  );
}
