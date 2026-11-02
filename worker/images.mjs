import { digest } from "../server/sync/protocol.mjs";
import {
  MAX_IMAGE_BYTES,
  DOCUMENT_IMAGE_PATTERN,
} from "../shared/document-images.js";
import { assert } from "./access.mjs";

import {
  stillImage,
  imageReferences,
} from "../shared/document-image-validation.js";
export { stillImage, imageReferences };
export async function convertImage(file, images) {
  assert(
    file && typeof file.arrayBuffer === "function" && file.size > 0,
    400,
    "붙여넣을 이미지가 없습니다.",
  );
  assert(
    file.size <= MAX_IMAGE_BYTES,
    413,
    "이미지는 파일당 10MiB까지 붙여넣을 수 있습니다.",
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert(bytes.length <= MAX_IMAGE_BYTES, 413, "이미지가 너무 큽니다.");
  let format;
  try {
    format = stillImage(bytes);
  } catch (error) {
    assert(false, 400, error.message);
  }
  const input = new Blob([bytes]);
  const info = await images.info(input.stream());
  assert(
    info.format === format &&
      info.width > 0 &&
      info.height > 0 &&
      info.width * info.height <= 40_000_000,
    400,
    "최대 4천만 화소의 PNG·JPEG·WebP 이미지를 선택하세요.",
  );
  const converted = await images
    .input(input.stream())
    .transform({ width: 4096, height: 4096, fit: "scale-down" })
    .output({ format: "image/webp", quality: 90, anim: false });
  const output = new Uint8Array(await converted.response().arrayBuffer());
  assert(output.length <= MAX_IMAGE_BYTES, 413, "변환한 이미지가 너무 큽니다.");
  assert(
    stillImage(output) === "image/webp",
    502,
    "이미지 변환 결과가 올바르지 않습니다.",
  );
  return { bytes: output, hash: digest(output) };
}
export class R2ImageStore {
  constructor(bucket, teamId) {
    this.bucket = bucket;
    this.teamId = teamId;
  }
  key(url) {
    const match = DOCUMENT_IMAGE_PATTERN.exec(url);
    assert(match && match[1] === this.teamId, 400, "다른 팀의 이미지입니다.");
    return `images/${this.teamId}/${match[2]}.webp`;
  }
  async read(url) {
    const o = await this.getObject(url);
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }
  getObject(url) {
    return this.bucket.get(this.key(url));
  }
  async has(url) {
    return !!(await this.bucket.head(this.key(url)));
  }
  async install(url, bytes) {
    const key = this.key(url),
      hash = key.split("/").at(-1).slice(0, -5);
    assert(
      bytes.length <= MAX_IMAGE_BYTES &&
        digest(bytes) === hash &&
        stillImage(bytes) === "image/webp",
      400,
      "이미지 무결성 검사에 실패했습니다.",
    );
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: {
        teamId: this.teamId,
        createdAt: new Date().toISOString(),
      },
    });
  }
  async remove(url) {
    await this.bucket.delete(this.key(url));
  }
  async list() {
    const result = [];
    let cursor;
    do {
      const page = await this.bucket.list({
        prefix: `images/${this.teamId}/`,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.objects) {
        const file = item.key.split("/").at(-1);
        if (/^[a-f0-9]{64}\.webp$/.test(file))
          result.push({
            url: `/api/document-images/${this.teamId}/${file}`,
            size: item.size,
            createdAt: new Date(item.uploaded).toISOString(),
          });
      }
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    return result;
  }
  async check() {
    const key = `probes/${this.teamId}/${crypto.randomUUID()}`,
      bytes = crypto.getRandomValues(new Uint8Array(32));
    await this.bucket.put(key, bytes);
    try {
      const got = await this.bucket.get(key);
      assert(
        got &&
          digest(new Uint8Array(await got.arrayBuffer())) === digest(bytes),
        502,
        "이미지 저장소 검사에 실패했습니다.",
      );
    } finally {
      await this.bucket.delete(key);
    }
    return { status: "ok", provider: "r2" };
  }
}
