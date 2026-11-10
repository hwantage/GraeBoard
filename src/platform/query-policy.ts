import type { Site } from "./site";

type QueryFailure = { status?: number; retryAfterMs?: number };
type QueryPolicy = {
  pollMs: number;
  retryDelay: (failures: number, error: QueryFailure) => number;
};

const backoff = (failures: number) =>
  Math.min(5000 * 2 ** Math.min(Math.max(failures - 1, 0), 4), 60000);
const internal: QueryPolicy = {
  pollMs: 7000,
  retryDelay: (failures, error) =>
    error.status === 429
      ? Math.max(error.retryAfterMs || 0, backoff(failures))
      : 7000,
};
const external: QueryPolicy = {
  pollMs: 30000,
  retryDelay: (failures, error) =>
    Math.max(
      error.status === 429 ? error.retryAfterMs || 0 : 0,
      backoff(failures),
    ),
};

export const queryPolicyFor = (site: Site): QueryPolicy =>
  site.external ? external : internal;
