import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GRAEBOARD_REPOSITORY,
  githubApi,
  planCanvaslideUpdate,
  updateBranch,
} from "../../scripts/canvaslide/update-canvaslide-pin.mjs";

const pinned = "a".repeat(40);
const newer = "b".repeat(40);
const pin = {
  repository: "https://github.com/hwantage/CanvaSlide.git",
  commit: pinned,
};
const plan = (github, repository = GRAEBOARD_REPOSITORY) =>
  planCanvaslideUpdate({
    pin,
    repository,
    github: {
      head: async () => newer,
      verified: async () => true,
      ahead: async () => true,
      proposed: async () => false,
      ...github,
    },
  });

test("원본의 새 검증 커밋이 있을 때만 갱신을 제안한다", async () => {
  assert.deepEqual(await plan(), {
    action: "update",
    commit: newer,
    branch: `canvaslide/update-${"b".repeat(12)}`,
  });
  assert.deepEqual(await plan({ head: async () => pinned }), {
    action: "none",
    reason: "up-to-date",
  });
  // Upstream's own checks are still running or failed: the pin stays.
  assert.equal(
    (await plan({ verified: async () => false })).reason,
    "upstream-checks-not-passed",
  );
  assert.equal(
    (await plan({ head: async () => undefined })).reason,
    "upstream-head-unreadable",
  );
});

test("늦게 끝난 실행이나 이미 제안한 커밋은 다시 제안하지 않고, Fork에서는 실행하지 않는다", async () => {
  // A run that read an older head after the pin already moved past it.
  assert.equal(
    (await plan({ ahead: async () => false })).reason,
    "not-ahead-of-pin",
  );
  const calls = [];
  const duplicate = await plan({
    proposed: async (branch) => {
      calls.push(branch);
      return true;
    },
  });
  assert.equal(duplicate.reason, "already-proposed");
  assert.deepEqual(calls, [updateBranch(newer)]);

  let asked = false;
  const fork = await plan(
    {
      head: async () => {
        asked = true;
        return newer;
      },
    },
    "somansadev/GraeBoard",
  );
  assert.deepEqual(fork, { action: "skip", reason: "not-original-repository" });
  assert.equal(asked, false, "a fork does not even read upstream");
});

test("GitHub 응답을 검증 통과·후손·중복 여부로 해석한다", async () => {
  const responses = {
    "/repos/hwantage/CanvaSlide/commits/main": { sha: newer },
    [`/repos/hwantage/CanvaSlide/commits/${newer}/check-runs?per_page=100`]: {
      check_runs: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ],
    },
    [`/repos/hwantage/CanvaSlide/compare/${pinned}...${newer}`]: {
      status: "ahead",
    },
    [`/repos/hwantage/GraeBoard/pulls?state=all&head=hwantage:${encodeURIComponent(updateBranch(newer))}`]:
      [],
  };
  const requested = [];
  const api = (overrides = {}) =>
    githubApi({
      upstream: "hwantage/CanvaSlide",
      repository: GRAEBOARD_REPOSITORY,
      token: "token",
      fetcher: async (url, init) => {
        const path = url.replace("https://api.github.com", "");
        requested.push(path);
        assert.equal(init.headers.Authorization, "Bearer token");
        const body = { ...responses, ...overrides }[path];
        return body === undefined
          ? new Response("{}", { status: 404 })
          : Response.json(body);
      },
    });
  assert.equal(await api().head(), newer);
  assert.equal(await api().verified(newer), true);
  assert.equal(await api().ahead(pinned, newer), true);
  assert.equal(await api().proposed(updateBranch(newer)), false);
  const checks = `/repos/hwantage/CanvaSlide/commits/${newer}/check-runs?per_page=100`;
  for (const runs of [
    [],
    [{ status: "in_progress", conclusion: null }],
    [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ],
  ])
    assert.equal(
      await api({ [checks]: { check_runs: runs } }).verified(newer),
      false,
    );
  assert.equal(
    await api({
      [`/repos/hwantage/CanvaSlide/compare/${pinned}...${newer}`]: {
        status: "diverged",
      },
    }).ahead(pinned, newer),
    false,
  );
  // A closed proposal counts. A branch on its own must be retried.
  const pulls = Object.keys(responses).at(-1);
  assert.equal(
    await api({ [pulls]: [{ state: "closed" }] }).proposed(updateBranch(newer)),
    true,
  );
  assert.equal(
    await api({
      [`/repos/hwantage/GraeBoard/branches/${encodeURIComponent(updateBranch(newer))}`]:
        { name: "x" },
    }).proposed(updateBranch(newer)),
    false,
  );
});

test("갱신 workflow는 원본 저장소에서만, 검사 통과 뒤에만 보관·PR 단계로 간다", () => {
  const workflow = readFileSync(
    fileURLToPath(
      new URL(
        "../../.github/workflows/canvaslide-editor-update.yml",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(workflow, /if: github\.repository == 'hwantage\/GraeBoard'/);
  const order = [
    "갱신할 커밋 확인",
    "편집기 조립과 배포본 묶기",
    "호환성 검사",
    "배포본 보관",
    "버전 갱신 PR",
  ].map((name) => workflow.indexOf(`name: ${name}`));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  // Every step after the plan runs only for an update, so a failed check
  // (the job stops) or "nothing to do" never publishes anything.
  assert.equal(
    workflow.split("if: steps.plan.outputs.action == 'update'").length - 1,
    6,
  );
  assert.doesNotMatch(workflow, /pull_request_target|secrets\./);
  assert.match(workflow, /cancel-in-progress: false/);
});
