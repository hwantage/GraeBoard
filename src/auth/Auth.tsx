import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";
import { api, send } from "../platform/api";
import { resumeSession } from "../platform/event-stream";
import { siteFor } from "../platform/site";
import { BrandLockup, Grae } from "../ui/Brand";
import { Button } from "../ui/Button";
import { Empty } from "../ui/Empty";
import { ErrorNote } from "../ui/ErrorNote";
import type { Bootstrap } from "../types";
import type { SetupStatus } from "../../shared/identity/session-contract";
import ExternalLogin from "./ExternalLogin";

export function Auth({ onLogin }: { onLogin: (data: Bootstrap) => void }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<SetupStatus>("/setup", { signal: controller.signal })
      .then(setSetup)
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, []);
  const site = siteFor(setup);
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
  if (!setup && error)
    return (
      <Empty
        title="서버에 연결할 수 없습니다"
        description={error}
        action={<Button onClick={() => location.reload()}>다시 연결</Button>}
      />
    );
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
            {site.accountLinking
              ? setup?.required
                ? "팀장 계정 연결"
                : "사내 계정 연결"
              : setup?.required
                ? site.external
                  ? "외부 공간 관리자 등록"
                  : "우리 팀의 공간 만들기"
                : "다시 만나 반가워요"}
          </h2>
          <p>
            {site.accountLinking
              ? setup?.required
                ? "Google 계정을 사내 팀장 계정에 연결하세요."
                : "사내 계정을 선택하고 팀장에게 연결 승인을 요청하세요."
              : setup?.required
                ? "관리자 계정을 만들고 업무 기록을 시작하세요."
                : site.external
                  ? "Google로 확인한 계정으로 업무 공간에 접속합니다."
                  : "계정으로 로그인해 이번 주 업무를 확인하세요."}
          </p>
          {!setup && !error ? (
            <LoaderCircle className="spin" />
          ) : setup && site.external ? (
            <ExternalLogin setup={setup} onLogin={onLogin} />
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
                아이디(이메일)
                <input
                  // 이메일 이전에 만든 기존 아이디로도 로그인할 수 있어야 하므로
                  // 로그인에서는 이메일 형식을 강제하지 않는다.
                  type={setup?.required ? "email" : "text"}
                  inputMode="email"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={254}
                  placeholder="name@company.com"
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
                      <input
                        name="token"
                        type="password"
                        autoComplete="off"
                        required
                      />
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
