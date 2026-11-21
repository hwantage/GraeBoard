/**
 * GraeBoard's replacement for the editor's `platform/cloud-share`.
 *
 * Upstream posts a snapshot to its own origin without credentials and builds a
 * link at the site root. Inside GraeBoard the snapshot goes to GraeBoard's
 * expiring share store through the parent, and the link opens GraeBoard's
 * slides screen. A team file never travels to the public CanvaSlide service.
 */
import * as upstream from "graeboard-upstream:cloud-share";
import {
  canvasDocumentSchema,
  type CanvasDocument,
} from "@shared/canvas/element-types";
import { repairDocumentOrder } from "@shared/canvas/document-file";
import { orderedFrames } from "@shared/canvas/presentation-sequence";
import {
  hasAllowedShareVideos,
  hasOnlyEmbeddedImages,
} from "@shared/cloud-share/share-document";
import {
  CloudShareError,
  isShareAccess,
  isShareId,
  MAX_SHARE_BYTES,
  unwrapShareSnapshot,
  type CloudShareErrorCode,
  type ShareAccess,
  type SharedSnapshot,
} from "@shared/cloud-share/share-protocol";
import { hosted, requestHost } from "./slide-frame-host";

export * from "graeboard-upstream:cloud-share";

const CODES: readonly CloudShareErrorCode[] = [
  "invalid",
  "tooLarge",
  "quota",
  "missing",
  "unavailable",
  "network",
];

async function askHost<T>(
  action: string,
  payload: Record<string, unknown>,
): Promise<T> {
  try {
    return await requestHost<T>(action, payload);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new CloudShareError(
      CODES.find((known) => known === code) ?? "unavailable",
    );
  }
}

/** GraeBoard's share store is not the maintainers' hosted service, so its terms do not apply. */
export function usesHostedShareService(
  ...args: Parameters<typeof upstream.usesHostedShareService>
): boolean {
  return hosted ? false : upstream.usesHostedShareService(...args);
}

export async function createCloudShare(
  document: CanvasDocument,
  signal: AbortSignal,
  access: ShareAccess = "edit",
): Promise<string> {
  if (!hosted) {
    return upstream.createCloudShare(document, signal, access);
  }
  if (!isShareAccess(access) || !hasOnlyEmbeddedImages(document)) {
    throw new CloudShareError("invalid");
  }
  if (!hasAllowedShareVideos(document, upstream.cloudShareOrigin())) {
    throw new CloudShareError("unsupportedVideo");
  }
  if (access === "present" && orderedFrames(document).length === 0) {
    throw new CloudShareError("noFrames");
  }
  const body = JSON.stringify({ access, document });
  if (new TextEncoder().encode(body).byteLength > MAX_SHARE_BYTES) {
    throw new CloudShareError("tooLarge");
  }
  const result = await askHost<{ id: unknown; url: unknown }>("share-create", {
    body,
  });
  if (!isShareId(result.id) || typeof result.url !== "string") {
    throw new CloudShareError("invalid");
  }
  return result.url;
}

export async function fetchCloudShare(
  id: string,
  signal: AbortSignal,
): Promise<SharedSnapshot> {
  if (!hosted) {
    return upstream.fetchCloudShare(id, signal);
  }
  if (!isShareId(id)) {
    throw new CloudShareError("invalid");
  }
  const text = await askHost<string>("share-read", { id });
  let snapshot: ReturnType<typeof unwrapShareSnapshot>;
  try {
    snapshot = unwrapShareSnapshot(JSON.parse(text));
  } catch {
    throw new CloudShareError("invalid");
  }
  const parsed = canvasDocumentSchema.safeParse(snapshot.document);
  if (!parsed.success || !hasOnlyEmbeddedImages(parsed.data)) {
    throw new CloudShareError("invalid");
  }
  const document = repairDocumentOrder(parsed.data);
  if (!hasAllowedShareVideos(document, upstream.cloudShareOrigin())) {
    throw new CloudShareError("unsupportedVideo");
  }
  if (snapshot.access === "present" && orderedFrames(document).length === 0) {
    throw new CloudShareError("noFrames");
  }
  return { access: snapshot.access, document };
}
