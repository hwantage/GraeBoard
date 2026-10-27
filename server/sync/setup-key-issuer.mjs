import { transaction } from "../db.mjs";
import { requireThat } from "../validation.mjs";
import {
  newSetupKey,
  publishSetupJson,
  readSetupJson,
  validateSetupKeys,
} from "./setup-keys.mjs";

export function setupKeyStatus(db, teamId, userId) {
  const row = db
    .prepare(
      "SELECT id,issued_at,expires_at,revoked_at,published_at,applied_at,used_at FROM external_setup_keys WHERE team_id=? AND user_id=?",
    )
    .get(teamId, userId);
  return row
    ? {
        id: row.id,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        publishedAt: row.published_at,
        appliedAt: row.applied_at,
        usedAt: row.used_at,
      }
    : null;
}
export function installSetupKeyRoutes(app, { db, sync, teamAccess }) {
  const authorize = (req) => {
    teamAccess(req.user, req.params.id);
    const member = db
      .prepare(
        "SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.user_id=? AND u.active=1",
      )
      .get(req.params.id, req.user.id);
    requireThat(
      member?.role === "lead",
      403,
      "자신의 팀장 계정에서 연결 키를 발급하세요.",
    );
  };
  app.get("/api/teams/:id/setup-key", (req, res) => {
    authorize(req);
    res
      .set("Cache-Control", "no-store")
      .json({ key: setupKeyStatus(db, req.params.id, req.user.id) });
  });
  app.post("/api/teams/:id/setup-key", (req, res) => {
    authorize(req);
    const link = sync.store(req.params.id).readLink();
    requireThat(
      link?.canonical_head && ["active", "paused"].includes(link.mode),
      409,
      "팀 연결과 초기 게시를 먼저 완료하세요.",
    );
    const { token, record: key } = newSetupKey(req.params.id, req.user.id);
    transaction(db, () =>
      db
        .prepare(
          `INSERT INTO external_setup_keys(id,team_id,user_id,token_hash,issued_at,expires_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET id=excluded.id,token_hash=excluded.token_hash,
      issued_at=excluded.issued_at,expires_at=excluded.expires_at,revoked_at=NULL,published_head=NULL,published_at=NULL,applied_at=NULL,used_at=NULL`,
        )
        .run(
          key.id,
          key.teamId,
          key.userId,
          key.tokenHash,
          key.issuedAt,
          key.expiresAt,
        ),
    );
    sync.schedule(req.params.id, 0);
    res
      .set("Cache-Control", "no-store")
      .json({ token, key: setupKeyStatus(db, req.params.id, req.user.id) });
  });
  app.delete("/api/teams/:id/setup-key", (req, res) => {
    authorize(req);
    db.prepare(
      "UPDATE external_setup_keys SET revoked_at=COALESCE(revoked_at,?),published_head=NULL,published_at=NULL,applied_at=NULL WHERE team_id=? AND user_id=?",
    ).run(new Date().toISOString(), req.params.id, req.user.id);
    sync.schedule(req.params.id, 0);
    res
      .set("Cache-Control", "no-store")
      .json({ key: setupKeyStatus(db, req.params.id, req.user.id) });
  });
}
export async function syncSetupKeys(db, teamId, transport, peerInstallationId) {
  const link = db
    .prepare("SELECT * FROM team_sync_links WHERE team_id=?")
    .get(teamId);
  if (!link?.canonical_head || !["active", "paused"].includes(link.mode))
    return;
  const keys = db
    .prepare(
      `SELECT k.id,k.user_id AS userId,k.token_hash AS tokenHash,k.issued_at AS issuedAt,k.expires_at AS expiresAt,k.revoked_at AS revokedAt
    FROM external_setup_keys k JOIN users u ON u.id=k.user_id JOIN memberships m ON m.user_id=u.id AND m.team_id=k.team_id
    WHERE k.team_id=? AND u.active=1 AND m.role='lead' ORDER BY k.id`,
    )
    .all(teamId)
    .map((row) => ({ ...row }));
  const snapshot = validateSetupKeys({
    format: "graeboard-setup-keys",
    version: 1,
    teamId,
    installationId: link.installation_id,
    repoId: link.repo_id,
    keys,
  });
  const head = await publishSetupJson(
    transport,
    "sync-setup/" + link.installation_id,
    "keys.json",
    snapshot,
  );
  transaction(db, () => {
    for (const key of keys)
      db.prepare(
        `UPDATE external_setup_keys SET published_head=?,published_at=COALESCE(published_at,?)
      WHERE id=? AND token_hash=? AND revoked_at IS ?`,
      ).run(
        head,
        new Date().toISOString(),
        key.id,
        key.tokenHash,
        key.revokedAt,
      );
  });
  if (!peerInstallationId) return;
  const receiptHead = await transport.readHead(
    "sync-setup-status/" + peerInstallationId,
  );
  if (!receiptHead) return;
  const receipt = readSetupJson(
    await transport.readFile(receiptHead, "status.json"),
  );
  if (
    receipt.format !== "graeboard-setup-status" ||
    receipt.version !== 1 ||
    receipt.teamId !== teamId ||
    receipt.repoId !== link.repo_id ||
    receipt.installationId !== peerInstallationId ||
    receipt.sourceHead !== head ||
    !Array.isArray(receipt.keys) ||
    receipt.keys.length > 1000
  )
    return;
  transaction(db, () => {
    for (const key of receipt.keys) {
      if (
        typeof key.id !== "string" ||
        !Number.isFinite(Date.parse(key.receivedAt)) ||
        (key.usedAt !== null && !Number.isFinite(Date.parse(key.usedAt)))
      )
        continue;
      db.prepare(
        "UPDATE external_setup_keys SET applied_at=?,used_at=COALESCE(used_at,?) WHERE id=? AND team_id=? AND published_head=?",
      ).run(key.receivedAt, key.usedAt, key.id, teamId, head);
    }
  });
}
