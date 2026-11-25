import { randomBytes, randomUUID } from "node:crypto";
import { HttpError, requireThat } from "../../../shared/validation.js";
import {
  slideThumbnailBytes,
  slideThumbnailCache,
  slideThumbnailImage,
  validSlideThumbnail,
} from "./slide-thumbnail-cache.mjs";
import { canContribute } from "../../../shared/domain.js";
import {
  isSlideRequestId,
  isSlideShareId,
  MAX_SLIDE_SHARE_BYTES,
  normalizeSlideTitle,
  SLIDE_SHARE_TTL_MS,
  slideContentHash,
  slideFileProblem,
  slideTitleProblem,
} from "../../../shared/slides/slide-file-rules.js";

// Team slide files: permissions, conditional saves and temporary shares. The
// repository keeps metadata and bytes; this service never interprets the
// bytes. Every call checks the caller's team access again.
export class SlideFileService {
  constructor(
    repository,
    user,
    { teamAccess, now = () => new Date(), thumbnailScope = repository },
  ) {
    this.repository = repository;
    this.user = user;
    this.teamAccess = teamAccess;
    this.thumbnailScope = thumbnailScope;
    this.now = now;
  }
  async #read(teamId) {
    requireThat(this.user, 401, "로그인이 필요합니다.");
    await this.teamAccess(this.user, teamId);
    return canContribute(this.user, teamId);
  }
  async #write(teamId) {
    requireThat(
      await this.#read(teamId),
      403,
      "이 팀의 자료를 바꿀 권한이 없습니다.",
    );
  }
  #title(value) {
    const problem = slideTitleProblem(value);
    requireThat(!problem, 400, problem);
    return normalizeSlideTitle(value);
  }
  async #content(bytes) {
    const problem = slideFileProblem(bytes);
    requireThat(!problem, problem.includes("까지") ? 413 : 400, problem);
    return { bytes, contentHash: await slideContentHash(bytes) };
  }
  #request(value) {
    requireThat(isSlideRequestId(value), 400, "저장 요청 ID가 필요합니다.");
    return value;
  }
  async #file(teamId, fileId) {
    const file = await this.repository.get(teamId, fileId);
    requireThat(file, 404, "자료를 찾을 수 없습니다.");
    return file;
  }
  async list(teamId) {
    const canWrite = await this.#read(teamId);
    return { files: await this.repository.list(teamId), canWrite };
  }
  async get(teamId, fileId) {
    await this.#read(teamId);
    return this.#file(teamId, fileId);
  }
  async read(teamId, fileId) {
    await this.#read(teamId);
    const stored = await this.repository.read(teamId, fileId);
    requireThat(stored, 404, "자료를 찾을 수 없습니다.");
    return stored;
  }
  // Card thumbnails are a cache anyone can draw again from the file, kept in
  // the site's store and, in front of it, in memory. A store that cannot be
  // reached never fails a request: a read answers like a card nobody has
  // drawn yet, and a write leaves the picture in memory only, which is all
  // there was before thumbnails were stored.
  async thumbnail(teamId, fileId) {
    const file = await this.get(teamId, fileId);
    const cache = slideThumbnailCache(this.thumbnailScope);
    const key = teamId + "/" + file.contentHash;
    let image = cache.get(key);
    if (image === null) {
      const stored = await this.repository
        .thumbnail(teamId, file.contentHash)
        .catch(() => null);
      if (stored) cache.put(key, (image = slideThumbnailImage(stored)));
    }
    return { hash: file.contentHash, image };
  }
  async putThumbnail(teamId, fileId, { hash, image }) {
    await this.#write(teamId);
    const file = await this.#file(teamId, fileId);
    requireThat(hash === file.contentHash, 409, "자료가 변경되었습니다.");
    requireThat(
      validSlideThumbnail(image),
      400,
      "올바르지 않은 미리보기입니다.",
    );
    // The store answers with the picture it keeps, which is an earlier one
    // when this is not the first write, so memory serves what a restart will.
    const kept = await this.repository
      .putThumbnail(teamId, hash, slideThumbnailBytes(image))
      .then(
        (stored) => stored && slideThumbnailImage(stored),
        () => image,
      );
    // The content stopped being kept while the picture was written.
    requireThat(kept !== null, 409, "자료가 변경되었습니다.");
    slideThumbnailCache(this.thumbnailScope).put(teamId + "/" + hash, kept);
    return {};
  }
  async create(teamId, { title, bytes, requestId }) {
    await this.#write(teamId);
    return this.repository.create({
      id: randomUUID(),
      teamId,
      title: this.#title(title),
      ...(await this.#content(bytes)),
      requestId: this.#request(requestId),
      userId: this.user.id,
      at: this.now().toISOString(),
    });
  }
  // Replaces the bytes only when the caller edited the current revision. A
  // repeated request ID returns the result of the first attempt.
  async save(
    teamId,
    fileId,
    { baseRevision, baseTitle, title, bytes, requestId },
  ) {
    await this.#write(teamId);
    requireThat(
      Number.isInteger(baseRevision) && baseRevision > 0,
      428,
      "저장 기준 버전이 필요합니다.",
    );
    const result = await this.repository.replace({
      teamId,
      fileId,
      baseRevision,
      title: title === undefined ? null : this.#title(title),
      baseTitle: title === undefined ? null : this.#title(baseTitle),
      ...(await this.#content(bytes)),
      requestId: this.#request(requestId),
      userId: this.user.id,
      at: this.now().toISOString(),
    });
    requireThat(result, 404, "자료를 찾을 수 없습니다.");
    if (!result.saved)
      throw new HttpError(
        409,
        "다른 팀원이 먼저 저장했습니다. 내 변경은 그대로 남아 있습니다.",
        { current: result.file },
      );
    return result.file;
  }
  async rename(teamId, fileId, title) {
    await this.#write(teamId);
    const file = await this.repository.rename({
      teamId,
      fileId,
      title: this.#title(title),
      userId: this.user.id,
      at: this.now().toISOString(),
    });
    requireThat(file, 404, "자료를 찾을 수 없습니다.");
    return file;
  }
  async copy(teamId, fileId, { title, requestId }) {
    await this.#write(teamId);
    const stored = await this.repository.read(teamId, fileId);
    requireThat(stored, 404, "자료를 찾을 수 없습니다.");
    return this.create(teamId, { title, bytes: stored.bytes, requestId });
  }
  async remove(teamId, fileId) {
    await this.#write(teamId);
    await this.#file(teamId, fileId);
    await this.repository.remove({
      teamId,
      fileId,
      userId: this.user.id,
      at: this.now().toISOString(),
    });
  }
  // A share is a temporary snapshot for team members, never the team original.
  async createShare(teamId, body) {
    await this.#read(teamId);
    requireThat(typeof body === "string" && body.length > 0, 400, "invalid");
    requireThat(
      new TextEncoder().encode(body).byteLength <= MAX_SLIDE_SHARE_BYTES,
      413,
      "tooLarge",
    );
    const id = randomBytes(16).toString("base64url").slice(0, 21);
    const createdAt = this.now();
    await this.repository.createShare({
      id,
      teamId,
      body,
      userId: this.user.id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + SLIDE_SHARE_TTL_MS,
      ).toISOString(),
    });
    return { id };
  }
  async readShare(teamId, id) {
    await this.#read(teamId);
    requireThat(isSlideShareId(id), 400, "invalid");
    const share = await this.repository.readShare(
      teamId,
      id,
      this.now().toISOString(),
    );
    requireThat(share, 404, "missing");
    return share.body;
  }
}
