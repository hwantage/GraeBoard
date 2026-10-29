import { syncTime } from "./sync-types";
import { useEffect, useState } from "react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import { busyProps } from "./busyProps";

type KeyStatus = {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  publishedAt: string | null;
  appliedAt: string | null;
  usedAt: string | null;
};
export default function TeamSetupKey({
  teamId,
  enabled,
  onMessage,
}: {
  teamId: string;
  enabled: boolean;
  onMessage: (value: string) => void;
}) {
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/teams/${teamId}/setup-key`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api<{ key: KeyStatus | null }>(path, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setKey(result.key);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 5000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path]);
  async function change(revoke = false) {
    setBusy(true);
    setError("");
    onMessage("");
    try {
      const result = await send<{ key: KeyStatus; token?: string }>(
        path,
        {},
        revoke ? "DELETE" : "POST",
      );
      setKey(result.key);
      setToken(result.token || "");
      onMessage(
        revoke
          ? "연결 키 폐기를 요청했습니다."
          : "팀장 연결 키를 발급했습니다.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const expired = !!key && Date.parse(key.expiresAt) <= Date.now();
  return (
    <section className="settings-section" aria-label="팀장 연결 키">
      <h4>팀장 연결 키</h4>
      <p className="field-help">
        외부에서 Google 로그인 후 자신의 사내 팀장 계정을 선택하고 입력하세요.
        키는 24시간 동안 한 번만 사용할 수 있습니다.
      </p>
      <ErrorNote error={error} />
      {key && (
        <dl className="role-legend" aria-live="polite">
          <div>
            <dt>상태</dt>
            <dd>
              {key.revokedAt
                ? "폐기됨"
                : key.usedAt
                  ? "사용 완료"
                  : expired
                    ? "만료됨"
                    : "사용 대기"}
            </dd>
          </div>
          <div>
            <dt>외부 반영</dt>
            <dd>
              {key.appliedAt
                ? `반영 확인: ${syncTime(key.appliedAt)}`
                : key.publishedAt
                  ? "GitHub 전달 완료 · 외부 반영 확인 대기"
                  : "GitHub 전달 대기"}
            </dd>
          </div>
          <div>
            <dt>만료</dt>
            <dd>{syncTime(key.expiresAt)}</dd>
          </div>
        </dl>
      )}
      {token && key && !key.revokedAt && !key.usedAt && !expired && (
        <>
          <label>
            발급된 연결 키
            <input
              readOnly
              value={token}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p className="field-help">
            이 화면을 닫으면 키를 다시 확인할 수 없습니다. 재발급·폐기는 다음
            외부 반영부터 적용됩니다.
          </p>
        </>
      )}
      <div className="form-actions">
        <Button {...busyProps(busy, !enabled)} onClick={() => void change()}>
          {key ? "연결 키 재발급" : "팀장 연결 키 발급"}
        </Button>
        {token && !key?.revokedAt && !key?.usedAt && !expired && (
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(token);
                onMessage("연결 키를 복사했습니다.");
              } catch {
                setError("키를 선택한 뒤 복사하세요.");
              }
            }}
          >
            키 복사
          </Button>
        )}
        {key && !key.revokedAt && !key.usedAt && !expired && (
          <Button {...busyProps(busy)} onClick={() => void change(true)}>
            키 폐기
          </Button>
        )}
      </div>
      {!enabled && (
        <p className="field-help">팀 연결과 초기 게시를 먼저 완료하세요.</p>
      )}
    </section>
  );
}
