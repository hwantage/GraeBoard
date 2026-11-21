import { api } from "../platform/api";
import {
  SLIDE_EDITOR_BUILD_ID,
  SLIDE_EDITOR_CURRENT,
  SLIDE_EDITOR_PATH,
} from "../../shared/slides/slide-editor-policy.js";

export type SlideFile = {
  id: string;
  teamId: string;
  title: string;
  revision: number;
  byteLength: number;
  contentHash: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};
export type SlideFileList = {
  files: SlideFile[];
  canWrite: boolean;
};
export type SlideEditorBuild = {
  buildId: string;
  path: string;
  upstream?: { commit: string; version?: string };
};

const base = (teamId: string) => `/teams/${teamId}/slides`;
const binary = (
  title: string | null,
  requestId: string,
  revision?: number,
) => ({
  "Content-Type": "application/octet-stream",
  "X-Slide-Request-Id": requestId,
  ...(title === null ? {} : { "X-Slide-Title": encodeURIComponent(title) }),
  ...(revision === undefined
    ? {}
    : { "X-Slide-Base-Revision": String(revision) }),
});

export const slideRequestId = () => crypto.randomUUID();

// The editor is a static build both sites serve; this file names the current one.
export async function readSlideEditor(): Promise<SlideEditorBuild | null> {
  const response = await fetch(SLIDE_EDITOR_CURRENT, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) return null;
  const current = await response.json().catch(() => null);
  return typeof current?.buildId === "string" &&
    SLIDE_EDITOR_BUILD_ID.test(current.buildId)
    ? {
        buildId: current.buildId,
        path: `${SLIDE_EDITOR_PATH}/${current.buildId}/`,
        upstream: current.upstream,
      }
    : null;
}
export const listSlideFiles = (teamId: string, signal?: AbortSignal) =>
  api<SlideFileList>(base(teamId), { signal });
export const createSlideFile = (
  teamId: string,
  title: string,
  bytes: Uint8Array<ArrayBuffer>,
  requestId: string,
) =>
  api<SlideFile>(base(teamId), {
    method: "POST",
    body: bytes,
    headers: binary(title, requestId),
  });
export const saveSlideFile = (
  teamId: string,
  fileId: string,
  baseRevision: number,
  bytes: Uint8Array<ArrayBuffer>,
  requestId: string,
  rename?: { title: string; baseTitle: string },
) =>
  api<SlideFile>(`${base(teamId)}/${fileId}/content`, {
    method: "PUT",
    body: bytes,
    headers: {
      ...binary(rename?.title ?? null, requestId, baseRevision),
      ...(rename && {
        "X-Slide-Base-Title": encodeURIComponent(rename.baseTitle),
      }),
    },
  });
export async function readSlideFile(
  teamId: string,
  fileId: string,
  signal?: AbortSignal,
) {
  const response = await api<Response>(`${base(teamId)}/${fileId}/content`, {
    signal,
  });
  return {
    hash: response.headers.get("X-Slide-Content-Sha256"),
    revision: Number(response.headers.get("X-Slide-Revision")),
    title: decodeURIComponent(response.headers.get("X-Slide-Title") || ""),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}
export const deleteSlideFile = (teamId: string, fileId: string) =>
  api(`${base(teamId)}/${fileId}`, { method: "DELETE" });
export const createSlideShare = (teamId: string, body: string) =>
  api<{ id: string }>(`/teams/${teamId}/slide-shares`, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain" },
  });
export const readSlideShare = (teamId: string, id: string) =>
  api<{ body: string }>(`/teams/${teamId}/slide-shares/${id}`).then(
    (result) => result.body,
  );
