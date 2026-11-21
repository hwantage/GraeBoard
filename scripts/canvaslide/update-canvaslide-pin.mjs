// Decides whether GraeBoard should move its pinned CanvaSlide commit, and
// applies that to canvaslide-upstream.json. Run by the scheduled workflow of
// the original GraeBoard repository; CanvaSlide sends nothing and is not
// changed.
//
//   node scripts/canvaslide/update-canvaslide-pin.mjs           plan (JSON)
//   node scripts/canvaslide/update-canvaslide-pin.mjs --apply   write the pin
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graeboardRoot, readPin } from "./canvaslide-build-identity.mjs";

export const GRAEBOARD_REPOSITORY = "hwantage/GraeBoard";
export const updateBranch = (commit) =>
  `canvaslide/update-${commit.slice(0, 12)}`;
const upstreamName = (pin) =>
  /github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(pin.repository)?.[1];

// `github` answers four questions; the workflow uses the GitHub API and the
// tests a fake:
//   head()               newest commit of upstream main
//   verified(commit)     upstream's own checks finished and passed
//   ahead(base, commit)  commit is a descendant of base
//   proposed(branch)     an update for this commit was already proposed
export async function planCanvaslideUpdate({ pin, repository, github }) {
  // Forks deploy what the original repository verified; they never propose.
  if (repository !== GRAEBOARD_REPOSITORY)
    return { action: "skip", reason: "not-original-repository" };
  const commit = await github.head();
  if (!/^[0-9a-f]{40}$/.test(commit || ""))
    return { action: "skip", reason: "upstream-head-unreadable" };
  if (commit === pin.commit) return { action: "none", reason: "up-to-date" };
  // A slow or repeated run must not move the pin backwards or sideways.
  if (!(await github.ahead(pin.commit, commit)))
    return { action: "skip", reason: "not-ahead-of-pin", commit };
  if (!(await github.verified(commit)))
    return { action: "skip", reason: "upstream-checks-not-passed", commit };
  const branch = updateBranch(commit);
  if (await github.proposed(branch))
    return { action: "skip", reason: "already-proposed", commit, branch };
  return { action: "update", commit, branch };
}

export function githubApi({ upstream, repository, token, fetcher = fetch }) {
  const call = async (path) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status}`);
    return response.json();
  };
  return {
    head: async () => (await call(`/repos/${upstream}/commits/main`))?.sha,
    async verified(commit) {
      const checks = await call(
        `/repos/${upstream}/commits/${commit}/check-runs?per_page=100`,
      );
      const runs = checks?.check_runs || [];
      return (
        runs.length > 0 &&
        runs.every(
          (run) =>
            run.status === "completed" &&
            ["success", "neutral", "skipped"].includes(run.conclusion),
        )
      );
    },
    ahead: async (base, commit) =>
      (await call(`/repos/${upstream}/compare/${base}...${commit}`))?.status ===
      "ahead",
    async proposed(branch) {
      const owner = repository.split("/")[0];
      const pulls = await call(
        `/repos/${repository}/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}`,
      );
      return (
        (pulls || []).length > 0 ||
        !!(await call(
          `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
        ))
      );
    },
    version: async (commit) =>
      (await call(`/repos/${upstream}/contents/package.json?ref=${commit}`))
        ?.content,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pinPath = join(
    graeboardRoot,
    "scripts/canvaslide/canvaslide-upstream.json",
  );
  const pin = readPin(pinPath);
  const github = githubApi({
    upstream: upstreamName(pin),
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  });
  const plan = await planCanvaslideUpdate({
    pin,
    repository: process.env.GITHUB_REPOSITORY,
    github,
  });
  if (plan.action === "update" && process.argv.includes("--apply")) {
    const encoded = await github.version(plan.commit);
    const version = encoded
      ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).version
      : pin.version;
    // The kept bundle is recorded after this commit is assembled and checked.
    const { bundle: _previous, ...rest } = pin;
    writeFileSync(
      pinPath,
      JSON.stringify({ ...rest, commit: plan.commit, version }, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify(plan));
}
