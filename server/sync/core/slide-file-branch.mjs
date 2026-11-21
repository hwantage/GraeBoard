import { canonical, digest } from "./protocol.mjs";

// Team slide files travel between the internal and the external site on a
// branch of their own in the team's data repository. It is not an input of the
// task reducer: `sync-v1`, its protocol number, hashes and cursors are not
// involved, and a site that predates slides never reads this branch.
//
//   slides.json                 { format, teamId }
//   files/<file id>.json        metadata of one file (canonical JSON)
//   chunks/<SHA-256 of chunk>   the file's bytes in fixed 4 MiB pieces
//
// A chunk is named by the SHA-256 of its content, which is what receivers
// verify. Git's own object IDs are used only to notice that a metadata file
// changed.
export const SLIDE_BRANCH = "sync-slides-v1";
export const SLIDE_BRANCH_FORMAT = 1;
export const SLIDE_CHUNK_BYTES = 4 * 1024 * 1024;
export const SLIDE_SYNC_MAX_BYTES = 25 * 1024 * 1024;

const META_PATH =
  /^files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
export const slideMetaPath = (id) => `files/${id}.json`;
export const slideChunkPath = (hash) => `chunks/${hash}`;
const text = (bytes) =>
  typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);

export function slideChunks(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SLIDE_CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + SLIDE_CHUNK_BYTES);
    chunks.push({ hash: digest(part), bytes: part });
  }
  return chunks;
}
// The file a site keeps its own unpublished content in when the other site's
// version was published first. The ID follows from the file, the content and
// the site, so seeing the same conflict again creates nothing new.
export function slideConflictCopyId(fileId, contentHash, site) {
  const hex = digest(`slide-conflict:${fileId}:${contentHash}:${site}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const conflictTitle = (title, site) =>
  `${title} (충돌 · ${site === "internal" ? "사내" : "외부"})`.slice(0, 120);

function decodeMeta(bytes, id) {
  const meta = JSON.parse(text(bytes));
  const valid =
    meta &&
    meta.id === id &&
    typeof meta.title === "string" &&
    meta.title.length > 0 &&
    meta.title.length <= 120 &&
    /^[a-f0-9]{64}$/.test(meta.contentHash) &&
    Number.isSafeInteger(meta.byteLength) &&
    meta.byteLength > 0 &&
    meta.byteLength <= SLIDE_SYNC_MAX_BYTES &&
    Array.isArray(meta.chunks) &&
    meta.chunks.length === Math.ceil(meta.byteLength / SLIDE_CHUNK_BYTES) &&
    meta.chunks.every((hash) => /^[a-f0-9]{64}$/.test(hash)) &&
    typeof meta.version === "string" &&
    /^[0-9a-f-]{36}:\d+$/.test(meta.version) &&
    (meta.base === null || typeof meta.base === "string") &&
    typeof meta.updatedAt === "string" &&
    typeof meta.updatedBy?.id === "string" &&
    (meta.deletedAt === null || typeof meta.deletedAt === "string");
  if (!valid) throw new Error("Invalid slide file metadata on the sync branch");
  return meta;
}
// Local state differs from what the two sites last agreed on.
export function slideFileDirty(file) {
  if (file.missing) return false;
  if (!file.shared) return !file.deletedAt;
  return (
    file.contentHash !== file.shared.hash ||
    file.title !== file.shared.title ||
    !!file.deletedAt !== !!file.shared.deletedAt
  );
}
const snapshotKey = (file) =>
  digest(
    canonical({
      hash: file.contentHash,
      title: file.title,
      deleted: !!file.deletedAt,
      base: file.shared?.version ?? null,
    }),
  );

// One pass: receive what the branch has, then publish local changes from the
// fully applied head. Safe to repeat at any point; every step is idempotent.
//   transport  readHead, readCommit, readFile, createCandidate, publish
//   store      the site's slide store (sync* methods)
//   limits     chunks moved per pass (each direction), files published per pass
export async function syncSlideFiles({
  transport,
  store,
  teamId,
  site,
  limits = { chunks: 64, files: 50 },
  warn = () => {},
}) {
  const state = await store.syncState(teamId);
  const head = (await transport.readHead(SLIDE_BRANCH)) || null;
  const result = {
    head,
    received: 0,
    published: 0,
    conflicts: 0,
    pending: 0,
    raced: false,
  };
  const tree = new Map();
  if (head) {
    for (const file of (await transport.readCommit(head)).files)
      tree.set(file.path, file.oid);
    const manifest = JSON.parse(
      text(await transport.readFile(head, "slides.json")),
    );
    if (manifest.format !== SLIDE_BRANCH_FORMAT || manifest.teamId !== teamId)
      throw new Error("Slide sync branch belongs to another team or format");
  }

  let download = limits.chunks;
  // The whole content, or null when this pass may not fetch all of it yet.
  // Fetched chunks are kept, so the next pass continues where this one ended.
  async function content(meta) {
    const parts = [];
    let complete = true;
    for (const hash of meta.chunks) {
      let bytes = await store.syncStaged(teamId, hash);
      if (!bytes) {
        if (download <= 0) {
          complete = false;
          continue;
        }
        if (!tree.has(slideChunkPath(hash)))
          throw new Error("Slide chunk is missing from the sync branch");
        bytes = new Uint8Array(
          await transport.readFile(head, slideChunkPath(hash)),
        );
        if (digest(bytes) !== hash)
          throw new Error("Slide chunk does not match its SHA-256");
        await store.syncStage(teamId, hash, bytes);
        download--;
      }
      if (complete) parts.push(bytes);
    }
    if (!complete) return null;
    const whole = new Uint8Array(meta.byteLength);
    let offset = 0;
    for (const part of parts) {
      if (offset + part.byteLength > whole.byteLength)
        throw new Error("Slide chunks exceed the recorded length");
      whole.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== meta.byteLength || digest(whole) !== meta.contentHash)
      throw new Error("Slide file does not match its recorded SHA-256");
    return whole;
  }
  async function receive(meta, metaOid, mine) {
    const shared = mine?.shared || null;
    const record = { meta, metaOid };
    // Our own publication, whose answer was lost.
    if (
      mine?.pendingVersion === meta.version ||
      shared?.version === meta.version
    ) {
      await store.syncMarkShared(teamId, meta.id, sharedOf(meta, metaOid));
      return true;
    }
    const dirty = !!mine && slideFileDirty(mine);
    const localContent = dirty && mine.contentHash !== (shared?.hash ?? null);
    const localTitle = dirty && mine.title !== (shared?.title ?? null);
    const localDeleted = dirty && !!mine.deletedAt && !shared?.deletedAt;
    const needs = (hash) => !mine || mine.missing || mine.contentHash !== hash;

    if (!dirty) {
      // Nothing unpublished here: the branch's version is ours now.
      const bytes =
        !meta.deletedAt && needs(meta.contentHash) ? await content(meta) : null;
      if (!meta.deletedAt && needs(meta.contentHash) && !bytes) return false;
      await store.syncApply(teamId, {
        ...record,
        bytes,
        take: { content: !meta.deletedAt, title: true, deleted: true },
      });
      await store.syncUnstage(teamId, meta.chunks);
      return true;
    }
    if (meta.deletedAt) {
      // Deleted there, changed here: the change wins and restores the file
      // with the next publication. Deleted on both sides: agreed.
      await store.syncApply(teamId, {
        ...record,
        bytes: null,
        take: {
          content: false,
          title: false,
          deleted: localDeleted && !localContent,
        },
      });
      return true;
    }
    if (localDeleted && !localContent) {
      // Deleted here, changed there: the change wins and the file comes back.
      const bytes = needs(meta.contentHash) ? await content(meta) : null;
      if (needs(meta.contentHash) && !bytes) return false;
      await store.syncApply(teamId, {
        ...record,
        bytes,
        take: { content: true, title: true, deleted: true },
      });
      await store.syncUnstage(teamId, meta.chunks);
      return true;
    }
    const remoteContent = meta.contentHash !== (shared?.hash ?? null);
    if (
      localContent &&
      remoteContent &&
      mine.contentHash !== meta.contentHash
    ) {
      // Both sites changed the content. The version published first keeps the
      // file; this site's content is kept as a file of its own.
      const bytes = await content(meta);
      if (!bytes) return false;
      await store.syncApply(teamId, {
        ...record,
        bytes,
        take: { content: true, title: true, deleted: true },
        copy: {
          id: slideConflictCopyId(meta.id, mine.contentHash, site),
          title: conflictTitle(mine.title, site),
        },
      });
      await store.syncUnstage(teamId, meta.chunks);
      result.conflicts++;
      return true;
    }
    // Changes that do not collide: each side's own part is kept. A title
    // changed on both sides follows the published one.
    const takeContent = !localContent;
    const bytes =
      takeContent && needs(meta.contentHash) ? await content(meta) : null;
    if (takeContent && needs(meta.contentHash) && !bytes) return false;
    await store.syncApply(teamId, {
      ...record,
      bytes,
      take: {
        content: takeContent,
        title: !localTitle || meta.title !== (shared?.title ?? null),
        deleted: true,
      },
    });
    await store.syncUnstage(teamId, meta.chunks);
    return true;
  }

  if (head && head !== state.head) {
    const local = new Map(
      (await store.syncFiles(teamId)).map((file) => [file.id, file]),
    );
    let complete = true;
    for (const [path, oid] of tree) {
      const match = META_PATH.exec(path);
      if (!match) continue;
      const mine = local.get(match[1]);
      if (mine?.shared?.metaOid === oid) continue;
      try {
        const meta = decodeMeta(await transport.readFile(head, path), match[1]);
        if (await receive(meta, oid, mine)) result.received++;
        else complete = false;
      } catch (error) {
        // One unreadable file must not hide the others; the head stays where
        // it is, so the file is tried again on the next pass.
        warn("GraeBoard slide file not received", match[1], error.message);
        complete = false;
      }
    }
    // The cursor moves only when every changed file has its bytes and row.
    if (complete) {
      await store.syncSetHead(teamId, head);
      state.head = head;
    } else result.pending++;
  }
  if ((state.head || null) !== head) return result;

  // Publish from the head just applied, so every base is the shared version.
  const candidate = new Map();
  if (!head)
    candidate.set(
      "slides.json",
      canonical({ format: SLIDE_BRANCH_FORMAT, teamId }),
    );
  let upload = limits.chunks;
  const metas = [];
  // Smallest first, so a large file that needs several passes does not hold
  // back the files that fit in this one.
  const dirty = (await store.syncFiles(teamId))
    .filter(slideFileDirty)
    .sort((a, b) => a.byteLength - b.byteLength || (a.id < b.id ? -1 : 1))
    .slice(0, limits.files);
  for (const file of dirty) {
    let chunks = file.shared?.chunks;
    if (!chunks || file.contentHash !== file.shared.hash) {
      const pieces = slideChunks(
        await store.syncReadContent(teamId, file.contentHash),
      );
      chunks = pieces.map((piece) => piece.hash);
      let complete = true;
      for (const piece of pieces) {
        const path = slideChunkPath(piece.hash);
        if (tree.has(path) || candidate.has(path)) continue;
        if (upload <= 0) {
          complete = false;
          continue;
        }
        candidate.set(path, piece.bytes);
        upload--;
      }
      // Chunks already uploaded stay on the branch; the metadata that makes
      // the file visible follows once all of them are there.
      if (!complete) {
        result.pending++;
        continue;
      }
    }
    const meta = {
      id: file.id,
      title: file.title,
      contentHash: file.contentHash,
      byteLength: file.byteLength,
      chunks,
      // Allocated once for this exact local state and kept across retries.
      version: await store.syncAllocateVersion(
        teamId,
        file.id,
        snapshotKey(file),
      ),
      base: file.shared?.version ?? null,
      updatedBy: { id: file.updatedBy },
      updatedAt: file.updatedAt,
      deletedAt: file.deletedAt || null,
    };
    candidate.set(slideMetaPath(file.id), canonical(meta));
    metas.push(meta);
  }
  if (!candidate.size) return result;
  const commit = await transport.createCandidate(
    head,
    candidate,
    "GraeBoard slides",
  );
  if (!(await transport.publish(commit, head, SLIDE_BRANCH))) {
    // The other site published first: receive it on the next pass.
    result.raced = true;
    return result;
  }
  const published = new Map(
    (await transport.readCommit(commit)).files.map((file) => [
      file.path,
      file.oid,
    ]),
  );
  for (const meta of metas)
    await store.syncMarkShared(
      teamId,
      meta.id,
      sharedOf(meta, published.get(slideMetaPath(meta.id))),
    );
  await store.syncSetHead(teamId, commit);
  result.head = commit;
  result.published = metas.length;
  return result;
}
function sharedOf(meta, metaOid) {
  return {
    version: meta.version,
    hash: meta.contentHash,
    title: meta.title,
    deletedAt: meta.deletedAt,
    chunks: meta.chunks,
    metaOid,
  };
}
