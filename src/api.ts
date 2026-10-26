import { stringify, unpack } from "../shared/compact.js";

// Distinguish this page from other tabs, including tabs signed in as the same user.
export const clientId = crypto.randomUUID();

export class ApiError extends Error {
  status: number;
  details: any;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const taskResponses = new Map<string, { etag: string; data: unknown }>();
let externalSite = false;
let activeSyncTeam = "";
const pulls = new Map<string, Promise<void>>();
const lastPull = new Map<string, number>();
export const isExternalSite = () => externalSite;
export const setActiveSyncTeam = (teamId: string) => {
  activeSyncTeam = teamId;
};
export async function refreshExternalTeam(
  teamId = activeSyncTeam,
  force = false,
) {
  if (!externalSite || !teamId) return;
  const running = pulls.get(teamId);
  if (running) return running;
  if (!force && Date.now() - (lastPull.get(teamId) || 0) < 1500) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const work = api(`/teams/${teamId}/sync/refresh`, {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  })
    .then(() => {
      lastPull.set(teamId, Date.now());
    })
    .finally(() => {
      clearTimeout(timer);
      pulls.delete(teamId);
    });
  pulls.set(teamId, work);
  return work;
}
// Every shifted twelve-month window in a year shares the same two-year data.
export const taskQuery = (teamId: string, year: number, startMonth = 1) =>
  `/tasks?teamId=${teamId}&year=${year}${startMonth > 1 ? "&startMonth=2" : ""}`;
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  // Refresh immediately before external edits. A Git outage must not discard
  // local input; the normal revision/optimistic conflict check remains decisive.
  if (
    externalSite &&
    options.method &&
    !["GET", "HEAD"].includes(options.method) &&
    !/^\/(auth|admin|events)(\/|$)/.test(path) &&
    !path.includes("/sync/")
  ) {
    await refreshExternalTeam().catch(() => {});
  }
  const multipart = options.body instanceof FormData;
  const cacheable =
    path.startsWith("/tasks?") && (!options.method || options.method === "GET");
  const cached = cacheable ? taskResponses.get(path) : undefined;
  if (path.startsWith("/auth/")) taskResponses.clear();
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(!multipart && options.body
        ? { "Content-Type": "application/json" }
        : {}),
      "X-Requested-With": "WeeklyPlan",
      "X-Client-ID": clientId,
      ...(cached ? { "If-None-Match": cached.etag } : {}),
      ...options.headers,
    },
  });
  const withCursor = (data: unknown) =>
    cacheable
      ? {
          ...(data as object),
          cellEventId: response.headers.get("X-Cell-Event-ID"),
        }
      : data;
  if (response.status === 304 && cached) return withCursor(cached.data) as T;
  if (!response.ok) {
    if (cacheable && [403, 404].includes(response.status))
      taskResponses.delete(path);
    let data: any;
    try {
      data = unpack(await response.json());
    } catch {
      data = { error: "서버에 연결할 수 없습니다." };
    }
    throw new ApiError(
      data.error || "요청을 처리할 수 없습니다.",
      response.status,
      data.details,
    );
  }
  if (response.headers.get("content-disposition")) return response as T;
  const data = unpack(await response.json());
  if (["/bootstrap", "/setup"].includes(path))
    externalSite = data.authMode === "access";
  if (
    options.method &&
    !["GET", "HEAD"].includes(options.method) &&
    !path.includes("/sync/") &&
    typeof window !== "undefined"
  )
    window.dispatchEvent(new Event("graeboard:local-save"));
  if (options.method === "DELETE" && path.startsWith("/admin/teams/")) {
    const deletedTeamId = path.split("/").at(-1);
    for (const key of taskResponses.keys())
      if (
        new URLSearchParams(key.split("?")[1]).get("teamId") === deletedTeamId
      )
        taskResponses.delete(key);
  }
  if (cacheable && response.headers.has("etag")) {
    if (taskResponses.size >= 2 && !taskResponses.has(path))
      taskResponses.delete(taskResponses.keys().next().value!);
    taskResponses.set(path, { etag: response.headers.get("etag")!, data });
  }
  return withCursor(data) as T;
}
export const send = <T = any>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, body: stringify(body) });
export async function logout() {
  const result = await send<{ logoutUrl?: string }>("/auth/logout", {});
  if (externalSite && result.logoutUrl === "/cdn-cgi/access/logout") {
    location.assign(result.logoutUrl);
    return false;
  }
  return true;
}
export async function download(path: string, body: unknown) {
  const res = await send<Response>(path, body);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    res.headers.get("content-disposition")?.match(/filename="?([^";]+)/)?.[1] ||
    "graeboard";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
