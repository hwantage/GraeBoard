import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  X,
  LoaderCircle,
  ArrowRight,
  LockKeyhole,
  CircleHelp,
} from "lucide-react";
import { api, send, isExternalSite } from "./api";
import { resumeSession } from "./event-stream";
import { BrandLockup, Grae } from "./Brand";
import { inkFor } from "./color";
import type { Bootstrap, User } from "./types";

export function Button({
  children,
  onClick,
  title,
  tooltip,
  disabled = false,
  active = false,
  className = "",
  type = "button",
  ...attributes
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  tooltip?: string;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  type?: "button" | "submit";
  ref?: RefObject<HTMLButtonElement | null>;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
}) {
  return (
    <button
      {...attributes}
      type={type}
      title={tooltip ? undefined : title}
      data-tooltip={tooltip}
      aria-label={tooltip || title}
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
  help,
  titleAction,
  titleContent,
  headerActions,
  children,
  onClose,
  onOutsideClick,
  wide = false,
  className = "",
  initialFocus,
}: {
  title: string;
  help?: string;
  titleAction?: ReactNode;
  titleContent?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onOutsideClick?: () => void;
  wide?: boolean;
  className?: string;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const titleId = useId();
  const hasHelp = !!help;
  const hasHeaderActions = !!headerActions || !!titleAction || !!titleContent;
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    ref.current?.showModal();
    (
      initialFocus?.current ||
      (hasHelp || hasHeaderActions ? closeButton.current : null)
    )?.focus({
      preventScroll: true,
    });
    const el = ref.current;
    return () => {
      el?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus, hasHelp, hasHeaderActions]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && backdropPress.current)
          (onOutsideClick || onClose)();
        backdropPress.current = false;
      }}
      onPointerDownCapture={(e) => {
        backdropPress.current = e.target === ref.current && e.button === 0;
      }}
      onPointerUpCapture={(e) => {
        backdropPress.current =
          backdropPress.current && e.target === ref.current;
      }}
      onPointerCancel={() => {
        backdropPress.current = false;
      }}
    >
      <header>
        <div className="modal-heading">
          <h2 id={titleId} hidden={!!titleContent}>
            {title}
          </h2>
          {titleContent}
          {titleAction}
          {help && (
            <button
              type="button"
              className="modal-help"
              aria-label={`${title} 도움말`}
              data-tooltip={help}
            >
              <CircleHelp size={17} aria-hidden="true" />
            </button>
          )}
        </div>
        {headerActions}
        <Button ref={closeButton} title="닫기" onClick={onClose}>
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
  if (isExternalSite())
    return (
      <div>
        <p className="field-help">
          입력을 이 화면에 보존했습니다. 새 창에서 {username} 계정으로 Google
          로그인을 확인한 뒤 다시 시도하세요.
        </p>
        <div className="form-actions">
          <Button
            onClick={() => {
              window.open(
                location.origin,
                "graeboard-access-login",
                "noopener",
              );
            }}
          >
            Google 로그인 확인
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const boot = await api<Bootstrap>("/bootstrap");
                if (boot.user.username !== username)
                  throw new Error("입력을 작성한 계정으로 로그인하세요.");
                resumeSession();
                await onSuccess();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            로그인 후 재시도
          </Button>
        </div>
        <ErrorNote error={error} />
      </div>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await send("/auth/login", { username, password });
          resumeSession();
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
  const color = inkFor(backgroundColor);
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
      authMode?: "access";
      email?: string;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/setup")
      .then((status) =>
        setSetup({
          ...status,
          required: status.required ?? status.needsSetup,
          tokenRequired: status.tokenRequired ?? status.authMode === "access",
        }),
      )
      .catch((e) => setError(e.message));
  }, []);
  const access = setup?.authMode === "access";
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
      resumeSession();
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
            {setup?.required
              ? access
                ? "외부 공간 관리자 등록"
                : "우리 팀의 공간 만들기"
              : "다시 만나 반가워요"}
          </h2>
          <p>
            {setup?.required
              ? "관리자 계정을 만들고 업무 기록을 시작하세요."
              : access
                ? "Google로 확인한 계정으로 업무 공간에 접속합니다."
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
                  {!access && (
                    <label>
                      팀 이름
                      <input
                        name="teamName"
                        defaultValue="UX기획팀"
                        required
                        maxLength={80}
                      />
                    </label>
                  )}
                </>
              )}
              <label>
                아이디(이메일)
                <input
                  // 이메일 이전에 만든 기존 아이디로도 로그인할 수 있어야 하므로
                  // 로그인에서는 이메일 형식을 강제하지 않는다.
                  type={setup?.required ? "email" : "text"}
                  inputMode="email"
                  name={access ? "email" : "username"}
                  value={access ? setup?.email || "" : undefined}
                  readOnly={access}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  placeholder="name@company.com"
                />
              </label>
              {!access && (
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
              )}
              {setup?.required && (
                <>
                  {!access && (
                    <label className="checkbox">
                      <input type="checkbox" name="sample" defaultChecked />
                      예시 업무로 기능 살펴보기
                    </label>
                  )}
                  {setup.tokenRequired && (
                    <label>
                      초기 설정 키
                      <input
                        name={access ? "setupToken" : "token"}
                        type="password"
                        autoComplete="off"
                        required
                      />
                    </label>
                  )}
                  {!access && (
                    <p className="field-help">
                      예시 담당자는 로그인할 수 없는 비활성 계정으로 생성됩니다.
                    </p>
                  )}
                </>
              )}
              <ErrorNote error={error} />
              <button className="button primary auth-submit" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={18} className="spin" />
                ) : setup?.required ? (
                  access ? (
                    "관리자 등록"
                  ) : (
                    "공간 만들기"
                  )
                ) : (
                  "로그인"
                )}
                <ArrowRight size={18} />
              </button>
              {!setup?.required && !access && (
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
