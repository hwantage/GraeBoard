import { useEffect, useId, useState } from "react";
import { api, send } from "./api";
import { resumeSession } from "./event-stream";
import { Button, ErrorNote } from "./components";
import Select from "./Select";
import type { Bootstrap } from "./types";

export type AccountStatus = {
  required: boolean;
  tokenRequired: boolean;
  authMode?: "access";
  accountLinking?: boolean;
  email?: string;
  accounts?: {
    id: string;
    name: string;
    username: string;
    role: string;
    status: string;
  }[];
};
export default function ExternalAccountLogin({
  initial,
  onLogin,
}: {
  initial: AccountStatus;
  onLogin: (data: Bootstrap) => void;
}) {
  const [status, setStatus] = useState(initial);
  const accountLabel = useId();
  const [userId, setUserId] = useState(
    initial.accounts?.find((a) => a.status === "approved")?.id || "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = status.accounts?.find((a) => a.id === userId);
  useEffect(() => {
    if (status.required) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api<AccountStatus>("/auth/accounts", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setStatus(next);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
    };
    timer = setTimeout(refresh, 5000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [status.required]);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          if (status.required || selected?.status === "approved") {
            await send(
              status.required ? "/auth/setup" : "/auth/select-account",
              {
                userId,
                ...(status.required
                  ? { setupToken: form.get("setupToken") }
                  : {}),
              },
            );
            resumeSession();
            onLogin(await api<Bootstrap>("/bootstrap"));
          } else {
            await send("/auth/link-request", { userId });
            setStatus(await api<AccountStatus>("/auth/accounts"));
          }
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Google 계정
        <input value={status.email || ""} readOnly />
      </label>
      <label>
        <span id={accountLabel}>
          {status.required ? "연결할 사내 팀장 계정" : "연결할 사내 계정"}
        </span>
        <Select
          aria-labelledby={accountLabel}
          value={userId}
          required
          disabled={busy}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="">계정 선택</option>
          {(status.accounts || []).map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} ({account.username})
            </option>
          ))}
        </Select>
      </label>
      {status.required && (
        <label>
          초기 설정 키
          <input
            type="password"
            name="setupToken"
            autoComplete="off"
            required
          />
        </label>
      )}
      {!status.required && selected?.status === "pending" && (
        <p role="status">팀장의 연결 승인을 기다리고 있습니다.</p>
      )}
      {!status.required && selected?.status === "rejected" && (
        <p role="status">
          연결 신청이 승인되지 않았습니다. 계정을 확인한 뒤 다시 신청하세요.
        </p>
      )}
      <ErrorNote error={error} />
      <Button
        type="submit"
        className="primary auth-submit"
        disabled={
          busy ||
          !selected ||
          (!status.required && selected.status === "pending")
        }
      >
        {busy
          ? "처리 중…"
          : status.required
            ? "팀장 계정 연결"
            : selected?.status === "approved"
              ? "선택한 계정으로 접속"
              : "연결 승인 요청"}
      </Button>
    </form>
  );
}
