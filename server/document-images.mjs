import { canContribute } from "../shared/domain.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import multer from "multer";
import sharp from "sharp";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  DOCUMENT_IMAGE_PATTERN,
  MAX_IMAGE_BYTES,
  isDocumentImage,
  documentImageSource,
} from "../shared/document-images.js";
import { requireThat } from "./validation.mjs";
import { reportDocumentTasks } from "./document-storage.mjs";

export const documentImagesDirectory = () =>
  resolve(process.env.DOCUMENT_IMAGES_DIR || "data/document-images");
const markdownParser = unified().use(remarkParse).use(remarkGfm);
export function documentImageUrls(markdown) {
  if (!markdown?.includes("/api/document-images/")) return [];
  const tree = markdownParser.parse(markdown);
  const definitions = new Map();
  const visit = (node, fn) => {
    fn(node);
    node.children?.forEach((child) => visit(child, fn));
  };
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
  });
  const urls = new Set();
  visit(tree, (node) => {
    const url =
      node.type === "image"
        ? node.url
        : node.type === "imageReference"
          ? definitions.get(node.identifier)
          : null;
    if (url?.startsWith("/api/document-images/"))
      urls.add(documentImageSource(url) || url);
  });
  return [...urls];
}
export function documentImagePath(directory, url) {
  const parts = DOCUMENT_IMAGE_PATTERN.exec(url);
  requireThat(
    parts && isDocumentImage(url),
    400,
    "문서 이미지 주소를 확인하세요.",
  );
  return join(resolve(directory), parts[1], `${parts[2]}.webp`);
}
export function validateDocumentImages(markdown, teamId, directory) {
  for (const url of documentImageUrls(markdown)) {
    const parts = DOCUMENT_IMAGE_PATTERN.exec(url);
    requireThat(
      parts && isDocumentImage(url) && parts[1] === teamId,
      400,
      "같은 팀에 업로드한 문서 이미지만 사용할 수 있습니다.",
    );
    requireThat(
      existsSync(documentImagePath(directory, url)),
      400,
      "문서 이미지를 찾을 수 없습니다. 이미지를 다시 붙여넣어 주세요.",
    );
  }
}
export function readDocumentImage(directory, url) {
  const bytes = readFileSync(documentImagePath(directory, url));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (DOCUMENT_IMAGE_PATTERN.exec(url)[2] !== hash)
    throw new Error("문서 이미지 무결성 검사에 실패했습니다.");
  return bytes;
}
export function removeTeamDocumentImages(directory, teamId) {
  const path = documentImagePath(
    directory,
    `/api/document-images/${teamId}/${"0".repeat(64)}.webp`,
  );
  rmSync(dirname(path), { recursive: true, force: true });
}
// Publish complete immutable files atomically; concurrent identical uploads share
// one file. Unused uploads are retained, so cancellation never removes an image
// referenced by another document, snapshot, exported row or ongoing upload.
export function writeDocumentImage(directory, url, bytes) {
  const path = documentImagePath(directory, url);
  if (existsSync(path)) {
    readDocumentImage(directory, url);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      readDocumentImage(directory, url);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function exportDocumentImages(directory, markdowns) {
  const urls = new Set(markdowns.flatMap(documentImageUrls));
  return [...urls].sort().map((url) => ({
    url,
    mimeType: "image/webp",
    base64: readDocumentImage(directory, url).toString("base64"),
  }));
}
export function databaseImageUrls(db) {
  // Older compatible backups without the document feature have no assets.
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_versions'",
      )
      .get()
  )
    return [];
  return [
    ...new Set(
      db
        .prepare("SELECT markdown FROM document_versions")
        .all()
        .flatMap((row) => documentImageUrls(row.markdown)),
    ),
  ];
}

export function installDocumentImageRoutes(
  app,
  { db, taskAccess, teamAccess, managedTeam, documentImagesDir, refreshUser },
) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
  }).single("image");
  const liveAccess = (req) => {
    const task = taskAccess(req.user, req.params.id, true);
    if (req.params.documentId && req.params.documentId !== "main")
      requireThat(
        db
          .prepare("SELECT 1 FROM task_documents WHERE task_id=? AND id=?")
          .get(task.id, req.params.documentId),
        404,
        "문서를 찾을 수 없습니다.",
      );
    return task.teamId;
  };
  const reportImageWriteAccess = (req) => {
    const row = db
      .prepare("SELECT * FROM reports WHERE id=?")
      .get(req.params.id);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    teamAccess(req.user, row.team_id);
    requireThat(
      canContribute(req.user, row.team_id),
      403,
      "사본에 이미지를 추가할 권한이 없습니다.",
    );
    requireThat(
      reportDocumentTasks(db, row, [req.params.taskId])?.some(
        (task) =>
          task.id === req.params.taskId &&
          (!req.params.documentId ||
            req.params.documentId === "main" ||
            task.documents?.some((doc) => doc.id === req.params.documentId)),
      ),
      404,
      "사본에서 해당 업무를 찾지 못했습니다.",
    );
    return row.team_id;
  };
  for (const [route, access] of [
    ["/api/tasks/:id/document/images", liveAccess],
    ["/api/tasks/:id/documents/:documentId/images", liveAccess],
    ["/api/reports/:id/tasks/:taskId/document/images", reportImageWriteAccess],
    [
      "/api/reports/:id/tasks/:taskId/documents/:documentId/images",
      reportImageWriteAccess,
    ],
  ]) {
    app.post(
      route,
      (req, _res, next) => {
        access(req);
        next();
      },
      (req, res, next) =>
        upload(req, res, (error) => {
          if (error)
            return res
              .status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
              .json({
                error:
                  error.code === "LIMIT_FILE_SIZE"
                    ? "이미지는 파일당 10MiB까지 붙여넣을 수 있습니다."
                    : "이미지 파일 하나를 선택해 주세요.",
              });
          next();
        }),
      async (req, res) => {
        requireThat(
          req.file?.buffer?.length,
          400,
          "붙여넣을 이미지가 없습니다.",
        );
        let bytes;
        try {
          const image = sharp(req.file.buffer, {
            limitInputPixels: 40_000_000,
            failOn: "warning",
          });
          const metadata = await image.metadata();
          requireThat(
            ["png", "jpeg", "webp"].includes(metadata.format) &&
              (metadata.pages || 1) === 1,
            400,
            "PNG·JPEG·WebP 정지 이미지만 지원합니다.",
          );
          bytes = await image
            .rotate()
            .resize({
              width: 4096,
              height: 4096,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 90 })
            .toBuffer();
        } catch (error) {
          requireThat(
            false,
            400,
            error.status === 400
              ? error.message
              : "이미지를 읽을 수 없습니다. 정상적인 PNG·JPEG·WebP 파일(최대 4천만 화소)을 붙여넣어 주세요.",
          );
        }
        // Decoding is asynchronous: recheck the session, membership and task
        // ownership after it finishes, before publishing a file.
        req.user = refreshUser(req);
        const teamId = access(req);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const url = `/api/document-images/${teamId}/${hash}.webp`;
        writeDocumentImage(documentImagesDir, url, bytes);
        res.status(201).json({ url });
      },
    );
  }
  app.get("/api/document-images/:teamId/:file", (req, res) => {
    const url = `/api/document-images/${req.params.teamId}/${req.params.file}`;
    const path = documentImagePath(documentImagesDir, url);
    teamAccess(req.user, req.params.teamId);
    requireThat(existsSync(path), 404, "문서 이미지를 찾을 수 없습니다.");
    res.type("image/webp").sendFile(path, { cacheControl: false });
  });
}
