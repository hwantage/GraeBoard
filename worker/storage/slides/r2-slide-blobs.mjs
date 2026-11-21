import { digest } from "../../../server/sync/core/protocol.mjs";
import { SLIDE_FILE_EXTENSION } from "../../../shared/slides/slide-file-rules.js";
import { assert } from "../../control/access.mjs";

// Team slide bytes in the team's R2 bucket: immutable objects named by their
// SHA-256, under a prefix separate from images and deployed assets.
export const slideObjectPrefix = (teamId) => `slides/${teamId}/`;
export const slideObjectKey = (teamId, contentHash) =>
  `${slideObjectPrefix(teamId)}${contentHash}.${SLIDE_FILE_EXTENSION}`;

export class R2SlideBlobStore {
  constructor(bucket, teamId) {
    assert(bucket?.put, 503, "슬라이드 파일 저장소 연결을 확인하세요.");
    this.bucket = bucket;
    this.teamId = teamId;
  }
  key(contentHash) {
    assert(/^[a-f0-9]{64}$/.test(contentHash), 400, "자료 해시를 확인하세요.");
    return slideObjectKey(this.teamId, contentHash);
  }
  async has(contentHash) {
    return !!(await this.bucket.head(this.key(contentHash)));
  }
  // The object is complete before any row refers to it.
  async write(contentHash, bytes) {
    assert(
      digest(bytes) === contentHash,
      400,
      "자료 무결성 검사에 실패했습니다.",
    );
    if (await this.has(contentHash)) return;
    await this.bucket.put(this.key(contentHash), bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        teamId: this.teamId,
        createdAt: new Date().toISOString(),
      },
    });
  }
  async read(contentHash) {
    const object = await this.bucket.get(this.key(contentHash));
    assert(object, 500, "슬라이드 자료 파일이 없습니다.");
    const bytes = new Uint8Array(await object.arrayBuffer());
    assert(
      digest(bytes) === contentHash,
      500,
      "슬라이드 자료 파일의 해시가 기록과 다릅니다.",
    );
    return bytes;
  }
  async remove(contentHash) {
    await this.bucket.delete(this.key(contentHash));
  }
}
