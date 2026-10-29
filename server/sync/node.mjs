import { createNodeMutationBridge } from "./node-mutations.mjs";
import { createSyncErrorRecorder } from "./node-errors.mjs";
import { createReceiptCapacityGuard } from "./receipt-capacity.mjs";
import { createSyncNotifier } from "./notifications.mjs";
import { syncSetupKeys } from "./setup-key-issuer.mjs";
import { SyncInterruption } from "./errors.mjs";
import { profileToken } from "./credentials.mjs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { transaction } from "../db.mjs";
import { createNodeLeaseStores } from "./node-leases.mjs";
import { materialize } from "./entities.mjs";
import { installCapture } from "./capture.mjs";
import {
  createNodeBackground,
  assertSnapshotGuard,
} from "./node-background.mjs";
import { GitCliTransport, repositoryUrl } from "./git-cli.mjs";

import { requireThat } from "../../shared/validation.js";
import { validateSyncProfiles } from "./profiles.mjs";

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
  validateSyncProfiles(profiles, options.transports);
  let background;
  const { store, releaseAll } = createNodeLeaseStores(db, installationId);
  const capacity = createReceiptCapacityGuard(db);
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
  const recordError = createSyncErrorRecorder(db, capture);
  const notify = createSyncNotifier({
    db,
    clearTeam,
    documentEvents,
    cellEvents,
  });
  const mutation = createNodeMutationBridge({
    db,
    store,
    capture,
    notify,
    installationId,
    isStopped: () => stopped,
    recordError,
  });
  function getBackground() {
    if (!background || background.closed) {
      const leases = new Map();
      background = createNodeBackground({
        db,
        onMutation: async (request, { workerId, request: computation }) => {
          const result = await mutation(request, {
            upgrading: computation.action === "upgrade",
          });
          if (request.action === "acquire" && result)
            leases.set(request.teamId, { owner: request.owner, workerId });
          if (request.action === "release") leases.delete(request.teamId);
          return result;
        },
        timeoutMs: options.backgroundTimeoutMs,
        ...(options.backgroundWorkerUrl
          ? { workerUrl: options.backgroundWorkerUrl }
          : {}),
        onProgress({ workerId, teamId }) {
          const lease = leases.get(teamId);
          if (lease?.workerId !== workerId) return;
          const now = Date.now();
          db.prepare(
            "UPDATE team_sync_links SET lease_until=? WHERE team_id=? AND lease_owner=? AND lease_until>?",
          ).run(now + 600000, teamId, lease.owner, now);
        },
        onExit(_code, { workerId }) {
          // Only release leases after termination, never while a previous worker
          // could still submit a canonical mutation.
          for (const [teamId, lease] of leases)
            if (lease.workerId === workerId) {
              store(teamId).release(lease.owner);
              leases.delete(teamId);
            }
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
            capacity.check(link, prepared.operation);
            raw.enqueue(prepared.operation);
            changed = materialize(
              db,
              teamId,
              prepared.changedEntities,
              prepared.previous,
              { actorId: request.actorRef, retiredKeys: prepared.retiredKeys },
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
      notify(teamId, changed, {
        previous: prepared.previous,
        entities: prepared.changedEntities,
      });
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
    const link = store(teamId).readLink();
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
    let running, runningAction;
    const request = (action, runOptions = {}) => {
      if (running) {
        requireThat(
          runningAction === action,
          409,
          "진행 중인 동기화 작업이 끝난 뒤 다시 실행하세요.",
        );
        return running;
      }
      runningAction = action;
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
          if (!stopped) recordError(teamId, error);
          throw error;
        })
        .finally(() => (running = null));
      return running;
    };
    const service = {
      transport,
      run: (runOptions) => request("run", runOptions),
      checkpoint: () => request("checkpoint"),
      upgrade: (options) => request("upgrade", options),
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
      let retryDelay = 60000;
      try {
        const link = store(teamId).readLink();
        if (["active", "initializing", "paused"].includes(link?.mode))
          await get(teamId).run({ initialize: link.mode === "initializing" });
      } catch (error) {
        retryDelay = Math.max(retryDelay, (error.retryAt || 0) - Date.now());
      } finally {
        schedule(teamId, retryDelay);
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
    setupConfigPath:
      options.setupConfigPath === undefined
        ? options.profiles
          ? null
          : resolve(".env")
        : options.setupConfigPath,
    isBusy: (teamId) =>
      !!services.get(teamId)?.idle() || !!store(teamId).readLink()?.lease_owner,
    installationId,
    store,
    get,
    resolveConflict,
    reconnect,
    capture,
    safeProfile,
    schedule,
    notify,
    // Install or correct a profile without restarting. Callers validate the
    // same list first (dryRun) so a rejected profile never reaches the file.
    apply(profile, { dryRun = false } = {}) {
      const index = profiles.findIndex(
        (p) => p.profileId === profile.profileId,
      );
      const next =
        index < 0
          ? [...profiles, profile]
          : profiles.map((p, i) => (i === index ? { ...p, ...profile } : p));
      validateSyncProfiles(next, options.transports);
      if (dryRun) return;
      if (index < 0) profiles.push(profile);
      else Object.assign(profiles[index], profile);
    },
    clear(teamId) {
      services.delete(teamId);
      capacity.clear();
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
      releaseAll();
    },
  };
}

export { installSyncRoutes } from "./node-routes.mjs";
