import { MAX_IMAGE_BYTES } from "../../shared/document-images.js";
import {
  MAX_DOCUMENT_BYTES,
  documentBytes,
  hasDocumentContent,
} from "../../shared/task-documents.js";
import {
  DocumentStorageConflict,
  type DocumentStorage,
} from "../documents/document-storage";
import { getSecretEntry, readSecretCalendar } from "./secret-calendar";
import type { TaskDocument } from "../types";

type ImageRecord = {
  url: string;
  size: number;
  mimeType: string;
  createdAt: number;
  unusedSince?: number;
};
type StoredImage = {
  url: string;
  documentId: string;
  bytes: ArrayBuffer;
  mimeType: string;
};
type StoredDocument = TaskDocument & {
  id: string;
  teamId: string;
  images: ImageRecord[];
  deletedAt?: number;
};
const databases = new Map<string, Promise<IDBDatabase>>();
const name = (userId: string) => `weekly-plan:secret-documents:${userId}`;
const changed = "weekly-plan:secret-document-changed";
const imagePattern =
  /^secret-image:([a-f0-9-]{36})(?:#width=([1-9][0-9]{0,3}))?$/;
const imageSource = (url: string) => {
  const match = imagePattern.exec(url);
  return match && (!match[2] || (+match[2] >= 32 && +match[2] <= 4096))
    ? url.split("#")[0]
    : "";
};
function failure(error: unknown): Error {
  if (error instanceof DocumentStorageConflict) return error;
  if (error instanceof Error && !(error instanceof DOMException)) return error;
  return new Error(
    "시크릿 문서를 저장하거나 불러올 수 없습니다. 브라우저 저장 공간과 설정을 확인해 주세요. 입력은 유지됩니다.",
  );
}
function database(userId: string) {
  let promise = databases.get(userId);
  if (!promise) {
    promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name(userId), 2);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const documents =
          event.oldVersion === 0
            ? db.createObjectStore("documents", { keyPath: "id" })
            : request.transaction!.objectStore("documents");
        const images = db.createObjectStore("images", { keyPath: "url" });
        images.createIndex("documentId", "documentId");
        if (event.oldVersion === 1) {
          const cursor = documents.openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            const document = row.value as Omit<StoredDocument, "images"> & {
              images: (ImageRecord & { bytes: ArrayBuffer })[];
            };
            row.update({
              ...document,
              images: document.images.map(({ bytes, ...metadata }) => {
                images.put({
                  url: metadata.url,
                  documentId: document.id,
                  bytes,
                  mimeType: metadata.mimeType,
                } satisfies StoredImage);
                return { ...metadata, size: bytes.byteLength };
              }),
            });
            cursor.result.continue();
          };
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new Error(
            "시크릿 문서 저장소를 열 수 없습니다. 다른 탭을 닫고 다시 시도해 주세요.",
          ),
        );
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databases.delete(userId);
        };
        resolve(db);
      };
    }).catch((error) => {
      databases.delete(userId);
      throw failure(error);
    });
    databases.set(userId, promise);
  }
  return promise;
}
function announce(userId: string, id: string) {
  window.dispatchEvent(new CustomEvent(changed, { detail: { userId, id } }));
  const channel = new BroadcastChannel(name(userId));
  channel.postMessage(id);
  channel.close();
}
export function subscribeSecretDocuments(
  userId: string,
  receive: (id: string) => void,
) {
  const channel = new BroadcastChannel(name(userId));
  channel.onmessage = (event) => {
    if (typeof event.data === "string") receive(event.data);
  };
  const listener = (event: Event) => {
    const value = (event as CustomEvent).detail;
    if (value?.userId === userId) receive(value.id);
  };
  window.addEventListener(changed, listener);
  return () => {
    channel.close();
    window.removeEventListener(changed, listener);
  };
}
async function update(
  userId: string,
  teamId: string,
  id: string,
  change?: (
    document: StoredDocument,
    transaction: IDBTransaction,
  ) => StoredDocument | null,
  requireEntry = true,
  withImages = false,
): Promise<StoredDocument> {
  const db = await database(userId);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      withImages ? ["documents", "images"] : ["documents"],
      change ? "readwrite" : "readonly",
    );
    const store = transaction.objectStore("documents");
    const request = store.get(id);
    let result: StoredDocument;
    let error: unknown;
    request.onsuccess = () => {
      try {
        if (requireEntry) getSecretEntry(userId, teamId, id);
        result = request.result || {
          id,
          teamId,
          markdown: "",
          revision: 0,
          updatedAt: null,
          images: [],
        };
        if (result.teamId !== teamId)
          throw new Error("시크릿 문서를 찾을 수 없습니다.");
        if (change) {
          const next = change(result, transaction);
          if (next) {
            result = next;
            store.put(next);
          } else {
            store.delete(id);
            const images = transaction.objectStore("images");
            const cursor = images
              .index("documentId")
              .openKeyCursor(IDBKeyRange.only(id));
            cursor.onsuccess = () => {
              if (!cursor.result) return;
              images.delete(cursor.result.primaryKey);
              cursor.result.continue();
            };
          }
        }
      } catch (caught) {
        error = caught;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => {
      if (change) announce(userId, id);
      resolve(result);
    };
    transaction.onabort = () => reject(failure(error || transaction.error));
    transaction.onerror = () => {
      /* onabort reports a single error. */
    };
  });
}
const snapshot = ({
  id,
  markdown,
  revision,
  updatedAt,
}: StoredDocument): TaskDocument => ({
  markdown,
  revision,
  updatedAt,
  sync: { session: id, sequence: Number(revision) },
});
export async function secretDocumentSummaries(userId: string, teamId: string) {
  const db = await database(userId);
  const documents = await new Promise<StoredDocument[]>((resolve, reject) => {
    const request = db
      .transaction("documents")
      .objectStore("documents")
      .getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error));
  });
  // A closed/crashed tab cannot offer undo. Expired tombstones are reclaimed
  // on the next visit as well as when the live toast expires.
  const existing = new Set(
    readSecretCalendar(userId).entries.map((entry) => entry.id),
  );
  for (const document of documents) {
    if (
      document.deletedAt &&
      document.deletedAt < Date.now() - 86400000 &&
      !existing.has(document.id)
    )
      await discardSecretDocument(userId, document.teamId, document.id);
  }
  return new Map(
    documents
      .filter((doc) => doc.teamId === teamId && existing.has(doc.id))
      .map((doc) => [
        doc.id,
        {
          hasDocument: hasDocumentContent(doc.markdown),
          preview: doc.markdown
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/\s+/g, " ")
            .slice(0, 200),
          revision: Number(doc.revision),
          updatedAt: doc.updatedAt || "",
        },
      ]),
  );
}
export async function markSecretDocumentDeleted(
  userId: string,
  teamId: string,
  id: string,
  deleted: boolean,
) {
  await update(
    userId,
    teamId,
    id,
    (document) => ({
      ...document,
      deletedAt: deleted ? Date.now() : undefined,
    }),
    false,
  );
}
export async function discardSecretDocument(
  userId: string,
  teamId: string,
  id: string,
) {
  if (readSecretCalendar(userId).entries.some((entry) => entry.id === id))
    return;
  await update(
    userId,
    teamId,
    id,
    (document) =>
      readSecretCalendar(userId).entries.some((entry) => entry.id === id)
        ? document
        : null,
    false,
    true,
  );
}
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
async function validateImage(file: File) {
  if (!file.size) throw new Error("붙여넣을 이미지가 없습니다.");
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error("이미지는 파일당 10MiB까지 붙여넣을 수 있습니다.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  let mime = "";
  if (ascii(1, 3) === "PNG" && bytes[0] === 137) {
    mime = "image/png";
    const view = new DataView(bytes.buffer);
    for (let at = 8; at + 12 <= bytes.length;) {
      if (ascii(at + 4, 4) === "acTL") mime = "";
      at += view.getUint32(at) + 12;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    mime = "image/jpeg";
  else if (
    ascii(0, 4) === "RIFF" &&
    ascii(8, 4) === "WEBP" &&
    !(ascii(12, 4) === "VP8X" && bytes[20] & 2)
  )
    mime = "image/webp";
  if (!mime) throw new Error("PNG·JPEG·WebP 정지 이미지만 지원합니다.");
  const blob = new Blob([bytes], { type: mime });
  const src = await dataUrl(blob);
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      image.naturalWidth * image.naturalHeight <= 40_000_000
        ? resolve()
        : reject(
            new Error("이미지는 최대 4천만 화소까지 붙여넣을 수 있습니다."),
          );
    image.onerror = () =>
      reject(
        new Error(
          "이미지를 읽을 수 없습니다. 정상적인 PNG·JPEG·WebP 파일을 붙여넣어 주세요.",
        ),
      );
    image.src = src;
  });
  return blob;
}
export function secretDocumentStorage(
  userId: string,
  teamId: string,
  id: string,
): DocumentStorage {
  const load = () => update(userId, teamId, id).then(snapshot);
  // One editor owns this cache, including concurrent views of the same URL.
  const sources = new Map<string, Promise<string>>();
  async function readImage(url: string) {
    getSecretEntry(userId, teamId, id);
    const db = await database(userId);
    const image = await new Promise<StoredImage | undefined>(
      (resolve, reject) => {
        const request = db.transaction("images").objectStore("images").get(url);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(failure(request.error));
      },
    );
    return image?.documentId === id
      ? dataUrl(new Blob([image.bytes], { type: image.mimeType }))
      : "";
  }
  return {
    load,
    async save(input) {
      if (documentBytes(input.markdown) > MAX_DOCUMENT_BYTES)
        throw new Error(
          "문서는 UTF-8 기준 256KiB까지 저장할 수 있습니다. 입력은 유지됩니다.",
        );
      const saved = await update(userId, teamId, id, (document) => {
        if (document.revision !== input.expectedRevision)
          throw new DocumentStorageConflict(snapshot(document));
        return {
          ...document,
          markdown: input.markdown,
          revision: Number(document.revision) + 1,
          updatedAt: new Date().toISOString(),
          // Retain recent uploads for editor undo and unsaved drafts in other tabs.
          images: document.images.map((image) => ({
            ...image,
            unusedSince: input.markdown.includes(image.url)
              ? undefined
              : (image.unusedSince ?? Date.now()),
          })),
        };
      });
      const expired = (image: ImageRecord) =>
        image.unusedSince !== undefined &&
        image.unusedSince <= Date.now() - 86400000;
      if (saved.images.some(expired)) {
        // Normal autosaves only touch metadata. Recheck the latest references
        // when removing expired metadata and bytes in a separate atomic cleanup.
        await update(
          userId,
          teamId,
          id,
          (document, transaction) => ({
            ...document,
            images: document.images.filter((image) => {
              if (!expired(image) || document.markdown.includes(image.url))
                return true;
              transaction.objectStore("images").delete(image.url);
              sources.delete(image.url);
              return false;
            }),
          }),
          true,
          true,
        );
      }
      return snapshot(saved);
    },
    subscribe(receive, onError) {
      let active = true;
      const unsubscribe = subscribeSecretDocuments(userId, (changedId) => {
        if (changedId === id)
          void load()
            .then((document) => {
              if (active) receive(document);
            })
            .catch((error) => {
              if (active) onError(error);
            });
      });
      return () => {
        active = false;
        unsubscribe();
        sources.clear();
      };
    },
    async uploadImage(file, signal) {
      const blob = await validateImage(file);
      // Store raw bytes: WebKit can reject Blob serialization in IndexedDB.
      const bytes = await blob.arrayBuffer();
      signal.throwIfAborted();
      const url = `secret-image:${crypto.randomUUID()}`;
      await update(
        userId,
        teamId,
        id,
        (document, transaction) => {
          signal.throwIfAborted();
          transaction.objectStore("images").put({
            url,
            documentId: id,
            bytes,
            mimeType: blob.type,
          } satisfies StoredImage);
          return {
            ...document,
            images: [
              ...document.images,
              {
                url,
                size: bytes.byteLength,
                mimeType: blob.type,
                createdAt: Date.now(),
                unusedSince: Date.now(),
              },
            ],
          };
        },
        true,
        true,
      );
      return url;
    },
    images: {
      accepts: (url) => !!imageSource(url),
      source: (url) => {
        const source = imageSource(url);
        if (!source) return "";
        let pending = sources.get(source);
        if (!pending) {
          pending = readImage(source)
            .then((value) => {
              if (!value && sources.get(source) === pending)
                sources.delete(source);
              return value;
            })
            .catch((error) => {
              if (sources.get(source) === pending) sources.delete(source);
              throw error;
            });
          sources.set(source, pending);
        }
        return pending;
      },
      width: (url) =>
        imageSource(url) ? Number(imagePattern.exec(url)?.[2]) || null : null,
      withWidth: (url, width) => {
        const source = imageSource(url);
        return !source
          ? ""
          : width === null
            ? source
            : `${source}#width=${Math.max(32, Math.min(4096, Math.round(width)))}`;
      },
    },
  };
}
