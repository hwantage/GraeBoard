import { installSetupKeyRoutes, syncSetupKeys } from "./setup-key-issuer.mjs";
import { SQLITE_VERSION } from "../migrations/sqlite.mjs";
import { isRecoveryError } from "./errors.mjs";
import { profileToken } from "./credentials.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transaction, getTasksById } from "../db.mjs";
import { sqliteTeamStore } from "../storage/sqlite.mjs";
import { materialize } from "./entities.mjs";
import { installCapture } from "./capture.mjs";
import {
  createNodeBackground,
  assertSnapshotGuard,
} from "./node-background.mjs";
import { GitCliTransport, repositoryUrl } from "./git-cli.mjs";
import { canonical } from "./protocol.mjs";
import { documentImageUrls } from "../document-images.mjs";
import { requireThat } from "../validation.mjs";
import { retentionView } from "./visibility.mjs";

export function imageReferences(state) {
  const markdowns = [];
  for (const e of Object.values(state.entities))
    if (e.entity === "document") markdowns.push(e.payload.markdown);
  for (const c of Object.values(state.conflicts))
    if (!c.resolution)
      for (const change of c.operation.changes)
        if (change.entity === "document") {
          if (change.base?.markdown) markdowns.push(change.base.markdown);
          if (change.desired?.markdown) markdowns.push(change.desired.markdown);
        }
  return [...new Set(markdowns.flatMap(documentImageUrls))];
}
export function createNodeSync({
  db,
  documentImagesDir,
  documentEvents,
  cellEvents,
  clearTeam,
  options = {},
}) {
  const profiles =
    options.profiles || JSON.parse(process.env.GRAEBOARD_SYNC_PROFILES || "[]");
  const installationId =
    options.installationId || process.env.GRAEBOARD_INSTALLATION_ID;
  const services = new Map(),
    timers = new Map();
  let stopped = false;
  const profileIds = new Set(),
    resources = new Map();
  for (const profile of profiles) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.profileId) ||
      profileIds.has(profile.profileId)
    )
      throw new Error("Duplicate or invalid synchronization profile");
    profileIds.add(profile.profileId);
    if (
      profile.replaces &&
      !profiles.some(
        (old) =>
          old.profileId === profile.replaces &&
          old.teamId === profile.teamId &&
          old.profileId !== profile.profileId,
      )
    )
      throw new Error("Replacement profile identity mismatch");
    if (
      profiles.filter(
        (other) => other.teamId === profile.teamId && !other.replaces,
      ).length !== 1
    )
      throw new Error("A team requires exactly one original resource profile");
    const repository =
      options.transports?.[profile.profileId]?.repository ||
      repositoryUrl(profile.repository);
    if (
      resources.has(repository) &&
      resources.get(repository) !== profile.teamId
    )
      throw new Error("One data repository cannot belong to multiple teams");
    resources.set(repository, profile.teamId);
  }
  let background;
  const ownedLeases = new Map();
  const capture = installCapture(db, {
    onPending: (teamId) => schedule(teamId, 1500),
  });
  const safeProfile = (p) => ({
    profileId: p.profileId,
    name: p.name || p.profileId,
    teamId: p.teamId,
    ...(p.replaces ? { replaces: p.replaces } : {}),
    repository: p.repository,
    database: "SQLite",
    images: "내부 이미지 폴더",
    ready: !!installationId,
  });
  function notify(teamId, keys, { retentionChanged = false } = {}) {
    clearTeam?.(teamId);
    documentEvents.invalidate("team:" + teamId);
    for (const key of keys) {
      const [entity, parts] = JSON.parse(key);
      if (entity === "report") documentEvents.invalidate("report:" + parts[0]);
      if (entity === "document") {
        const [kind, a, b, c] = parts;
        const body =
          kind === "task"
            ? `task:${a}:${b}`
            : kind === "report"
              ? `report-task:${a}:${b}:${c}`
              : kind === "annual"
                ? `annual_memos:${teamId}:${a}:${b}`
                : kind === "reportMemo"
                  ? `report_memos:${a}:${b}`
                  : `calendar:${a}`;
        documentEvents.notify(body);
        if (kind === "task")
          documentEvents.invalidate(`list:/api/tasks/${a}/documents`);
        if (kind === "report") {
          documentEvents.invalidate("report:" + a);
          documentEvents.invalidate(
            `list:/api/reports/${a}/tasks/${b}/documents`,
          );
        }
        if (kind === "annual")
          documentEvents.invalidate(
            `list:/api/teams/${teamId}/years/${a}/memos`,
          );
        if (kind === "reportMemo") {
          documentEvents.invalidate("report:" + a);
          documentEvents.invalidate(`list:/api/reports/${a}/memos`);
        }
      }
    }
    const changed = keys.map((key) => JSON.parse(key));
    if (retentionChanged || changed.some(([entity]) => entity === "task")) {
      // Membership and retention changes invalidate old scoped replay payloads.
      cellEvents.invalidateTeam(teamId);
    } else {
      // Ordinary remote cell edits keep the existing incremental SSE path.
      // Document-only commits must not force thirty full task snapshots.
      const cells = changed.filter(([entity]) => entity === "cell");
      if (cells.length) {
        const view = retentionView(db, teamId);
        const tasks = new Map(
          getTasksById(db, [...new Set(cells.map(([, key]) => key[0]))])
            .filter(
              (task) =>
                task.teamId === teamId &&
                !task.deletedAt &&
                !view.hidden("task", [task.id]),
            )
            .map((task) => [task.id, task]),
        );
        const updates = cells.flatMap(([, [taskId, key]]) => {
          const cell = tasks.get(taskId)?.cells[key];
          return cell ? [{ taskId, key, ...cell }] : [];
        });
        cellEvents.publish(
          {
            operationId: randomUUID(),
            cells: updates,
            updatedAt: Object.fromEntries(
              [...tasks].map(([id, task]) => [id, task.updatedAt]),
            ),
          },
          tasks,
        );
      }
    }
  }
  function store(teamId) {
    const raw = sqliteTeamStore(db, teamId);
    return {
      ...raw,
      acquire(owner) {
        const now = Date.now(),
          current = raw.readLink();
        if (!current) return false;
        if (current.installation_id !== installationId) {
          db.prepare(
            "UPDATE team_sync_links SET mode='recovery',last_error='Installation identity changed' WHERE team_id=?",
          ).run(teamId);
          return false;
        }
        if (
          db
            .prepare(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND kind<>'backup' AND phase NOT IN ('complete','cancelled')",
            )
            .get(teamId)
        )
          return false;
        const acquired = !!db
          .prepare(
            "UPDATE team_sync_links SET lease_owner=?,lease_until=? WHERE team_id=? AND (lease_owner IS NULL OR lease_until<?)",
          )
          .run(owner, now + 600000, teamId, now).changes;
        if (acquired) ownedLeases.set(teamId, owner);
        return acquired;
      },
      release(owner) {
        db.prepare(
          "UPDATE team_sync_links SET lease_owner=NULL,lease_until=NULL WHERE team_id=? AND lease_owner=?",
        ).run(teamId, owner);
        if (ownedLeases.get(teamId) === owner) ownedLeases.delete(teamId);
      },
    };
  }
  async function mutation({ action, teamId, owner, data }) {
    if (stopped) throw new Error("Synchronization server is stopping");
    const raw = store(teamId);
    if (action === "acquire") return raw.acquire(owner);
    if (action === "release") return raw.release(owner);
    const link = raw.readLink();
    if (
      !link ||
      link.lease_owner !== owner ||
      link.installation_id !== installationId
    )
      throw new Error("Synchronization lease changed");
    if (action === "error") {
      const recovery = isRecoveryError(data);
      db.prepare(
        "UPDATE team_sync_links SET last_error=?,updated_at=?,mode=CASE WHEN ? THEN 'recovery' ELSE mode END,remote_status=CASE WHEN ? THEN NULL ELSE remote_status END WHERE team_id=?",
      ).run(
        data.message,
        new Date().toISOString(),
        Number(recovery),
        Number(recovery),
        teamId,
      );
      if (recovery) capture.refresh();
      return;
    }
    if (action === "finish-import") {
      db.prepare(
        "UPDATE team_sync_links SET mode='active' WHERE team_id=? AND mode='importing' AND canonical_head=?",
      ).run(teamId, data.head);
      capture.refresh();
      return;
    }
    if (action === "status") {
      db.prepare(
        "UPDATE team_sync_links SET remote_status=? WHERE team_id=?",
      ).run(data.serialized, teamId);
      return;
    }
    if (!["active", "initializing", "importing"].includes(link.mode))
      throw new Error("Synchronization was paused during computation");
    if (
      db
        .prepare(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND kind<>'backup' AND phase NOT IN ('complete','cancelled')",
        )
        .get(teamId)
    )
      throw new Error("Team maintenance started during synchronization");
    if (action === "bootstrap") {
      // The worker captured domain + P in one readonly snapshot. New P after
      // that cutoff remains pending and is applied on top of this frozen B0.
      if (link.bootstrap_id !== data.guard.bootstrapId)
        throw new Error("Bootstrap identity changed");
      if (!link.bootstrap_bundle && !link.canonical_head)
        db.prepare(
          "UPDATE team_sync_links SET bootstrap_bundle=? WHERE team_id=? AND bootstrap_bundle IS NULL",
        ).run(data.bundleJson, teamId);
      return;
    }
    if (action === "bootstrap-candidate") {
      if (!link.canonical_head)
        db.prepare(
          "UPDATE team_sync_links SET bootstrap_bundle=? WHERE team_id=?",
        ).run(data.bundleJson, teamId);
      return;
    }
    if (action !== "commit")
      throw new Error("Unsupported synchronization mutation");
    const { prepared, newHead, expectedHead, ackOpIds } = data;
    let changed = [];
    // A new connection has no published C cursor yet. Stage its immutable
    // genesis rows in short transactions; interrupted staging is harmless and
    // revalidated against the same frozen B0 on the next attempt. Domain rows,
    // receipts, ACK and the visible head still change in one final transaction.
    if (expectedHead === null && prepared.patch.entities.length > 1000) {
      for (
        let offset = 0;
        offset < prepared.patch.entities.length;
        offset += 1000
      ) {
        if (stopped) throw new Error("Synchronization server is stopping");
        capture.without(() =>
          transaction(db, () => {
            assertSnapshotGuard(db, teamId, prepared.guard, { touched: [] });
            const current = raw.readLink();
            if (
              current.lease_owner !== owner ||
              !["initializing", "importing"].includes(current.mode)
            )
              throw new Error("Genesis installation was interrupted");
            raw.writeState(null, null, null, {
              entities: prepared.patch.entities.slice(offset, offset + 1000),
              receipts: [],
              conflicts: [],
            });
          }),
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
      prepared.patch.entities = [];
    }
    capture.without(() =>
      transaction(db, () => {
        // Revalidate all local inputs immediately before this short writer. C,
        // payload hashing and V reconstruction were prepared in the worker.
        assertSnapshotGuard(db, teamId, prepared.guard, {
          touched: prepared.touched,
        });
        raw.writeState(null, newHead, null, prepared.patch);
        for (const row of prepared.outboxHashes)
          db.prepare(
            "UPDATE sync_outbox SET payload_hash=? WHERE team_id=? AND op_id=?",
          ).run(row.hash, teamId, row.opId);
        raw.acknowledge(ackOpIds);
        changed = materialize(
          db,
          teamId,
          prepared.changedEntities,
          prepared.previous,
        );
        raw.advanceHead(expectedHead, newHead, prepared.hash);
        db.prepare(
          "UPDATE team_sync_links SET mode=CASE WHEN mode='initializing' THEN 'active' ELSE mode END,last_published_at=CASE WHEN ? THEN ? ELSE last_published_at END,lease_until=? WHERE team_id=?",
        ).run(
          Number(
            prepared.outboxHashes.length > 0 || link.mode === "initializing",
          ),
          new Date().toISOString(),
          Date.now() + 600000,
          teamId,
        );
      }),
    );
    capture.acknowledged(teamId, ackOpIds);
    notify(teamId, changed);
    return { head: newHead, changed: changed.length };
  }
  function getBackground() {
    if (!background || background.closed) {
      const leases = new Map();
      background = createNodeBackground({
        db,
        onMutation: async (request) => {
          const result = await mutation(request);
          if (request.action === "acquire" && result)
            leases.set(request.teamId, request.owner);
          if (request.action === "release") leases.delete(request.teamId);
          return result;
        },
        timeoutMs: options.backgroundTimeoutMs,
        ...(options.backgroundWorkerUrl
          ? { workerUrl: options.backgroundWorkerUrl }
          : {}),
        onExit() {
          // Only release leases after termination, never while a previous worker
          // could still submit a canonical mutation.
          for (const [teamId, owner] of leases) store(teamId).release(owner);
        },
      });
    }
    return background;
  }
  async function reconnect(teamId, actorRef, beforeCommit = () => {}) {
    const raw = store(teamId);
    const assertReconnect = () => {
      const link = raw.readLink();
      requireThat(!stopped, 409, "동기화 서버가 종료 중입니다.");
      requireThat(
        link?.mode === "disconnected",
        409,
        "연결 상태가 변경되었습니다. 새로고침한 뒤 확인하세요.",
      );
      requireThat(
        link.installation_id === installationId,
        409,
        "서버 식별자가 변경되었습니다. 관리자에게 복구 점검을 요청하세요.",
      );
      requireThat(
        !link.lease_owner,
        409,
        "이전 동기화가 마무리 중입니다. 잠시 후 다시 연결하세요.",
      );
      requireThat(
        !db
          .prepare(
            "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
          )
          .get(teamId),
        409,
        "정리·백업 작업이 진행 중입니다. 완료 후 다시 연결하세요.",
      );
      return link;
    };
    assertReconnect();
    // Resolve the existing profile before changing state, without creating a new
    // runner/capture hook or resetting the canonical cursor and pending IDs.
    get(teamId);
    const revision = () =>
      JSON.stringify([
        db.prepare("SELECT total_changes() AS n").get().n,
        db.prepare("PRAGMA data_version").get().data_version,
      ]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const originalRevision = revision();
      const prepared = await getBackground().compute({
        kind: "reconnect",
        teamId,
        actorRef,
      });
      await options.onReconnectPrepared?.({ attempt });
      beforeCommit();
      try {
        capture.without(() =>
          transaction(db, () => {
            assertReconnect();
            assertSnapshotGuard(db, teamId, prepared.guard);
            // Disconnected writes are not in P. Detect changes to documents and
            // other domains as well as tasks, including writes by another handle.
            if (revision() !== originalRevision)
              throw Object.assign(
                new Error("Local data changed during reconnection"),
                { code: "SYNC_SNAPSHOT_CHANGED" },
              );
            if (prepared.operation) raw.enqueue(prepared.operation);
            raw.writeLink({
              mode: prepared.link.canonical_head ? "active" : "paused",
              generation: prepared.link.generation + 1,
              remote_status: null,
              last_error: null,
            });
          }),
        );
      } catch (error) {
        if (error.code !== "SYNC_SNAPSHOT_CHANGED") throw error;
        if (attempt < 2) continue;
        requireThat(
          false,
          409,
          "다른 사용자가 자료를 저장 중입니다. 입력은 보존되어 있으니 잠시 후 다시 연결하세요.",
        );
      }
      capture.refresh();
      schedule(teamId, 100);
      return;
    }
  }
  async function resolveConflict(teamId, request, beforeCommit = () => {}) {
    const raw = store(teamId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const prepared = await getBackground().compute({
        kind: "resolve",
        teamId,
        ...request,
      });
      await options.onResolvePrepared?.({
        ...prepared.metrics,
        attempt,
        operation: prepared.operation,
      });
      // Refresh authorization after the worker yielded. This callback must be
      // synchronous so no other writer can run between authorization and commit.
      beforeCommit();
      const started = performance.now();
      let changed;
      try {
        capture.without(() =>
          transaction(db, () => {
            requireThat(!stopped, 409, "동기화 서버가 종료 중입니다.");
            assertSnapshotGuard(db, teamId, prepared.guard, {
              touched: prepared.touched,
            });
            const link = raw.readLink();
            requireThat(
              link &&
                ["active", "paused"].includes(link.mode) &&
                link.installation_id === installationId &&
                link.writer_epoch === prepared.link.writer_epoch,
              409,
              "동기화 연결 상태를 다시 확인하세요.",
            );
            requireThat(
              !prepared.guard.maintenance,
              409,
              "팀 데이터 정리가 진행 중입니다.",
            );
            raw.enqueue(prepared.operation);
            changed = materialize(
              db,
              teamId,
              prepared.changedEntities,
              prepared.previous,
              { actorId: request.actorRef },
            );
          }),
        );
      } catch (error) {
        if (error.code !== "SYNC_SNAPSHOT_CHANGED") throw error;
        if (attempt < 2) continue;
        requireThat(
          false,
          409,
          "동시 변경이 있습니다. 최신 상태에서 다시 해결하세요.",
        );
      }
      const commitMs = performance.now() - started;
      capture.enqueued(prepared.operation);
      notify(teamId, changed);
      schedule(teamId, 100);
      options.onResolveCommitted?.({
        ...prepared.metrics,
        attempt,
        commitMs,
        changed: changed.length,
      });
      return { ok: true, opId: prepared.operation.opId };
    }
  }
  function get(teamId) {
    if (services.has(teamId)) return services.get(teamId);
    const link = sqliteTeamStore(db, teamId).readLink();
    if (!link) throw new Error("팀 동기화 연결을 먼저 선택하세요.");
    const profile = profiles.find(
      (p) => p.profileId === link.profile_id && p.teamId === teamId,
    );
    if (!profile) throw new Error("설치된 리소스 프로필을 찾을 수 없습니다.");
    const transport =
      options.transports?.[profile.profileId] ||
      new GitCliTransport({
        directory: resolve(
          process.env.GRAEBOARD_SYNC_DIR || "data/sync",
          profile.profileId,
        ),
        repository: profile.repository,
        token: profileToken(db, profile),
      });
    const config = {
      serviceKey: randomUUID(),
      teamId,
      documentImagesDir,
      identity: {
        teamId,
        repoId: link.repo_id,
        ...(profile.peerInstallationId
          ? { peerInstallationId: profile.peerInstallationId }
          : {}),
      },
      transport: {
        directory: transport.directory,
        repository: transport.repository,
        token: transport.token,
        allowLocal:
          !!options.transports?.[profile.profileId] &&
          transport.repository.startsWith("/"),
      },
    };
    let running;
    const request = (action, runOptions = {}) => {
      if (running) return running;
      running = getBackground()
        .compute({ kind: "service", config, action, options: runOptions })
        .then(async (result) => {
          if (!stopped && action === "run")
            await syncSetupKeys(
              db,
              teamId,
              transport,
              profile.peerInstallationId,
            );
          return result;
        })
        .catch((error) => {
          if (!stopped) {
            const recovery = isRecoveryError(error);
            db.prepare(
              "UPDATE team_sync_links SET last_error=?,mode=CASE WHEN ? THEN 'recovery' ELSE mode END,remote_status=CASE WHEN ? THEN NULL ELSE remote_status END WHERE team_id=?",
            ).run(error.message, Number(recovery), Number(recovery), teamId);
            if (recovery) capture.refresh();
          }
          throw error;
        })
        .finally(() => (running = null));
      return running;
    };
    const service = {
      transport,
      run: (runOptions) => request("run", runOptions),
      checkpoint: () => request("checkpoint"),
      idle: () => running,
    };
    services.set(teamId, service);
    return service;
  }
  function schedule(teamId, delay = 60000) {
    if (options.schedule === false || stopped) return;
    const deadline = Date.now() + delay,
      previous = timers.get(teamId);
    if (previous && previous.deadline <= deadline) return;
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(async () => {
      timers.delete(teamId);
      try {
        const link = store(teamId).readLink();
        if (["active", "initializing", "paused"].includes(link?.mode))
          await get(teamId).run({ initialize: link.mode === "initializing" });
      } catch {
      } finally {
        schedule(teamId);
      }
    }, delay);
    timer.unref();
    timers.set(teamId, { timer, deadline });
  }
  for (const l of db
    .prepare("SELECT team_id FROM team_sync_links WHERE mode<>'disconnected'")
    .all())
    schedule(l.team_id, 5000);
  return {
    profiles,
    installationId,
    store,
    get,
    resolveConflict,
    reconnect,
    capture,
    safeProfile,
    schedule,
    notify,
    clear(teamId) {
      services.delete(teamId);
      capture.refresh();
    },
    async close() {
      stopped = true;
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
      await background?.close();
      await Promise.allSettled(
        [...services.values()].map((service) => service.idle()),
      );
      for (const [teamId, owner] of ownedLeases) store(teamId).release(owner);
    },
  };
}

export function installSyncRoutes(
  app,
  { db, teamAccess, managedTeam, requireSystemAdmin, refreshUser, sync },
) {
  installSetupKeyRoutes(app, { db, sync, teamAccess });
  const id = (req) => req.params.id;
  const status = (teamId) => {
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
      pending: db
        .prepare(
          "SELECT COUNT(*) n FROM sync_outbox WHERE team_id=? AND status<>'acknowledged'",
        )
        .get(teamId).n,
      conflicts: db
        .prepare(
          "SELECT COUNT(*) n FROM sync_conflicts WHERE team_id=? AND resolution IS NULL",
        )
        .get(teamId).n,
      lastLocalSavedAt: db
        .prepare("SELECT MAX(created_at) t FROM sync_outbox WHERE team_id=?")
        .get(teamId).t,
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
    };
  };
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
