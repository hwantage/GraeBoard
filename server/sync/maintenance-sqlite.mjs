import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { transaction } from "../db.mjs";
import {
  documentImagePath,
  readDocumentImage,
  writeDocumentImage,
} from "../document-images.mjs";
import { sqliteTeamStore } from "../storage/sqlite.mjs";
import { materialize } from "./entities.mjs";
import { canonical, entityId } from "./protocol.mjs";
import { project } from "./reducer.mjs";
import { MaintenanceService, maintenanceRevision } from "./maintenance.mjs";
import { requireThat } from "../validation.mjs";

const parseJob = (row) =>
  row
    ? {
        jobId: row.job_id,
        kind: row.kind,
        phase: row.phase,
        manifest: JSON.parse(row.manifest),
        progress: JSON.parse(row.progress),
        createdAt: row.created_at,
      }
    : null;
export function sqliteMaintenanceAdapter({ db, teamId, siteId, sync }) {
  const store = sqliteTeamStore(db, teamId);
  const run = (work) =>
    db.syncCapture
      ? db.syncCapture.without(() => transaction(db, work))
      : transaction(db, work);
  const snapshot = () => ({
    ...store.readSnapshot(),
    exclusions: store.readExclusions(siteId),
  });
  const readJob = (id) =>
    parseJob(
      db
        .prepare(
          "SELECT * FROM site_maintenance_jobs WHERE team_id=? AND job_id=?",
        )
        .get(teamId, id),
    );
  const save = (job) =>
    db
      .prepare(
        "UPDATE site_maintenance_jobs SET phase=?,manifest=?,progress=? WHERE team_id=? AND job_id=?",
      )
      .run(
        job.phase,
        canonical(job.manifest),
        canonical(job.progress),
        teamId,
        job.jobId,
      );
  const requireOwner = (id, owner) => {
    const job = readJob(id);
    requireThat(
      job?.progress.owner === owner,
      409,
      "다른 요청이 이 정리 작업을 실행 중입니다.",
    );
    return job;
  };
  return {
    snapshot,
    readJob,
    listJob: () =>
      parseJob(
        db
          .prepare(
            "SELECT * FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled') AND kind<>'backup' ORDER BY created_at DESC LIMIT 1",
          )
          .get(teamId),
      ),
    savePreview(job) {
      run(() =>
        db
          .prepare(
            "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            job.jobId,
            teamId,
            job.kind,
            job.phase,
            canonical(job.manifest),
            canonical(job.progress),
            job.createdAt,
          ),
      );
    },
    begin(input, { actorId, now, revision }) {
      return run(() => {
        const job = readJob(input.jobId),
          current = snapshot();
        requireThat(
          job?.phase === "cancelled" &&
            job.manifest.preview &&
            job.manifest.actorId === actorId &&
            job.manifest.expiresAt >= now,
          409,
          "미리보기가 만료되었거나 이미 실행되었습니다.",
        );
        requireThat(
          !db
            .prepare(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
            )
            .get(teamId),
          409,
          "다른 정리 또는 백업 작업이 실행 중입니다.",
        );
        requireThat(
          !current.connection?.lease_owner ||
            current.connection.lease_until < now,
          409,
          "동기화 실행이 끝난 후 다시 시도하세요.",
        );
        requireThat(
          current.connection &&
            ["active", "paused"].includes(current.connection.mode),
          409,
          "연결 상태를 확인한 후 다시 시도하세요.",
        );
        requireThat(
          maintenanceRevision(current) === revision,
          409,
          "자료가 변경되었습니다. 정리 미리보기를 다시 확인하세요.",
        );
        job.manifest.preview = false;
        job.phase = job.kind === "restore" ? "restoring" : "verifying";
        save(job);
        return job;
      });
    },
    claim(id, owner, now) {
      return run(() => {
        const job = readJob(id);
        requireThat(
          job &&
            !job.manifest.preview &&
            !["complete", "cancelled"].includes(job.phase),
          409,
          "계속할 정리 작업이 없습니다.",
        );
        requireThat(
          !job.progress.owner,
          409,
          "이 정리 작업을 이미 실행 중입니다. 중단된 프로세스의 작업은 관리자 복구 점검이 필요합니다.",
        );
        job.progress.owner = owner;
        job.progress.until = now + 600000;
        save(job);
        return job;
      });
    },
    changeVisibility(job, { add, remove, keys, phase, owner }) {
      run(() => {
        requireOwner(job.jobId, owner);
        if (add) {
          const revision = store.nextRevision("retention", [
            add.kind,
            add.key,
            add.generation,
          ]);
          store.putExclusion({
            ...add,
            revision,
            createdAt: new Date().toISOString(),
          });
        }
        if (remove)
          db.prepare(
            "DELETE FROM site_retention WHERE team_id=? AND site_id=? AND kind=? AND entity_key=? AND generation=? AND revision=?",
          ).run(
            teamId,
            siteId,
            remove.kind,
            canonical(remove.key || JSON.parse(remove.entity_key)),
            remove.generation,
            remove.revision,
          );
        const state = project(store.readState(), store.readPending()),
          records = {};
        for (const encoded of keys) {
          const [entity, key] = JSON.parse(encoded);
          store.nextRevision(entity, key);
          if (state.entities[entityId(entity, key)])
            records[encoded] = state.entities[encoded];
        }
        // Application rows stay in place. Advance existing edit versions so a
        // tab opened before cleanup cannot overwrite a later restored document.
        materialize(db, teamId, records);
        store.appendEvent("retention", {
          jobId: job.jobId,
          action: remove ? "restore" : "exclude",
          keys,
        });
        job.phase = phase;
        save(job);
      });
      sync?.notify?.(teamId, keys, { retentionChanged: true });
    },
    finishChunk(job, owner) {
      run(() => {
        requireOwner(job.jobId, owner);
        delete job.progress.owner;
        delete job.progress.until;
        save(job);
        if (["complete", "failed"].includes(job.phase))
          db.prepare(
            "INSERT INTO audit(id,team_id,actor_id,action,target,before_json,after_json,created_at) VALUES(?,?,?,'site-maintenance',?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET after_json=excluded.after_json,created_at=excluded.created_at",
          ).run(
            job.jobId,
            teamId,
            job.manifest.actorId,
            job.jobId,
            canonical({
              kind: job.kind,
              phase: job.phase,
              deleted: job.progress.deleted,
            }),
            new Date().toISOString(),
          );
      });
    },
  };
}

export function localMaintenanceImages(directory, teamId) {
  const folder = dirname(
    documentImagePath(
      directory,
      `/api/document-images/${teamId}/${"0".repeat(64)}.webp`,
    ),
  );
  return {
    list() {
      if (!existsSync(folder)) return [];
      return readdirSync(folder)
        .filter((name) => /^[a-f0-9]{64}\.webp$/.test(name))
        .flatMap((name) => {
          const info = lstatSync(join(folder, name));
          return info.isFile()
            ? [
                {
                  url: `/api/document-images/${teamId}/${name}`,
                  size: info.size,
                  createdAt: info.mtime.toISOString(),
                },
              ]
            : [];
        });
    },
    has: (url) => existsSync(documentImagePath(directory, url)),
    read: (url) =>
      existsSync(documentImagePath(directory, url))
        ? readDocumentImage(directory, url)
        : null,
    install: (url, bytes) => writeDocumentImage(directory, url, bytes),
    remove(url) {
      try {
        unlinkSync(documentImagePath(directory, url));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
}

export function installMaintenanceRoutes(
  app,
  { db, requireSystemAdmin, teamAccess, sync, documentImagesDir },
) {
  function service(req) {
    requireSystemAdmin(req.user);
    const teamId = req.params.id;
    const team = teamAccess(req.user, teamId);
    const siteId =
      sync.store(teamId).readLink()?.installation_id ||
      sync.installationId ||
      "internal";
    return new MaintenanceService({
      teamId,
      siteId,
      siteName: "내부 서버",
      teamName: team.name,
      adapter: sqliteMaintenanceAdapter({ db, teamId, siteId, sync }),
      images: localMaintenanceImages(documentImagesDir, teamId),
      transport: {
        readFile: (...args) => sync.get(teamId).transport.readFile(...args),
        readHead: () => sync.get(teamId).transport.readHead(),
        verifyReachable: (...args) =>
          sync.get(teamId).transport.verifyReachable(...args),
      },
    });
  }
  const path = "/api/admin/teams/:id/maintenance";
  app.get(path, async (req, res) => res.json(await service(req).listing()));
  app.post(path + "/preview", async (req, res) =>
    res.json(await service(req).preview(req.body, req.user.id)),
  );
  app.post(path + "/execute", async (req, res) =>
    res.json(await service(req).execute(req.body, req.user.id)),
  );
  app.post(path + "/resume", async (req, res) =>
    res.json(await service(req).resume(req.body.jobId)),
  );
  app.post(path + "/restore", async (req, res) =>
    res.json(await service(req).restore(req.body, req.user.id)),
  );
}
