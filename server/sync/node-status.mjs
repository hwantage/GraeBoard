import { createReceiptCapacityGuard } from "./receipt-capacity.mjs";
export function createSyncStatusReader({ db, sync }) {
  const capacity = createReceiptCapacityGuard(db);
  return (teamId) => {
    const store = sync.store(teamId),
      link = store.readLink();
    if (!link) return { mode: "unlinked", pending: 0, conflicts: 0 };
    return {
      mode: link.mode,
      siteId: link.installation_id,
      siteName: "내부 서버",
      profileId: link.profile_id,
      canReconnect:
        link.mode === "disconnected" &&
        link.installation_id === sync.installationId,
      canonicalHead: link.canonical_head,
      canonicalHash: link.canonical_hash,
      protocol: db
        .prepare(
          "SELECT 1 FROM sync_entities WHERE team_id=? AND entity='protocol' AND deleted=0",
        )
        .get(teamId)
        ? 2
        : 1,
      pending: db
        .prepare(
          "SELECT COUNT(*) n FROM sync_outbox INDEXED BY sync_outbox_pending_idx WHERE team_id=? AND status<>'acknowledged'",
        )
        .get(teamId).n,
      conflicts: db
        .prepare(
          "SELECT COUNT(*) n FROM sync_conflicts WHERE team_id=? AND resolution IS NULL",
        )
        .get(teamId).n,
      lastLocalSavedAt:
        db
          .prepare(
            "SELECT created_at FROM sync_outbox WHERE team_id=? ORDER BY local_seq DESC LIMIT 1",
          )
          .get(teamId)?.created_at ?? null,
      lastReceivedAt: link.last_received_at,
      lastPublishedAt: link.last_published_at,
      remoteStatus: link.remote_status
        ? (() => {
            const remote = JSON.parse(link.remote_status);
            return {
              ...remote,
              verified:
                !!remote.verified &&
                remote.verifiedAgainstHead === link.canonical_head &&
                Date.now() - Date.parse(remote.observedAt) >= 0 &&
                Date.now() - Date.parse(remote.observedAt) < 180000,
            };
          })()
        : null,
      lastError: link.last_error,
      receiptCapacity: capacity.status(link),
    };
  };
}
