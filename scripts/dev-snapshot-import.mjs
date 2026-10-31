// One-time read-only snapshot import: replays an existing GraeBoard data
// repository's sync-v1 history into a local SQLite DB, without ever creating
// a team_sync_links row or touching GRAEBOARD_SYNC_PROFILES. This file must
// never call GitCliTransport#createCandidate/#publish; it only reads.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GitCliTransport, repositoryUrl } from "../server/sync/git-cli.mjs";
import { decodeSnapshot } from "../server/sync/snapshot.mjs";
import { digest, stateHash } from "../server/sync/protocol.mjs";
import { reduceMany, validateSnapshot } from "../server/sync/reducer.mjs";
import { materialize } from "../server/sync/entities.mjs";
import {
  openDatabase,
  transaction,
  id,
  now,
  json,
  passwordHash,
  addMembership,
} from "../server/db.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { syncImageReferences } from "../shared/sync-image-references.js";
import {
  documentImagesDirectory,
  writeDocumentImage,
} from "../server/document-images.mjs";

const decodeJson = (bytes, limit = 64 * 1024 * 1024) => {
  if (!bytes || bytes.byteLength > limit)
    throw new Error("JSON 파일이 너무 큽니다.");
  return JSON.parse(new TextDecoder().decode(bytes));
};

export async function readRemoteState(
  { repository, token, branch = "sync-v1", cloneDir },
  { log = console.log } = {},
) {
  const transport = new GitCliTransport({
    directory: cloneDir,
    repository,
    token,
  });
  const head = await transport.readHead(branch);
  if (!head)
    throw new Error(
      `저장소의 ${branch} 브랜치가 비어 있습니다 (최초 게시 전).`,
    );
  log(`head=${head} 확인, 전체 히스토리를 가져옵니다...`);
  const chain = await transport.readRange(head, null, Number.MAX_SAFE_INTEGER);
  if (!chain.length) throw new Error("동기화 히스토리를 읽지 못했습니다.");
  log(`커밋 ${chain.length}개 발견, 반영을 시작합니다.`);

  let state, identity;
  for (let i = 0; i < chain.length; i++) {
    const commit = chain[i];
    const manifest = decodeJson(
      await transport.readFile(commit.oid, "manifest.json"),
    );
    if (!identity)
      identity = { teamId: manifest.teamId, repoId: manifest.repoId };
    if (
      manifest.teamId !== identity.teamId ||
      manifest.repoId !== identity.repoId
    )
      throw new Error(`저장소 신원이 일치하지 않습니다 (커밋 ${commit.oid}).`);
    if (manifest.protocol !== 1 || manifest.reducer !== 1)
      throw new Error(
        `지원하지 않는 프로토콜/리듀서 버전입니다 (커밋 ${commit.oid}).`,
      );

    if (i === 0) {
      if (commit.parents.length)
        throw new Error("genesis 커밋에 parent가 있습니다.");
      const bytes = await transport.readFile(commit.oid, manifest.genesis);
      if (digest(bytes) !== manifest.genesisHash)
        throw new Error("genesis 파일 체크섬이 일치하지 않습니다.");
      const bundle = decodeSnapshot(bytes);
      state = validateSnapshot(bundle.state, identity);
      if (stateHash(state) !== bundle.hash)
        throw new Error("genesis 상태 체크섬이 일치하지 않습니다.");
    } else {
      const previous = chain[i - 1];
      if (commit.parents.length !== 1 || commit.parents[0] !== previous.oid)
        throw new Error(
          `동기화 히스토리가 선형이 아닙니다 (커밋 ${commit.oid}).`,
        );
      const previousPaths = new Set(previous.files.map((f) => f.path));
      const added = commit.files.filter((f) => !previousPaths.has(f.path));
      const eventFiles = added.filter((f) => f.path.startsWith("events/"));
      if (eventFiles.length !== 1)
        throw new Error(
          `이벤트 파일이 정확히 1개가 아닙니다 (커밋 ${commit.oid}).`,
        );
      const envelope = decodeJson(
        await transport.readFile(commit.oid, eventFiles[0].path),
        64 * 1024 * 1024,
      );
      if (envelope.kind === "operations") {
        state = reduceMany(state, envelope.operations, identity, {
          persistentReceipts: true,
        });
        if (stateHash(state) !== envelope.resultHash)
          throw new Error(
            `리듀서 결과 체크섬이 일치하지 않습니다 (커밋 ${commit.oid}).`,
          );
      } else if (envelope.kind === "checkpoint") {
        // 상태를 바꾸지 않는 북마크 커밋. 이미 반영된 상태를 그대로 유지한다.
      } else if (envelope.kind === "transition") {
        const bytes = await transport.readFile(commit.oid, envelope.path);
        if (digest(bytes) !== envelope.snapshotHash)
          throw new Error(
            `프로토콜 전환 체크섬이 일치하지 않습니다 (커밋 ${commit.oid}).`,
          );
        const bundle = decodeSnapshot(bytes);
        state = validateSnapshot(bundle.state, identity);
        if (stateHash(state) !== envelope.resultHash)
          throw new Error(
            `프로토콜 전환 결과 체크섬이 일치하지 않습니다 (커밋 ${commit.oid}).`,
          );
      } else {
        throw new Error(`알 수 없는 이벤트 종류입니다: ${envelope.kind}`);
      }
    }
    if ((i + 1) % 200 === 0 || i === chain.length - 1)
      log(`  ${i + 1}/${chain.length} 커밋 반영 완료`);
  }
  return { state, identity, head, transport, commitCount: chain.length };
}

async function installImages(
  { transport, state, teamId, head, documentImagesDir },
  { log = console.log } = {},
) {
  const urls = syncImageReferences(state);
  log(`참조된 이미지 ${urls.length}개 확인, 설치를 시작합니다.`);
  let installed = 0,
    skipped = 0;
  for (const url of urls) {
    if (!url.startsWith(`/api/document-images/${teamId}/`)) {
      skipped++;
      continue;
    }
    const path = url.replace("/api/document-images/", "images/");
    const expectedHash = path
      .split("/")
      .at(-1)
      .replace(/\.webp$/, "");
    let bytes;
    try {
      bytes = await transport.readFile(head, path);
    } catch {
      bytes = null;
    }
    if (!bytes || digest(bytes) !== expectedHash) {
      skipped++;
      continue;
    }
    writeDocumentImage(documentImagesDir, url, bytes);
    installed++;
  }
  log(`이미지 ${installed}개 설치, ${skipped}개 건너뜀.`);
  return { installed, skipped };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      repository: { type: "string", default: "hwantage/GraeBoardData" },
      branch: { type: "string", default: "sync-v1" },
      token: { type: "string" },
      "clone-dir": { type: "string" },
      "keep-clone": { type: "boolean" },
      "skip-images": { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      "admin-username": { type: "string" },
      "admin-name": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm run dev:snapshot-import -- [--repository owner/repo] [--token PAT] [--dry-run]\n" +
        "  [--admin-username id@example.com --admin-name '이름'] [--skip-images] [--force] [--keep-clone]\n" +
        "읽기 전용 PAT(Contents: Read-only, 해당 저장소 한정)만 사용하세요.\n" +
        "--admin-username을 지정하면 비밀번호를 표준입력으로 전달해 로그인 계정을 함께 만듭니다.",
    );
    return;
  }
  const token = values.token || process.env.GRAEBOARD_SNAPSHOT_TOKEN;
  if (!token)
    throw new Error(
      "--token 또는 GRAEBOARD_SNAPSHOT_TOKEN 환경 변수로 읽기 전용 GitHub PAT을 전달하세요.",
    );
  repositoryUrl(values.repository);
  const cloneDir =
    values["clone-dir"] ||
    join(tmpdir(), "graeboard-dev-snapshot-import-" + randomUUID());

  let adminPassword = null;
  if (values["admin-username"] && !values["dry-run"]) {
    adminPassword = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    if (adminPassword.length < 10 || adminPassword.length > 128)
      throw new Error("관리자 비밀번호는 10~128자여야 합니다.");
  }

  try {
    const { state, identity, head, transport, commitCount } =
      await readRemoteState(
        {
          repository: values.repository,
          token,
          branch: values.branch,
          cloneDir,
        },
        { log: console.log },
      );
    const entityCount = Object.keys(state.entities).length;
    console.log(
      JSON.stringify({
        teamId: identity.teamId,
        repoId: identity.repoId,
        head,
        commits: commitCount,
        entities: entityCount,
        dryRun: !!values["dry-run"],
      }),
    );
    if (values["dry-run"]) {
      console.log("dry-run이므로 로컬 DB·이미지 폴더는 변경하지 않았습니다.");
      return;
    }

    const documentImagesDir = documentImagesDirectory();
    let imageResult = { installed: 0, skipped: 0 };
    if (!values["skip-images"])
      imageResult = await installImages(
        { transport, state, teamId: identity.teamId, head, documentImagesDir },
        { log: console.log },
      );

    const db = openDatabase();
    try {
      const existing = db
        .prepare("SELECT 1 FROM teams WHERE id=?")
        .get(identity.teamId);
      if (existing && !values.force)
        throw new Error(
          `이미 이 팀 ID(${identity.teamId})로 가져온 데이터가 있습니다. 로컬 DB를 초기화하거나 --force를 사용하세요.`,
        );
      let adminUserId = null;
      transaction(db, () => {
        if (!existing)
          db.prepare("INSERT INTO teams(id,name,settings) VALUES(?,?,?)").run(
            identity.teamId,
            "(가져오는 중)",
            json(DEFAULT_SETTINGS),
          );
        materialize(db, identity.teamId, state.entities, {}, {});
        if (values["admin-username"]) {
          if (
            db
              .prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE")
              .get(values["admin-username"])
          )
            throw new Error(
              `이미 존재하는 아이디입니다: ${values["admin-username"]}`,
            );
          adminUserId = id();
          db.prepare(
            "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
          ).run(
            adminUserId,
            values["admin-username"],
            values["admin-name"] || values["admin-username"],
            passwordHash(adminPassword),
            "admin",
            now(),
          );
          addMembership(db, adminUserId, identity.teamId, "lead");
        }
      });
      console.log(
        JSON.stringify({
          imported: true,
          teamId: identity.teamId,
          dbPath: process.env.DB_PATH || "data/weekly-plan.sqlite",
          documentImagesDir,
          images: imageResult,
          adminUserId,
        }),
      );
    } finally {
      db.close();
    }
  } finally {
    if (!values["keep-clone"])
      await rm(cloneDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
