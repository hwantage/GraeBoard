import { installSetupKeyRoutes } from "./setup-key-issuer.mjs";
import { SQLITE_VERSION } from "../migrations/sqlite.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { profileToken, sealToken } from "./credentials.mjs";
import { createSyncSetupConfig } from "./setup-config.mjs";
import { GitCliTransport } from "./git-cli.mjs";
import { transaction } from "../db.mjs";
import { requireThat } from "../../shared/validation.js";

import { createSyncStatusReader } from "./node-status.mjs";
const id = (req) => req.params.id;
export function installSyncRoutes(app, options) {
  installSetupKeyRoutes(app, options);
  installConnectionRoutes(app, options);
  installTeamSyncRoutes(app, options);
}
function installConnectionRoutes(
  app,
  { db, sync, managedTeam, requireSystemAdmin },
) {
  const setup = createSyncSetupConfig({ db, sync, path: sync.setupConfigPath });
  app.get("/api/admin/teams/:id/sync-setup", (req, res) => {
    requireSystemAdmin(req.user);
    managedTeam(req.user, id(req));
    res.set("Cache-Control", "no-store").json(setup.status(id(req)));
  });
  app.put("/api/admin/teams/:id/sync-setup", (req, res) => {
    requireSystemAdmin(req.user);
    managedTeam(req.user, id(req));
    res.set("Cache-Control", "no-store").json(setup.save(id(req), req.body));
  });
  app.put("/api/admin/teams/:id/sync-credential", (req, res) => {
    requireSystemAdmin(req.user);
    managedTeam(req.user, id(req));
    const profile = sync.profiles.find(
      (p) => p.teamId === id(req) && p.profileId === req.body.profileId,
    );
    requireThat(profile, 400, "재시작 후 설치된 해당 팀 프로필을 선택하세요.");
    requireThat(
      !sync.isBusy(id(req)),
      409,
      "동기화 작업이 진행 중입니다. 작업이 끝난 뒤 토큰 저장을 다시 시도하세요.",
    );
    requireThat(
      typeof req.body.token === "string" &&
        /^[A-Za-z0-9_]{1,10000}$/.test(req.body.token),
      400,
      "GitHub 토큰 형식을 확인하세요.",
    );
    requireThat(
      Buffer.from(process.env.GRAEBOARD_SYNC_KEY || "", "base64").length === 32,
      409,
      "동기화 암호화 키 등록 후 서버를 재시작하세요.",
    );
    const encrypted = sealToken(req.body.token, profile.profileId);
    db.prepare(
      "INSERT INTO sync_credentials VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at",
    ).run(profile.profileId, encrypted, new Date().toISOString());
    sync.clear(id(req));
    res.set("Cache-Control", "no-store").json({ ok: true });
  });
  app.get("/api/admin/service-connections", (req, res) => {
    requireSystemAdmin(req.user);
    res.json({
      site: "internal",
      access: { issuer: "", audience: "", configured: false },
      database: { provider: "SQLite", version: SQLITE_VERSION, status: "ok" },
      siteName: "내부 서버",
      runtime: "internal",
      appOrigin: process.env.APP_ORIGIN || "",
      installationId: sync.installationId || "",
      guideUrl: "/api/admin/service-connections/guide",
      profiles: sync.profiles.map(sync.safeProfile),
      checks: [
        { name: "SQLite", status: "ok", message: `v${SQLITE_VERSION}` },
        {
          name: "설치 식별자",
          status: sync.installationId ? "ok" : "pending",
          message: sync.installationId
            ? "등록됨"
            : "GRAEBOARD_INSTALLATION_ID를 등록하세요.",
        },
      ],
    });
  });
  app.post("/api/admin/service-connections/check", (req, res) => {
    requireSystemAdmin(req.user);
    res.json({
      ready: !!sync.installationId,
      checks: [
        { name: "SQLite", status: "ok", message: `v${SQLITE_VERSION}` },
        {
          name: "설치 식별자",
          status: sync.installationId ? "ok" : "pending",
          message: sync.installationId ? "등록됨" : "설정 필요",
        },
      ],
    });
  });
  app.get("/api/admin/service-connections/guide", (req, res) => {
    requireSystemAdmin(req.user);
    res
      .type("text/plain")
      .send(
        readFileSync(
          new URL("../../docs/CLOUD_SETUP.md", import.meta.url),
          "utf8",
        ),
      );
  });
  app.get("/api/admin/teams/:id/connection", (req, res) => {
    managedTeam(req.user, id(req));
    const l = sync.store(id(req)).readLink();
    res.json({
      profileId: l?.profile_id || "",
      revision: l?.generation || 0,
      profiles: sync.profiles
        .filter((p) => p.teamId === id(req))
        .map(sync.safeProfile),
    });
  });
  app.put("/api/admin/teams/:id/connection", async (req, res) => {
    managedTeam(req.user, id(req));
    const teamId = id(req),
      profile = sync.profiles.find(
        (p) => p.profileId === req.body.profileId && p.teamId === teamId,
      );
    requireThat(profile, 400, "설치된 해당 팀 프로필을 선택하세요.");
    requireThat(
      sync.installationId,
      400,
      "GRAEBOARD_INSTALLATION_ID를 등록하세요.",
    );
    const store = sync.store(teamId),
      old = store.readLink();
    requireThat(
      (old?.generation || 0) === req.body.expectedRevision,
      409,
      "연결 상태가 변경되었습니다.",
    );
    if (old && old.profile_id !== profile.profileId) {
      requireThat(
        profile.replaces === old.profile_id &&
          old.mode === "paused" &&
          !old.lease_owner,
        409,
        "기존 연결을 일시정지하고 replaces 프로필을 준비하세요.",
      );
      requireThat(
        !db
          .prepare(
            "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
          )
          .get(teamId),
        409,
        "정리·백업 작업을 먼저 완료하세요.",
      );
      const transport = new GitCliTransport({
        directory: resolve(
          process.env.GRAEBOARD_SYNC_DIR || "data/sync",
          profile.profileId,
        ),
        repository: profile.repository,
        token: profileToken(db, profile),
      });
      await transport.check();
      const head = await transport.readHead();
      requireThat(
        head === old.canonical_head && head,
        409,
        "새 저장소는 마지막 확정 head와 동일한 검증된 복사본이어야 합니다.",
      );
      const manifest = JSON.parse(
        (await transport.readFile(head, "manifest.json")).toString("utf8"),
      );
      requireThat(
        manifest.teamId === teamId &&
          manifest.repoId === old.repo_id &&
          manifest.bootstrapId === old.bootstrap_id,
        409,
        "새 저장소 신원이 일치하지 않습니다.",
      );
      transaction(db, () => {
        const current = store.readLink();
        requireThat(
          current.generation === old.generation &&
            current.mode === "paused" &&
            !current.lease_owner,
          409,
          "검사 중 연결 상태가 변경되었습니다.",
        );
        store.writeLink({
          profile_id: profile.profileId,
          mode: "recovery",
          generation: old.generation + 1,
          remote_status: null,
          last_error: "연결 복사본 검증 완료. sync:recover 점검 후 재개하세요.",
        });
      });
    } else if (!old)
      store.writeLink({
        repo_id: randomUUID(),
        bootstrap_id: randomUUID(),
        installation_id: sync.installationId,
        writer_epoch: randomUUID(),
        profile_id: profile.profileId,
        mode: "paused",
        updated_at: new Date().toISOString(),
      });
    sync.clear(teamId);
    res.json({ ok: true, mode: store.readLink().mode });
  });
}
function installTeamSyncRoutes(
  app,
  { db, sync, teamAccess, managedTeam, requireSystemAdmin, refreshUser },
) {
  const status = createSyncStatusReader({ db, sync });
  app.get("/api/teams/:id/sync", (req, res) => {
    teamAccess(req.user, id(req));
    res.json(status(id(req)));
  });
  app.post("/api/teams/:id/sync/reconnect", async (req, res) => {
    const teamId = id(req);
    managedTeam(req.user, teamId);
    await sync.reconnect(teamId, req.user.id, () =>
      managedTeam(refreshUser(req), teamId),
    );
    res.json(status(teamId));
  });
  app.post("/api/teams/:id/sync/check", async (req, res) => {
    managedTeam(req.user, id(req));
    const service = sync.get(id(req)),
      checked = await service.transport.check(),
      head = checked.head;
    if (head) {
      const manifest = JSON.parse(
        (await service.transport.readFile(head, "manifest.json")).toString(
          "utf8",
        ),
      );
      const link = sync.store(id(req)).readLink();
      requireThat(
        manifest.teamId === id(req) &&
          manifest.repoId === link.repo_id &&
          manifest.bootstrapId === link.bootstrap_id,
        409,
        "저장소의 팀 또는 연결 신원이 다릅니다.",
      );
    }
    res.json({
      ready: true,
      checks: [
        {
          name: "Git",
          status: "ok",
          message: checked.fixture
            ? "로컬 검증 저장소"
            : head
              ? "비공개 저장소·쓰기 probe·팀 신원 확인"
              : "비공개 저장소·쓰기 probe 확인, 초기 게시 대기",
        },
        { name: "SQLite", status: "ok", message: "팀 저장소 확인" },
      ],
    });
  });
  for (const action of [
    "enable",
    "pause",
    "resume",
    "run",
    "disconnect",
    "checkpoint",
  ])
    app.post("/api/teams/:id/sync/" + action, async (req, res) => {
      managedTeam(req.user, id(req));
      const teamId = id(req),
        link = sync.store(teamId).readLink();
      requireThat(link, 400, "연결 프로필을 선택하세요.");
      if (action === "pause" || action === "disconnect") {
        db.prepare(
          "UPDATE team_sync_links SET mode=?,generation=generation+1 WHERE team_id=?",
        ).run(action === "pause" ? "paused" : "disconnected", teamId);
        sync.capture.refresh();
        try {
          await sync.get(teamId).run({ receiveOnly: true });
        } catch {}
      } else {
        requireThat(
          link.mode !== "disconnected",
          409,
          "연결 해제된 자료는 복구 대조가 필요합니다.",
        );
        if (action === "enable" || action === "resume") {
          requireThat(
            link.mode !== "recovery",
            409,
            "복구 점검을 먼저 완료하세요.",
          );
          db.prepare(
            "UPDATE team_sync_links SET mode=?,generation=generation+1 WHERE team_id=?",
          ).run(link.canonical_head ? "active" : "initializing", teamId);
          sync.capture.refresh();
        }
        if (action === "checkpoint") {
          requireThat(
            link.mode === "active" && link.canonical_head,
            409,
            "활성 동기화의 공유본에서만 checkpoint를 만들 수 있습니다.",
          );
          await sync.get(teamId).checkpoint();
        } else await sync.get(teamId).run({ initialize: !link.canonical_head });
        sync.schedule(teamId);
      }
      res.json(status(teamId));
    });
  app.post("/api/teams/:id/sync/upgrade", async (req, res) => {
    requireSystemAdmin(req.user);
    const teamId = id(req);
    managedTeam(req.user, teamId);
    requireThat(
      !db
        .prepare(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
        )
        .get(teamId),
      409,
      "정리·백업 작업을 먼저 완료하세요.",
    );
    const result = await sync.get(teamId).upgrade({
      expectedHead: req.body.expectedHead,
      expectedHash: req.body.expectedHash,
      peersStopped: req.body.peersStopped,
    });
    sync.clear(teamId);
    res.json(result);
  });
  app.get("/api/teams/:id/sync/conflicts", (req, res) => {
    managedTeam(req.user, id(req));
    const s = sync.store(id(req)),
      conflicts = db
        .prepare(
          "SELECT payload FROM sync_conflicts WHERE team_id=? ORDER BY conflict_id",
        )
        .all(id(req))
        .map((row) => JSON.parse(row.payload)),
      head = s.readLink()?.canonical_head;
    res.json({
      conflicts: conflicts.map((c) => ({
        conflictId: c.conflictId,
        opId: c.opId,
        createdAt: c.operation.createdAt,
        result: c.reason,
        target: c.operation.changes
          .map((x) => x.entity + " " + x.key.join("/"))
          .join(", "),
        base: c.operation.changes.map((x) => x.base),
        current: c.current,
        desired: c.operation.changes.map((x) => x.desired),
        resolved: !!c.resolution,
        expectedHead: head,
      })),
    });
  });
  app.post(
    "/api/teams/:id/sync/conflicts/:conflictId/resolve",
    async (req, res) => {
      const teamId = id(req);
      managedTeam(req.user, teamId);
      const result = await sync.resolveConflict(
        teamId,
        {
          conflictId: req.params.conflictId,
          expectedHead: req.body.expectedHead,
          choice: req.body.choice,
          desired: req.body.desired,
          frontier: req.body.frontier,
          actorRef: req.user.id,
        },
        () => managedTeam(refreshUser(req), teamId),
      );
      res.json(result);
    },
  );
  app.post("/api/admin/sync/import", (req, res) => {
    requireSystemAdmin(req.user);
    res
      .status(400)
      .json({ error: "외부 서비스 연결 화면에서 가져오기를 실행하세요." });
  });
}
