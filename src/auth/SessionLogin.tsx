import { useState } from "react";
import { useSite } from "../platform/site-context";
import { api, send } from "../platform/api";
import { resumeSession } from "../platform/event-stream";
import type { Bootstrap } from "../types";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";

export function SessionLogin({
  username,
  onSuccess,
}: {
  username: string;
  onSuccess: () => Promise<void>;
}) {
  const site = useSite();
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (site.external)
    return (
      <div>
        <p className="field-help">
          {site.accountLinking
            ? `입력을 이 화면에 보존했습니다. 새 창에서 Google 로그인 후 사내 계정 ${username}을 선택하고 다시 시도하세요.`
            : `입력을 이 화면에 보존했습니다. 새 창에서 ${username} 계정으로 Google 로그인을 확인한 뒤 다시 시도하세요.`}
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
