import { requireThat } from "../validation.mjs";
import { randomUUID } from "node:crypto";
import { digest, entityId } from "./protocol.mjs";
import { project } from "./reducer.mjs";
import {
  activeImageReferences,
  imageReferences,
  isExcluded,
  retentionId,
  retentionKey,
} from "./retention.mjs";

const imagePath = (url) => url.replace("/api/document-images/", "images/");
const hashOf = (url) => url.split("/").at(-1).slice(0, -5);
const publicJob = (job) => ({
  jobId: job.jobId,
  kind: job.kind,
  phase: job.phase,
  deleted: job.progress.deleted || { count: 0, bytes: 0 },
  hasMore: !["complete", "cancelled"].includes(job.phase),
  ...(job.progress.error ? { error: job.progress.error } : {}),
});
export function maintenanceRevision(snapshot) {
  const link = snapshot.connection;
  return digest({
    entities: snapshot.entities,
    pending: snapshot.pending,
    conflicts: snapshot.conflicts,
    exclusions: snapshot.exclusions,
    head: link?.canonical_head || null,
    generation: link?.generation || 0,
    profile: link?.profile_id || null,
  });
}
export function maintenanceLabel(record) {
  if (record.entity === "task") return `업무 ${record.key[0]}`;
  if (record.entity === "report")
    return record.payload.name || `보고서 ${record.key[0]}`;
  return record.payload.title || `${record.key[0]} 문서 ${record.key.at(-1)}`;
}

// Adapter mutations must each use a short local DB transaction. Network/blob
// operations happen between those transactions, under a persistent job guard.
export class MaintenanceService {
  constructor({
    teamId,
    siteId,
    siteName,
    teamName,
    adapter,
    images,
    transport,
    now = () => Date.now(),
    chunkSize = 25,
    uploadGraceMs = 86400000,
  }) {
    Object.assign(this, {
      teamId,
      siteId,
      siteName,
      teamName,
      adapter,
      images,
      transport,
      now,
      chunkSize,
      uploadGraceMs,
    });
  }
  async verifyArchiveHead(head) {
    const remoteHead = await this.transport.readHead();
    requireThat(
      remoteHead && (await this.transport.verifyReachable(head, remoteHead)),
      409,
      "Git 이력이 변경되었습니다. 보관본을 복구 점검한 뒤 다시 시도하세요.",
    );
  }
  async listing() {
    const snapshot = await this.adapter.snapshot(),
      projection = project(snapshot, snapshot.pending).entities;
    const years = new Set(),
      documents = [];
    for (const record of Object.values(projection))
      if (!record.deleted) {
        if (record.entity === "task")
          for (const year of record.payload.years) years.add(Number(year));
        if (record.entity === "report") years.add(Number(record.payload.year));
        if (record.entity === "document" && record.key[0] === "annual")
          years.add(Number(record.key[1]));
        if (
          record.entity === "document" &&
          !isExcluded(record, projection, snapshot.exclusions)
        )
          documents.push({
            entity: "document",
            key: record.key,
            generation: record.generation,
            label: maintenanceLabel(record),
          });
      }
    const job = await this.adapter.listJob();
    return {
      siteId: this.siteId,
      siteName: this.siteName,
      years: [...years].sort((a, b) => b - a),
      documents,
      retention: snapshot.exclusions.map((row) => ({
        id: retentionId(row),
        kind: row.kind,
        key: retentionKey(row),
        generation: row.generation,
        revision: row.revision,
        label:
          row.kind === "year"
            ? `${retentionKey(row)[0]}년`
            : maintenanceLabel(
                projection[entityId("document", retentionKey(row))] || {
                  entity: "document",
                  key: retentionKey(row),
                  payload: {},
                },
              ),
      })),
      job: job ? publicJob(job) : null,
    };
  }
  async preview(request, actorId) {
    requireThat(
      ["year", "document", "images"].includes(request.kind),
      400,
      "정리 종류가 올바르지 않습니다.",
    );
    const snapshot = await this.adapter.snapshot(),
      link = snapshot.connection;
    requireThat(
      link?.canonical_head && ["active", "paused"].includes(link.mode),
      409,
      "최초 Git 게시와 수신을 완료한 연결에서 정리할 수 있습니다.",
    );
    await this.verifyArchiveHead(link.canonical_head);
    const projection = project(snapshot, snapshot.pending).entities;
    let exclusion = null;
    if (request.kind === "year") {
      requireThat(
        Number.isInteger(request.year) &&
          request.year >= 1900 &&
          request.year <= 9999,
        400,
        "연도를 확인하세요.",
      );
      exclusion = {
        siteId: this.siteId,
        kind: "year",
        key: [String(request.year)],
        generation: "",
      };
    }
    if (request.kind === "document") {
      requireThat(
        request.entity === "document" &&
          Array.isArray(request.key) &&
          typeof request.generation === "string",
        400,
        "문서 식별자가 올바르지 않습니다.",
      );
      const record = projection[entityId("document", request.key)];
      requireThat(
        record && !record.deleted && record.generation === request.generation,
        409,
        "문서가 변경되었습니다. 목록을 새로 불러오세요.",
      );
      exclusion = {
        siteId: this.siteId,
        kind: "document",
        key: request.key,
        generation: record.generation,
      };
    }
    const after = exclusion
      ? [...snapshot.exclusions, exclusion]
      : snapshot.exclusions;
    const affected = Object.values(projection).filter(
      (record) =>
        !record.deleted &&
        !isExcluded(record, projection, snapshot.exclusions) &&
        isExcluded(record, projection, after),
    );
    const protectedUrls = activeImageReferences(
      snapshot,
      snapshot.pending,
      after,
      projection,
      this.teamId,
    );
    const scopeUrls = new Set(imageReferences(affected, this.teamId));
    const protectedCounts = new Map(),
      candidates = [];
    const protect = (reason) =>
      protectedCounts.set(reason, (protectedCounts.get(reason) || 0) + 1);
    for (const image of await this.images.list()) {
      requireThat(
        image.url.startsWith(`/api/document-images/${this.teamId}/`),
        500,
        "이미지 저장소의 팀 경계가 다릅니다.",
      );
      if (request.kind !== "images" && !scopeUrls.has(image.url)) continue;
      if (protectedUrls.has(image.url)) {
        protect("현재 문서·대기 작업·미해결 충돌이 참조");
        continue;
      }
      if (
        !Number.isFinite(Date.parse(image.createdAt)) ||
        this.now() - Date.parse(image.createdAt) < this.uploadGraceMs
      ) {
        protect("최근 업로드 또는 업로드 시간 미확인");
        continue;
      }
      let archive;
      try {
        archive = await this.transport.readFile(
          link.canonical_head,
          imagePath(image.url),
        );
      } catch {
        archive = null;
      }
      if (!archive || digest(archive) !== hashOf(image.url)) {
        protect("Git 보관 사본 미확인");
        continue;
      }
      candidates.push({ url: image.url, size: image.size });
    }
    const counts = new Map();
    for (const record of affected)
      counts.set(record.entity, (counts.get(record.entity) || 0) + 1);
    const job = {
      jobId: randomUUID(),
      kind: request.kind,
      phase: "cancelled",
      createdAt: new Date(this.now()).toISOString(),
      manifest: {
        preview: true,
        actorId,
        expiresAt: this.now() + 600000,
        revision: maintenanceRevision(snapshot),
        head: link.canonical_head,
        exclusion,
        keys: affected.map((record) => entityId(record.entity, record.key)),
        candidates,
      },
      progress: { offset: 0, deleted: { count: 0, bytes: 0 } },
    };
    await this.adapter.savePreview(job);
    const labels = {
      task: "업무",
      cell: "셀",
      document: "문서",
      report: "보고서",
    };
    return {
      token: job.jobId,
      siteName: this.siteName,
      teamName: this.teamName,
      revision: job.manifest.revision,
      items: [...counts].map(([kind, count]) => ({
        label: labels[kind] || kind,
        count,
      })),
      images: {
        count: candidates.length,
        bytes: candidates.reduce((sum, image) => sum + image.size, 0),
      },
      protected: [...protectedCounts].map(([reason, count]) => ({
        reason,
        count,
      })),
    };
  }
  async execute({ token, confirmed }, actorId) {
    requireThat(
      confirmed === true && typeof token === "string",
      400,
      "미리보기 확인이 필요합니다.",
    );
    let job = await this.adapter.readJob(token);
    requireThat(
      job?.manifest.preview &&
        job.phase === "cancelled" &&
        job.manifest.actorId === actorId &&
        job.manifest.expiresAt >= this.now(),
      409,
      "미리보기가 만료되었습니다. 다시 확인하세요.",
    );
    job = await this.adapter.begin(job, {
      actorId,
      now: this.now(),
      revision: job.manifest.revision,
    });
    return this.run(job);
  }
  async resume(jobId) {
    const job = await this.adapter.readJob(jobId);
    requireThat(
      job &&
        !job.manifest.preview &&
        !["cancelled", "complete"].includes(job.phase),
      409,
      "계속할 정리 작업이 없습니다.",
    );
    return this.run(job);
  }
  async run(job) {
    // Claim every chunk separately so retries and concurrent requests cannot
    // delete the same object while a restore or a second executor is running.
    const owner = randomUUID();
    job = await this.adapter.claim(job.jobId, owner, this.now());
    try {
      await this.verifyArchiveHead(job.manifest.head);
      if (job.phase === "failed")
        job.phase = job.progress.resumePhase || "verifying";
      delete job.progress.error;
      if (job.phase === "verifying") {
        job.progress.verifyOffset ||= 0;
        const end = Math.min(
          job.progress.verifyOffset + this.chunkSize,
          job.manifest.candidates.length,
        );
        for (; job.progress.verifyOffset < end; job.progress.verifyOffset++) {
          const image = job.manifest.candidates[job.progress.verifyOffset];
          const bytes = await this.transport.readFile(
            job.manifest.head,
            imagePath(image.url),
          );
          requireThat(
            bytes && digest(bytes) === hashOf(image.url),
            409,
            "Git 이미지 보관 사본을 확인할 수 없습니다. 정리를 멈췄습니다.",
          );
        }
        if (job.progress.verifyOffset < job.manifest.candidates.length) {
          await this.adapter.finishChunk(job, owner);
          return publicJob(job);
        }
        await this.adapter.changeVisibility(job, {
          add: job.manifest.exclusion,
          keys: job.manifest.keys,
          phase: "deleting",
          owner,
        });
        job.phase = "deleting";
      }
      if (job.phase === "deleting") {
        const end = Math.min(
          job.progress.offset + this.chunkSize,
          job.manifest.candidates.length,
        );
        for (; job.progress.offset < end; job.progress.offset++) {
          const image = job.manifest.candidates[job.progress.offset];
          // Delete is idempotent after a crash between object deletion and the
          // saved cursor. Counts describe the completed manifest, not requests.
          await this.images.remove(image.url);
          job.progress.deleted.count++;
          job.progress.deleted.bytes += image.size;
        }
        if (job.progress.offset === job.manifest.candidates.length)
          job.phase = "complete";
      }
      if (job.phase === "restoring") {
        const end = Math.min(
          job.progress.offset + this.chunkSize,
          job.manifest.restoreImages.length,
        );
        for (; job.progress.offset < end; job.progress.offset++) {
          const url = job.manifest.restoreImages[job.progress.offset];
          if (await this.images.has(url)) continue;
          const bytes = await this.transport.readFile(
            job.manifest.head,
            imagePath(url),
          );
          requireThat(
            bytes && digest(bytes) === hashOf(url),
            409,
            "복원 이미지가 Git에 없거나 손상되었습니다.",
          );
          await this.images.install(url, bytes);
        }
        if (job.progress.offset === job.manifest.restoreImages.length) {
          await this.adapter.changeVisibility(job, {
            remove: job.manifest.retention,
            keys: job.manifest.keys,
            phase: "complete",
            owner,
          });
          job.phase = "complete";
        }
      }
      await this.adapter.finishChunk(job, owner);
      return publicJob(job);
    } catch (error) {
      job.progress.resumePhase = job.phase;
      job.progress.error = error.message;
      job.phase = "failed";
      await this.adapter.finishChunk(job, owner);
      throw error;
    }
  }
  async restore({ retentionId: id, expectedRevision }, actorId) {
    const snapshot = await this.adapter.snapshot(),
      retention = snapshot.exclusions.find((row) => retentionId(row) === id);
    requireThat(
      retention && retention.revision === expectedRevision,
      409,
      "보관 상태가 바뀌었습니다. 목록을 새로 불러오세요.",
    );
    requireThat(
      snapshot.connection?.canonical_head,
      409,
      "Git 연결이 필요합니다.",
    );
    const projection = project(snapshot, snapshot.pending).entities,
      after = snapshot.exclusions.filter((row) => retentionId(row) !== id);
    const affected = Object.values(projection).filter(
      (record) =>
        !record.deleted &&
        isExcluded(record, projection, snapshot.exclusions) &&
        !isExcluded(record, projection, after),
    );
    const job = {
      jobId: randomUUID(),
      kind: "restore",
      phase: "cancelled",
      createdAt: new Date(this.now()).toISOString(),
      manifest: {
        preview: true,
        actorId,
        expiresAt: this.now() + 600000,
        revision: maintenanceRevision(snapshot),
        head: snapshot.connection.canonical_head,
        retention,
        keys: affected.map((record) => entityId(record.entity, record.key)),
        restoreImages: imageReferences(affected, this.teamId),
      },
      progress: { offset: 0, deleted: { count: 0, bytes: 0 } },
    };
    await this.adapter.savePreview(job);
    const claimed = await this.adapter.begin(job, {
      actorId,
      now: this.now(),
      revision: job.manifest.revision,
    });
    return this.run(claimed);
  }
}
