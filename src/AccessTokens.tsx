import { useEffect, useRef, useState } from "react";
import { api, ApiError, send } from "./api";
import { Button, ErrorNote, Modal } from "./components";
import { Eye, EyeOff, Copy } from "lucide-react";
import { syncTime } from "./sync-types";

type Token = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
};
function tokenError(error: unknown) {
  if (
    error instanceof ApiError &&
    error.status === 404 &&
    error.message === "요청한 API를 찾을 수 없습니다."
  )
    return "접속 토큰 API가 서버에 반영되지 않았습니다. 서버 업데이트와 DB 변환 후 다시 시도하세요.";
  return (error as Error).message;
}
export default function AccessTokens({
  onClose,
  onNotify,
}: {
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [visible, setVisible] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const requestId = useRef<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<{ tokens: Token[] }>("/access-tokens", {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setTokens(result.tokens);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(tokenError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);
  async function create() {
    if (busy || loading || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await send<Token & { token: string }>("/access-tokens", {
        id: (requestId.current ||= crypto.randomUUID()),
        name,
      });
      const { token, ...metadata } = result;
      setTokens((previous) => [metadata, ...previous]);
      setVisible((previous) => ({ ...previous, [metadata.id]: token }));
      requestId.current = null;
      setName("");
      onNotify("접속 토큰을 생성했습니다.");
    } catch (error) {
      setError(tokenError(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(token: Token) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await send(`/access-tokens/${token.id}`, {}, "DELETE");
      setTokens((previous) => previous.filter((item) => item.id !== token.id));
      setVisible((previous) => {
        const next = { ...previous };
        delete next[token.id];
        return next;
      });
      onNotify("접속 토큰을 삭제했습니다.");
    } catch (error) {
      setError(tokenError(error));
    } finally {
      setBusy(false);
    }
  }
  async function reveal(token: Token) {
    if (busy) return;
    if (visible[token.id]) {
      setVisible((previous) => {
        const next = { ...previous };
        delete next[token.id];
        return next;
      });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: string }>(
        `/access-tokens/${token.id}/reveal`,
      );
      setVisible((previous) => ({ ...previous, [token.id]: result.token }));
    } catch (error) {
      setError(tokenError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="접속 토큰"
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocus={nameInput}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset className="profile-fields" disabled={busy || loading}>
          <label>
            토큰 이름
            <input
              ref={nameInput}
              value={name}
              maxLength={80}
              required
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                requestId.current = null;
              }}
            />
          </label>
        </fieldset>
        <div className="form-actions">
          <Button
            type="submit"
            className="primary"
            disabled={busy || loading || !name.trim() || tokens.length >= 20}
          >
            토큰 생성
          </Button>
        </div>
      </form>
      <ErrorNote error={error} />
      {error && (
        <Button
          disabled={busy || loading}
          onClick={() => {
            requestId.current = null;
            setReload((value) => value + 1);
          }}
        >
          토큰 목록 다시 불러오기
        </Button>
      )}
      {loading ? (
        <p role="status">토큰을 불러오는 중…</p>
      ) : tokens.length ? (
        <ul className="access-token-list" aria-label="접속 토큰 목록">
          {tokens.map((token) => (
            <li key={token.id}>
              <div>
                <strong>{token.name}</strong>
                {visible[token.id] ? (
                  <input
                    className="access-token-value"
                    aria-label={`${token.name} 토큰`}
                    readOnly
                    value={visible[token.id]}
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                ) : (
                  <code>{token.prefix}…</code>
                )}
                <span>생성 {syncTime(token.createdAt)}</span>
              </div>
              <span className="access-token-actions">
                <Button
                  disabled={busy}
                  tooltip={`${token.name} 토큰 ${visible[token.id] ? "숨기기" : "보기"}`}
                  aria-pressed={!!visible[token.id]}
                  onClick={() => void reveal(token)}
                >
                  {visible[token.id] ? (
                    <EyeOff size={16} aria-hidden="true" />
                  ) : (
                    <Eye size={16} aria-hidden="true" />
                  )}
                </Button>
                {visible[token.id] && (
                  <Button
                    disabled={busy}
                    tooltip={`${token.name} 토큰 복사`}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(visible[token.id]);
                        onNotify("접속 토큰을 복사했습니다.");
                      } catch {
                        setError("토큰을 선택한 뒤 복사하세요.");
                      }
                    }}
                  >
                    <Copy size={16} aria-hidden="true" />
                  </Button>
                )}
                <Button
                  className="danger"
                  disabled={busy}
                  title={`${token.name} 토큰 삭제`}
                  onClick={() => void remove(token)}
                >
                  삭제
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !error && <p className="field-help">생성한 접속 토큰이 없습니다.</p>
      )}
    </Modal>
  );
}
