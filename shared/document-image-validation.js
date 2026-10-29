import { DOCUMENT_IMAGE_PATTERN, isDocumentImage } from "./document-images.js";
import { documentPayloadImageUrls } from "./document-image-references.js";
import { requireThat as assert } from "./http-error.js";

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
export function imageReferences(value, teamId) {
  const refs = documentPayloadImageUrls(value);
  for (const url of refs) {
    const parsed = DOCUMENT_IMAGE_PATTERN.exec(url);
    assert(
      parsed && isDocumentImage(url) && parsed[1] === teamId,
      400,
      "다른 팀의 이미지나 올바르지 않은 이미지 주소입니다.",
    );
  }
  return refs;
}
