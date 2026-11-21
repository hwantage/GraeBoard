import { api, send } from "../platform/api";

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

export const readSlideEditor = () =>
  api<{ editor: SlideEditorBuild | null }>("/slides/editor").then(
    (result) => result.editor,
  );
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
) =>
  api<SlideFile>(`${base(teamId)}/${fileId}/content`, {
    method: "PUT",
    body: bytes,
    headers: binary(null, requestId, baseRevision),
  });
export async function readSlideFile(teamId: string, fileId: string) {
  const response = await api<Response>(`${base(teamId)}/${fileId}/content`);
  return {
    revision: Number(response.headers.get("X-Slide-Revision")),
    title: decodeURIComponent(response.headers.get("X-Slide-Title") || ""),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}
export const renameSlideFile = (
  teamId: string,
  fileId: string,
  title: string,
) => send<SlideFile>(`${base(teamId)}/${fileId}`, { title }, "PATCH");
export const copySlideFile = (teamId: string, fileId: string, title: string) =>
  send<SlideFile>(`${base(teamId)}/${fileId}/copy`, {
    title,
    requestId: slideRequestId(),
  });
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
