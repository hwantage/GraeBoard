import { useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { SetupStatus } from "../shared/session-contract";
import { api, send } from "./api";
import { ErrorNote } from "./components";
import { resumeSession } from "./event-stream";
import ExternalAccountLogin from "./ExternalAccountLogin";
import type { Bootstrap } from "./types";

export default function ExternalLogin({
  setup,
  onLogin,
}: {
  setup: SetupStatus;
  onLogin: (data: Bootstrap) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (setup.accountLinking)
    return <ExternalAccountLogin initial={setup} onLogin={onLogin} />;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          await send(
            setup.required ? "/auth/setup" : "/auth/login",
            Object.fromEntries(form.entries()),
          );
          resumeSession();
          onLogin(await api<Bootstrap>("/bootstrap"));
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {setup.required && (
        <label>
          이름
          <input name="name" autoComplete="name" required maxLength={50} />
        </label>
      )}
      <label>
        아이디(이메일)
        <input
          type={setup.required ? "email" : "text"}
          inputMode="email"
          name="email"
          value={setup.email || ""}
          readOnly
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={254}
          placeholder="name@company.com"
        />
      </label>
      {setup.required && setup.tokenRequired && (
        <label>
          초기 설정 키
          <input
            name="setupToken"
            type="password"
            autoComplete="off"
            required
          />
        </label>
      )}
      <ErrorNote error={error} />
      <button className="button primary auth-submit" disabled={busy}>
        {busy ? (
          <LoaderCircle size={18} className="spin" />
        ) : setup.required ? (
          "관리자 등록"
        ) : (
          "로그인"
        )}
        <ArrowRight size={18} />
      </button>
    </form>
  );
}
