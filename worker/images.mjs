import { digest } from "../server/sync/protocol.mjs";
import {
  MAX_IMAGE_BYTES,
  DOCUMENT_IMAGE_PATTERN,
} from "../shared/document-images.js";
import { assert } from "./access.mjs";

export function stillImage(bytes) {
  const b = Buffer.from(bytes);
  if (
    b.length >= 12 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let end = false;
    for (let pos = 8; pos + 12 <= b.length;) {
      const length = b.readUInt32BE(pos),
        type = b.toString("ascii", pos + 4, pos + 8);
      assert(length <= b.length - pos - 12, 400, "PNG 파일이 손상되었습니다.");
      assert(type !== "acTL", 400, "정지 이미지만 지원합니다.");
      pos += length + 12;
      if (type === "IEND") {
        end = true;
        assert(pos === b.length, 400, "PNG 파일이 손상되었습니다.");
        break;
      }
    }
    assert(end, 400, "PNG 파일이 손상되었습니다.");
    return "image/png";
  }
  if (
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    assert(
      b.readUInt32LE(4) + 8 === b.length,
      400,
      "WebP 파일이 손상되었습니다.",
    );
    for (let pos = 12; pos < b.length;) {
      assert(pos + 8 <= b.length, 400, "WebP 파일이 손상되었습니다.");
      const type = b.toString("ascii", pos, pos + 4),
        length = b.readUInt32LE(pos + 4);
      assert(length <= b.length - pos - 8, 400, "WebP 파일이 손상되었습니다.");
      assert(
        type !== "ANIM" &&
          type !== "ANMF" &&
          !(type === "VP8X" && b[pos + 8] & 2),
        400,
        "정지 이미지만 지원합니다.",
      );
      pos += 8 + length + (length & 1);
    }
    return "image/webp";
  }
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  throw new Error("PNG·JPEG·WebP 정지 이미지만 지원합니다.");
}
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
export function imageReferences(value, teamId) {
  const refs = new Set();
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") {
      for (const m of current.matchAll(
        /\/api\/document-images\/[^\s"'\\<>()[\]]+/g,
      )) {
        const parsed = DOCUMENT_IMAGE_PATTERN.exec(m[0]);
        assert(
          parsed && parsed[1] === teamId,
          400,
          "다른 팀의 이미지나 올바르지 않은 이미지 주소입니다.",
        );
        refs.add(`/api/document-images/${teamId}/${parsed[2]}.webp`);
      }
    } else if (current && typeof current === "object")
      for (const child of Object.values(current)) pending.push(child);
  }
  return [...refs];
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
  async validate(value) {
    for (const url of imageReferences(value, this.teamId))
      assert(
        await this.has(url),
        400,
        "문서 이미지가 없습니다. 이미지를 다시 붙여넣으세요.",
      );
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
