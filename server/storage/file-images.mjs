import { existsSync, createReadStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  DOCUMENT_IMAGE_PATTERN,
  MAX_IMAGE_BYTES,
} from "../../shared/document-images.js";
import {
  documentImagePath,
  readDocumentImage,
  writeDocumentImage,
} from "../document-images.mjs";
import {
  imageReferences,
  stillImage,
} from "../../shared/document-image-validation.js";
import { requireThat } from "../../shared/validation.js";

// Host byte storage is independent of the team DB engine. Node retains the same
// immutable WebP files and URLs whether ordinary team rows use SQLite or PG.
export class FileImageStore {
  constructor({ directory, teamId }) {
    this.directory = directory;
    this.teamId = teamId;
  }
  path(url) {
    const match = DOCUMENT_IMAGE_PATTERN.exec(url);
    requireThat(match?.[1] === this.teamId, 400, "다른 팀의 이미지입니다.");
    return documentImagePath(this.directory, url);
  }
  has(url) {
    return existsSync(this.path(url));
  }
  read(url) {
    return this.has(url) ? readDocumentImage(this.directory, url) : null;
  }
  getObject(url) {
    const path = this.path(url);
    if (!existsSync(path)) return null;
    return {
      get body() {
        return Readable.toWeb(createReadStream(path));
      },
      arrayBuffer: async () =>
        Uint8Array.from(readDocumentImage(this.directory, url)).buffer,
    };
  }
  install(url, bytes) {
    this.path(url);
    requireThat(
      bytes.length <= MAX_IMAGE_BYTES &&
        createHash("sha256").update(bytes).digest("hex") ===
          DOCUMENT_IMAGE_PATTERN.exec(url)[2] &&
        stillImage(bytes) === "image/webp",
      400,
      "이미지 무결성 검사에 실패했습니다.",
    );
    writeDocumentImage(this.directory, url, bytes);
  }
  remove(url) {
    rmSync(this.path(url), { force: true });
  }
  validate(value) {
    for (const url of imageReferences(value, this.teamId))
      requireThat(
        this.has(url),
        400,
        "문서 이미지가 없습니다. 이미지를 다시 붙여넣으세요.",
      );
  }
}
