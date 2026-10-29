import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, ErrorNote } from "./components";
import LoadingState from "./LoadingState";
import { useSite } from "./site-context";
import "./sync-setup.css";

type Identity = {
  installationId: string;
  profile: { profileId: string; peerInstallationId: string } | null;
};

export default function SyncConnectionDetails({
  teamId,
  profileId,
  systemAdmin,
}: {
  teamId: string;
  profileId?: string;
  systemAdmin: boolean;
}) {
  const { external } = useSite();
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || external || !systemAdmin) return;
    const controller = new AbortController();
    setLoading(true);
    setIdentity(null);
    setError("");
    void api<Identity>(`/admin/teams/${teamId}/sync-setup`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setIdentity(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, teamId, profileId, external, systemAdmin, retry]);
  const matchingProfile =
    !profileId || identity?.profile?.profileId === profileId;
  return (
    <details
      className="sync-connection-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>연결 식별 정보</summary>
      {open && (
        <>
          <dl className="sync-setup-status">
            <div>
              <dt>팀 UUID</dt>
              <dd>{teamId}</dd>
            </div>
            {(profileId || identity?.profile) && (
              <div>
                <dt>프로필 ID</dt>
                <dd>{profileId || identity?.profile?.profileId}</dd>
              </div>
            )}
            {identity?.installationId && (
              <div>
                <dt>내부 설치 UUID</dt>
                <dd>{identity.installationId}</dd>
              </div>
            )}
            {matchingProfile && identity?.profile?.peerInstallationId && (
              <div>
                <dt>외부 설치 UUID</dt>
                <dd>{identity.profile.peerInstallationId}</dd>
              </div>
            )}
          </dl>
          {loading && (
            <LoadingState label="연결 식별 정보를 확인하고 있습니다." />
          )}
          <ErrorNote error={error} />
          {error && (
            <Button onClick={() => setRetry((value) => value + 1)}>
              다시 확인
            </Button>
          )}
        </>
      )}
    </details>
  );
}
