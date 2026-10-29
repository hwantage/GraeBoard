import { stringify, unpack } from "../shared/compact.js";
import { apiErrorMessage, retryAfterMs } from "../shared/api-error-message.js";
import { siteFor } from "./site";

// Distinguish this page from other tabs, including tabs signed in as the same user.
export const clientId = crypto.randomUUID();

export class ApiError extends Error {
  status: number;
  details: any;
  retryAfterMs: number;
  constructor(
    message: string,
    status: number,
    details?: unknown,
    retryAfter = 0,
  ) {
    super(message);
    this.status = status;
    this.details = details;
    this.retryAfterMs = retryAfter;
  }
}
const taskResponses = new Map<string, { etag: string; data: unknown }>();
let site = siteFor(null);
const pulls = new Map<string, Promise<void>>();
const lastPull = new Map<string, number>();
export async function refreshExternalTeam(teamId: string, configured: boolean) {
  if (!site.external || !teamId || !configured) return;
  const running = pulls.get(teamId);
  if (running) return running;
  if (Date.now() - (lastPull.get(teamId) || 0) < 1500) return;
  lastPull.set(teamId, Date.now());
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
  // The external API pulls before reads/edits in worker/entry.mjs. Sending a
  // separate browser preflight duplicates that work and doubles write calls.
  const multipart = options.body instanceof FormData;
  const cacheable =
    path.startsWith("/tasks?") && (!options.method || options.method === "GET");
  const cached = cacheable ? taskResponses.get(path) : undefined;
  if (path.startsWith("/auth/")) taskResponses.clear();
  let response: Response;
  try {
    response = await fetch("/api" + path, {
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
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === "AbortError")
      throw error;
    throw new ApiError(
      apiErrorMessage({
        path,
        method: options.method,
        status: 0,
        external: site.external,
      }),
      0,
    );
  }
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
    let invalidResponse = false;
    try {
      data = unpack(await response.json());
    } catch {
      invalidResponse = true;
    }
    throw new ApiError(
      apiErrorMessage({
        path,
        method: options.method,
        status: response.status,
        data,
        headers: response.headers,
        invalidResponse,
        external: site.external,
      }),
      response.status,
      data?.details,
      retryAfterMs(response.headers),
    );
  }
  if (response.headers.get("content-disposition")) return response as T;
  let data: any;
  try {
    data = unpack(await response.json());
  } catch (error) {
    if (options.signal?.aborted || (error as Error).name === "AbortError")
      throw error;
    throw new ApiError(
      apiErrorMessage({
        path,
        method: options.method,
        status: response.status,
        headers: response.headers,
        invalidResponse: true,
        external: site.external,
      }),
      response.status,
    );
  }
  if (["/bootstrap", "/setup"].includes(path)) {
    site = siteFor(data);
  }
  if (
    options.method &&
    !["GET", "HEAD"].includes(options.method) &&
    !path.includes("/sync/") &&
    !path.startsWith("/auth/") &&
    !path.startsWith("/admin/") &&
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
  if (site.external && result.logoutUrl === "/cdn-cgi/access/logout") {
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
