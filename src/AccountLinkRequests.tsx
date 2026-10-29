import { useEffect, useRef, useState } from "react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";

type LinkRequest = {
  id: string;
  email: string;
  userId: string;
  name: string;
  username: string;
  status: "pending" | "approved";
  createdAt: string;
};
export default function AccountLinkRequests({
  teamId,
  onMessage,
}: {
  teamId: string;
  onMessage: (message: string) => void;
}) {
  const [requests, setRequests] = useState<LinkRequest[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const path = `/teams/${teamId}/access-requests`;
  async function load(signal?: AbortSignal) {
    const data = await api<{ requests: LinkRequest[] }>(path, { signal });
    if (live.current && !signal?.aborted) setRequests(data.requests);
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        await load(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => {
      live.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [teamId]);
  async function decide(id: string, action: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      await send(`${path}/${id}/${action}`, {});
      if (!live.current) return;
      await load();
      if (live.current)
        onMessage(
          action === "approve"
            ? "Google 계정 연결을 승인했습니다."
            : "Google 계정 연결을 해제했습니다.",
        );
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Google 계정 연결">
      <h4>Google 계정 연결</h4>
      <ErrorNote error={error} />
      <div className="settings-table-scroll">
        <table className="settings-table">
          <thead>
            <tr>
              <th>사내 계정</th>
              <th>Google 계정</th>
              <th>상태</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id}>
                <td>
                  <div className="identity-cell">
                    <span>
                      <strong>{request.name}</strong>
                      <small>{request.username}</small>
                    </span>
                  </div>
                </td>
                <td>{request.email}</td>
                <td>{request.status === "pending" ? "승인 대기" : "연결됨"}</td>
                <td>
                  <div className="heading-actions">
                    {request.status === "pending" && (
                      <Button
                        disabled={busy}
                        onClick={() => void decide(request.id, "approve")}
                      >
                        승인
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() => void decide(request.id, "reject")}
                    >
                      {request.status === "pending" ? "거절" : "연결 해제"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!requests.length && (
              <tr>
                <td colSpan={4} className="table-empty">
                  계정 연결 신청이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
