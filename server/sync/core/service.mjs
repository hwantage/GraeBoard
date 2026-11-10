import { upgradeState } from "./versions.mjs";
import {
  assertStateCapacity,
  assertStateCapacityFrom,
} from "../../../shared/sync/sync-capacity.mjs";
import { combineFileEntries } from "./file-entries.mjs";
import { publishBranchJson } from "./branch-publication.mjs";
import {
  checkpointFiles,
  loadCheckpoint,
  snapshotCounts,
} from "./checkpoint.mjs";
import {
  ProtocolError,
  protocolValidation,
  isSyncInterruption,
} from "./errors.mjs";
import { encodeSnapshot, decodeSnapshot } from "./snapshot.mjs";
import { randomUUID } from "node:crypto";
import {
  canonical,
  digest,
  stateHash,
  stateSum,
  protocolVersion,
  supportedVersion,
  PROTOCOL,
  SPLIT_PROTOCOL,
} from "./protocol.mjs";
import { withSyncOperationCache } from "./sync-operation-cache.mjs";
import { pendingNeedsProjection } from "./projection.mjs";
import { reduceMany, validateSnapshot } from "./reducer.mjs";
import { withDocumentImageReferences } from "../../../shared/documents/document-image-references.js";
import {
  SYNC_FILE_MAX_BYTES,
  SYNC_ENVELOPE_RESERVE_BYTES,
} from "../../../shared/sync/sync-limits.js";
const decode = (bytes, limit = 128 * 1024 * 1024) => {
  if (!bytes || bytes.byteLength > limit)
    throw new ProtocolError(
      "SYNC_FORMAT",
      "Synchronization JSON exceeds byte budget",
    );
  return protocolValidation(() => JSON.parse(new TextDecoder().decode(bytes)));
};
const snapshotPath = (path) =>
  /^snapshots\/[a-zA-Z0-9-]+\.json(?:\.gz)?$/.test(path || "");
const allowedPath = (path) =>
  /^(manifest\.json|events\/[a-zA-Z0-9-]+\.json|snapshots\/[a-zA-Z0-9-]+\.json(?:\.gz)?|objects\/[a-f0-9]{64}|images\/[a-zA-Z0-9-]+\/[a-f0-9]{64}\.webp)$/.test(
    path,
  );
export function operationBatch(
  pending,
  maxOperations = 50,
  maxBytes = SYNC_FILE_MAX_BYTES,
  workBytes = Infinity,
) {
  // Reserve space for the envelope and hashes before making a remote commit.
  // Each immutable user command stays whole, including large bulk edits.
  const result = [];
  let bytes = SYNC_ENVELOPE_RESERVE_BYTES;
  for (const operation of pending.slice(0, maxOperations)) {
    const size = Buffer.byteLength(canonical(operation)) + 1;
    if (bytes + size > maxBytes) {
      if (!result.length)
        throw new ProtocolError(
          "EXTERNAL_SYNC_CAPACITY",
          "Pending command exceeds event envelope byte budget; review the preserved command before resuming",
        );
      break;
    }
    // An atomic command may exceed the work allowance on its own. Do not add
    // more commands to that batch; the next run publishes them in order.
    if (result.length && bytes + size > workBytes) break;
    result.push(operation);
    bytes += size;
  }
  return result;
}
// A hosted runtime stops an invocation at its CPU budget without unwinding, so
// each phase is reported as soon as it ends. The last completed phase brackets
// the interruption; CPU spent earlier in the invocation contributes too. Wall
// time equals CPU time only for synchronous phases; Supabase Edge has no
// process.cpuUsage().
export function phaseTimer(trace, label) {
  if (!trace) return () => {};
  const start = performance.now();
  let last = start;
  return (phase, detail = {}) => {
    const now = performance.now();
    trace({
      label,
      phase,
      ms: Math.round(now - last),
      totalMs: Math.round(now - start),
      ...detail,
    });
    last = now;
  };
}
// What this site's events and status carry beyond protocol 1, announced on
// its status branch. "sum-1": events carry resultSum (see stateSum) and this
// site verifies it, so a peer may omit the whole-state resultHash.
export const CAPABILITIES = ["sum-1"];
// Whether the peer's last stored status announced the state sum.
export function peerSums(link) {
  try {
    return !!JSON.parse(link?.remote_status || "null")?.capabilities?.includes(
      "sum-1",
    );
  } catch {
    return false;
  }
}
export class SyncService {
  constructor({
    transport,
    store,
    identity,
    images,
    maxCommits = 32,
    // Commits one cycle may apply across all its receives. A publication that
    // finds the branch moved receives again; without this bound a hosted cycle
    // with pending commands behind a long remote chain applied maxCommits per
    // failed publication, five times the per-invocation work it was sized for.
    maxRunCommits = Infinity,
    // Hosted callers also bound repeated work by payload size. Small commands
    // keep their commit/count throughput; one large atomic command stays whole.
    maxRunBytes = Infinity,
    maxOperations = 50,
    maxProtocol = SPLIT_PROTOCOL,
    stateLimits = { maxBytes: Infinity, maxEntities: Infinity },
    snapshotDecoder = decodeSnapshot,
    // An operator-side first import may commit the state first and install the
    // content-addressed images afterwards; each install still verifies the hash.
    deferImages = false,
    // Receives one entry per finished phase of a cycle that receives commits or
    // publishes operations (see phaseTimer).
    trace = null,
  }) {
    Object.assign(this, {
      transport,
      store,
      identity,
      images,
      maxCommits,
      maxRunCommits,
      maxRunBytes,
      maxOperations,
      maxProtocol,
      stateLimits,
      snapshotDecoder,
      deferImages,
      trace,
    });
    this.running = null;
    this.sizes = new WeakMap();
    this.mark = () => {};
    // Commits the running cycle may still apply (null outside a cycle), and
    // whether its last receive stopped short of the head it observed.
    this.budget = null;
    this.behind = false;
    this.runBytes = null;
  }
  workExhausted() {
    return this.runBytes !== null && this.runBytes >= this.maxRunBytes;
  }
  chargeBytes(bytes) {
    if (this.runBytes !== null && Number.isFinite(this.maxRunBytes))
      this.runBytes += bytes;
  }
  chargeOperations(operations) {
    if (this.runBytes !== null && Number.isFinite(this.maxRunBytes))
      for (const operation of operations)
        this.runBytes += Buffer.byteLength(canonical(operation));
  }
  // With the state it was reduced from, measure only the changed records.
  assertCapacity(state, base) {
    const known =
        base && (this.sizes.get(base) || this.store.measuredSize?.(base)),
      size = known
        ? assertStateCapacityFrom(base, known, state, this.stateLimits)
        : assertStateCapacity(state, this.stateLimits);
    this.sizes.set(state, size);
    return size;
  }
  run(options = {}) {
    if (this.running) return this.running;
    // A cycle replays every pending command several times per received commit
    // (slice reduce, image listing, materialize, commit), and each replay
    // validates each document body's images. Each pending autosave of one
    // document carries its own body, so dozens of them outnumber the 8 recent
    // extractions kept between requests and every replay parsed every body
    // again. The cycle holds those bodies until it ends anyway.
    this.running = withDocumentImageReferences(
      () => withSyncOperationCache(() => this.cycle(options)),
      {
        maxEntries: Infinity,
        maxBytes: Infinity,
        ttlMs: Infinity,
      },
    ).finally(() => (this.running = null));
    return this.running;
  }
  async checkCommit(oid, parent) {
    const commit = await this.transport.readCommit(oid);
    if (
      commit.parents.length !== (parent ? 1 : 0) ||
      (parent && commit.parents[0] !== parent)
    )
      throw new ProtocolError(
        "SYNC_HISTORY",
        "Non-linear synchronization history",
      );
    if (
      commit.files.some(
        (f) =>
          f.type !== "blob" ||
          !["100644", "100644 ".trim()].includes(f.mode) ||
          !allowedPath(f.path),
      )
    )
      throw new ProtocolError("SYNC_FORMAT", "Unsupported repository file");
    return commit;
  }
  async readChain(head, after, limit = this.maxCommits) {
    if (head === after || limit <= 0) return [];
    if (this.transport.readRange)
      return this.transport.readRange(head, after, limit);
    throw new ProtocolError(
      "SYNC_TRANSPORT",
      "Synchronization transport must implement bounded readRange",
    );
  }

  async verifyFiles(commit, parent) {
    const previous = parent
      ? await this.transport.readCommit(parent)
      : { files: [] };
    const old = new Map(previous.files.map((f) => [f.path, f.oid]));
    for (const f of commit.files) {
      if (old.has(f.path) && old.get(f.path) !== f.oid)
        throw new ProtocolError(
          "SYNC_INTEGRITY",
          "Immutable repository file changed",
        );
      old.delete(f.path);
    }
    if (old.size)
      throw new ProtocolError(
        "SYNC_INTEGRITY",
        "Immutable repository file removed",
      );
    const paths = new Set(previous.files.map((f) => f.path));
    return commit.files.filter((f) => !paths.has(f.path));
  }
  async receive(link, observedHead, useCheckpoint = false) {
    const head =
      observedHead === undefined
        ? await this.transport.readHead()
        : observedHead;
    this.behind = false;
    if (!head) {
      if (link.canonical_head)
        throw new ProtocolError(
          "SYNC_HISTORY",
          "Synchronization branch was deleted",
        );
      return link;
    }
    if (
      (link.mode === "importing" && !link.canonical_head) ||
      (useCheckpoint && ["importing", "recovery"].includes(link.mode))
    )
      link = await loadCheckpoint(this, link, head);
    const limit = this.workExhausted()
        ? 0
        : Math.min(this.maxCommits, this.budget ?? Infinity),
      chain = await this.readChain(head, link.canonical_head, limit);
    if (chain.length) this.mark("readChain", { commits: chain.length });
    // C is read only for a commit that cannot be applied to a slice of it; an
    // unchanged head needs no canonical state at all.
    let state = null;
    const whole = async () => {
      if (!state) {
        state = await this.store.readState({ mark: this.mark });
        this.mark("readState");
      }
      return state;
    };
    for (const commit of chain.slice(0, limit)) {
      if (this.workExhausted()) break;
      let projectionBytes = 0;
      const onPendingProjection = (pending) => {
        if (this.runBytes === null || !Number.isFinite(this.maxRunBytes))
          return;
        const bytes = pending.reduce(
          (n, op) => n + Buffer.byteLength(canonical(op)),
          0,
        );
        // Image and transactional projection each read fresh P. Count the
        // largest replayed P once for this commit, including concurrent saves.
        if (bytes > projectionBytes) {
          this.chargeBytes(bytes - projectionBytes);
          projectionBytes = bytes;
          this.mark("pendingProjection", { operations: pending.length, bytes });
        }
      };
      let previousState = state,
        slice = false;
      const parent = link.canonical_head || null;
      await this.checkCommit(commit.oid, parent);
      const added = await this.verifyFiles(commit, parent);
      const verifiedImages = new Map();
      let imageBytes = 0;
      for (const file of added) {
        if (!/^(objects|images)\//.test(file.path)) continue;
        if (
          file.path.startsWith("images/") &&
          !file.path.startsWith("images/" + this.identity.teamId + "/")
        )
          throw new ProtocolError("SYNC_FORMAT", "Foreign image object");
        if (this.deferImages && file.path.startsWith("images/")) continue;
        const bytes = await this.transport.readFile(commit.oid, file.path),
          expected = file.path
            .split("/")
            .at(-1)
            .replace(/\.webp$/, "");
        if (
          bytes.byteLength >
            (file.path.startsWith("images/") ? 10 : 64) * 1024 * 1024 ||
          digest(bytes) !== expected
        )
          throw new ProtocolError(
            "SYNC_INTEGRITY",
            "Repository object content hash or size mismatch",
          );
        if (
          file.path.startsWith("images/") &&
          imageBytes + bytes.byteLength <= 8 * 1024 * 1024
        ) {
          verifiedImages.set(file.path, bytes);
          imageBytes += bytes.byteLength;
        }
      }
      const manifest = decode(
        await this.transport.readFile(commit.oid, "manifest.json"),
        64 * 1024,
      );
      if (
        manifest.protocol !== 1 ||
        manifest.reducer !== 1 ||
        manifest.teamId !== this.identity.teamId ||
        manifest.repoId !== this.identity.repoId ||
        manifest.bootstrapId !== link.bootstrap_id ||
        !snapshotPath(manifest.genesis)
      )
        throw new ProtocolError(
          "SYNC_IDENTITY",
          "Repository identity mismatch",
        );
      let operations = [],
        transition = false,
        verifiedHash,
        verifiedSum;
      if (!parent) {
        if (
          !manifest.genesis ||
          added.some((f) => f.path.startsWith("events/"))
        )
          throw new ProtocolError("SYNC_FORMAT", "Invalid genesis");
        const bytes = await this.transport.readFile(
          commit.oid,
          manifest.genesis,
        );
        if (digest(bytes) !== manifest.genesisHash)
          throw new ProtocolError(
            "SYNC_INTEGRITY",
            "Genesis checksum mismatch",
          );
        const bundle = protocolValidation(() => this.snapshotDecoder(bytes));
        state = protocolValidation(() =>
          validateSnapshot(bundle.state, this.identity),
        );
        if (stateHash(state) !== bundle.hash)
          throw new ProtocolError(
            "SYNC_INTEGRITY",
            "Genesis state checksum mismatch",
          );
        operations = Object.keys(state.receipts);
      } else {
        const events = added.filter((f) => f.path.startsWith("events/"));
        if (events.length !== 1)
          throw new ProtocolError("SYNC_FORMAT", "Expected one event envelope");
        const envelopeBytes = await this.transport.readFile(
            commit.oid,
            events[0].path,
          ),
          envelope = decode(envelopeBytes, 64 * 1024 * 1024);
        if (
          envelope.parent !== parent ||
          !supportedVersion(
            envelope.protocol,
            envelope.reducer ?? envelope.protocol,
          ) ||
          envelope.protocol > this.maxProtocol
        )
          throw new ProtocolError(
            "SYNC_FORMAT",
            "Invalid event parent or protocol",
          );
        if (
          envelope.kind !== "transition" &&
          envelope.protocol !==
            (state
              ? protocolVersion(state)
              : ((await this.store.readProtocol?.()) ??
                protocolVersion(await whole())))
        )
          throw new ProtocolError(
            "SYNC_VERSION",
            "Explicit protocol transition required",
          );
        // A checkpoint leaves C as it is. With its state sum, a store that
        // keeps C's totals verifies it against them and advances the head
        // without loading C or the snapshot (that is for sites joining).
        const unchanged =
          envelope.kind === "checkpoint" &&
          envelope.checkpointVersion === 1 &&
          envelope.resultSum &&
          !state &&
          (await this.store.unchangedSlice?.());
        if (unchanged) {
          if (
            unchanged.head !== parent ||
            !snapshotPath(envelope.path) ||
            envelope.atCommit !== parent ||
            envelope.reducer !== envelope.protocol ||
            envelope.teamId !== this.identity.teamId ||
            envelope.repoId !== this.identity.repoId ||
            envelope.bootstrapId !== link.bootstrap_id
          )
            throw new ProtocolError("SYNC_FORMAT", "Invalid checkpoint");
          if (envelope.resultSum !== unchanged.sum)
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Checkpoint state sum mismatch",
            );
          previousState = state = unchanged.base;
          slice = true;
          verifiedHash = link.canonical_hash || null;
          verifiedSum = unchanged.sum;
          this.mark("checkpointSum");
        } else if (["transition", "checkpoint"].includes(envelope.kind))
          previousState = await whole();
        if (envelope.kind === "transition") {
          // Only a writer that publishes nothing meanwhile: paused, or a
          // receive-only import or recovery.
          if (!["paused", "importing", "recovery"].includes(link.mode))
            throw new ProtocolError(
              "SYNC_TRANSITION_PENDING",
              "Pause this writer before accepting a protocol transition",
            );
          if (
            protocolVersion(state) !== PROTOCOL ||
            envelope.protocol !== SPLIT_PROTOCOL ||
            envelope.reducer !== SPLIT_PROTOCOL ||
            envelope.fromProtocol !== PROTOCOL ||
            envelope.previousHash !== stateHash(state) ||
            !snapshotPath(envelope.path) ||
            !snapshotPath(envelope.previousPath)
          )
            throw new ProtocolError(
              "SYNC_VERSION",
              "Invalid protocol transition",
            );
          if (
            (await this.store.readPending()).length ||
            Object.values(state.conflicts).some(
              (conflict) => !conflict.resolution,
            )
          )
            throw new ProtocolError(
              "SYNC_TRANSITION_PENDING",
              "Protocol transition requires drained pending commands and resolved conflicts",
            );
          const bytes = await this.transport.readFile(
              commit.oid,
              envelope.path,
            ),
            previousBytes = await this.transport.readFile(
              commit.oid,
              envelope.previousPath,
            );
          if (
            digest(bytes) !== envelope.snapshotHash ||
            digest(previousBytes) !== envelope.previousSnapshotHash
          )
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Protocol transition snapshot checksum mismatch",
            );
          const bundle = protocolValidation(() => this.snapshotDecoder(bytes)),
            previous = protocolValidation(() =>
              this.snapshotDecoder(previousBytes),
            );
          const expected = protocolValidation(() => upgradeState(state));
          if (
            bundle.atCommit !== parent ||
            previous.atCommit !== parent ||
            stateHash(previous.state) !== envelope.previousHash ||
            stateHash(expected) !== envelope.resultHash ||
            stateHash(bundle.state) !== envelope.resultHash
          )
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Protocol transition changed preserved data",
            );
          state = protocolValidation(() =>
            validateSnapshot(bundle.state, this.identity),
          );
          this.assertCapacity(state);
          transition = true;
        } else if (envelope.kind === "checkpoint" && unchanged) {
          // Verified above by the state sum.
        } else if (envelope.kind === "checkpoint") {
          if (
            !snapshotPath(envelope.path) ||
            envelope.atCommit !== parent ||
            envelope.resultHash !== stateHash(state)
          )
            throw new ProtocolError("SYNC_FORMAT", "Invalid checkpoint");
          const snapshotBytes = await this.transport.readFile(
            commit.oid,
            envelope.path,
          );
          const snap = protocolValidation(() =>
            this.snapshotDecoder(snapshotBytes),
          );
          if (
            envelope.checkpointVersion === 1 &&
            (envelope.reducer !== protocolVersion(state) ||
              envelope.teamId !== this.identity.teamId ||
              envelope.repoId !== this.identity.repoId ||
              envelope.bootstrapId !== link.bootstrap_id ||
              envelope.snapshotHash !== digest(snapshotBytes) ||
              canonical(envelope.counts) !==
                canonical(snapshotCounts(snap.state)))
          )
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Checkpoint manifest checksum or identity mismatch",
            );
          protocolValidation(() => validateSnapshot(snap.state, this.identity));
          if (
            snap.atCommit !== parent ||
            stateHash(snap.state) !== envelope.resultHash
          )
            throw new ProtocolError(
              "SYNC_FORMAT",
              "Invalid checkpoint snapshot",
            );
        } else if (envelope.kind === "operations") {
          if (
            !Array.isArray(envelope.operations) ||
            !envelope.operations.length ||
            envelope.operations.length > this.maxOperations
          )
            throw new ProtocolError(
              "SYNC_FORMAT",
              "Operation envelope exceeds count budget",
            );
          const cover =
            state && !Number.isFinite(this.maxRunBytes)
              ? []
              : await this.store.readPending();
          // Use the received bytes: serializing untrusted input here would
          // repeat reducer work and bypass protocolValidation's error mapping.
          this.chargeBytes(envelopeBytes.byteLength);
          const reduced = await this.reduceCanonical(
            envelope.operations,
            { ...this.identity, protocol: envelope.protocol },
            {
              parent,
              cover: state ? [] : cover,
              received: true,
              whole: state,
              needHash: !envelope.resultSum,
            },
          );
          ({ previousState, state, slice } = reduced);
          if (pendingNeedsProjection(previousState, state, cover))
            onPendingProjection(cover);
          operations = envelope.operations.map((op) => op.opId);
          // A peer with the state sum sends it (and the whole-state hash
          // when it holds C in memory); an older peer sends only the hash.
          // Whatever both sides computed must agree.
          if (
            (!envelope.resultSum && !envelope.resultHash) ||
            (envelope.resultSum && reduced.resultSum !== envelope.resultSum) ||
            (envelope.resultHash &&
              reduced.resultHash &&
              reduced.resultHash !== envelope.resultHash) ||
            (!envelope.resultSum && !reduced.resultHash)
          )
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Reducer result checksum mismatch",
            );
          verifiedHash = reduced.resultHash || null;
          verifiedSum = reduced.resultSum;
        } else throw new ProtocolError("SYNC_FORMAT", "Unsupported event kind");
      }
      if (protocolVersion(state) > this.maxProtocol)
        throw new ProtocolError(
          "SYNC_VERSION",
          "Unsupported protocol version; canonical cursor is unchanged",
        );
      const stateSize = this.assertCapacity(state, previousState);
      if (this.runBytes !== null && Number.isFinite(this.maxRunBytes)) {
        if (!parent || transition) this.runBytes += stateSize.bytes;
        // Checkpoints still project P while advancing C's head.
        if (parent && !operations.length) {
          const pending = await this.store.readPending();
          if (pendingNeedsProjection(previousState, state, pending))
            onPendingProjection(pending);
        }
      }
      if (!this.deferImages)
        await this.images?.receive?.(state, commit.oid, this.transport, {
          added,
          verifiedImages,
          previousState: parent ? previousState : null,
          onPendingProjection,
        });
      this.mark("receiveImages");
      await this.store.commitCanonical(parent, commit.oid, state, operations, {
        previousState,
        transition,
        stateHash: verifiedHash,
        stateSum: verifiedSum,
        stateSize,
        slice,
        mark: this.mark,
        onPendingProjection,
        incrementalPending: !!parent && link.mode === "active" && !transition,
      });
      this.mark("commitCanonical", { commit: commit.oid });
      if (this.budget !== null) this.budget--;
      // A slice is not C; a later commit that needs C reads it again.
      if (slice) state = null;
      link = await this.store.readLink();
      await new Promise((r) => setTimeout(r, 0));
    }
    this.behind = link.canonical_head !== head;
    if (link.mode === "importing" && link.canonical_head === head) {
      await this.store.finishImport?.(head);
      link = await this.store.readLink();
    }
    return link;
  }
  async initialize(link) {
    const head = await this.transport.readHead();
    if (head) return this.receive(link);
    const bundle = await this.store.bootstrap();
    protocolValidation(() => validateSnapshot(bundle.state, this.identity));
    this.assertCapacity(bundle.state);
    if (stateHash(bundle.state) !== bundle.hash)
      throw new ProtocolError(
        "SYNC_INTEGRITY",
        "Bootstrap state checksum mismatch",
      );
    const bytes = encodeSnapshot(bundle);
    const manifest = {
      protocol: 1,
      reducer: 1,
      ...this.identity,
      bootstrapId: link.bootstrap_id,
      genesis: "snapshots/genesis.json.gz",
      genesisHash: digest(bytes),
    };
    const files = combineFileEntries(
      {
        "manifest.json": canonical(manifest),
        "snapshots/genesis.json.gz": bytes,
      },
      this.images?.publish?.(bundle.state, {
        parent: null,
        transport: this.transport,
      }),
    );
    const oid = await this.transport.createCandidate(null, files);
    await this.store.saveBootstrap?.({ oid, bundleHash: digest(bytes) });
    await this.transport.publish(oid, null);
    return this.receive(link);
  }
  // Applies operations to C and returns the result with its stateHash. A store
  // that can reduce only the records the operations touch (reduceSlice) does
  // so, with the hash computed beside the data; anything it declines falls
  // back to loading and hashing the whole state. The slice result stands for
  // C only through commitCanonical(..., { slice: true }).
  // Received operations are validated as protocol input (protocolValidation).
  // The state sum (stateSum) is always produced. The whole-state stateHash is
  // produced when needHash asks for it, for a peer that verifies only that;
  // a store holding C in memory computes both anyway.
  async reduceCanonical(
    operations,
    identity,
    {
      parent,
      cover = [],
      received = false,
      whole = null,
      needHash = true,
    } = {},
  ) {
    const reduction = whole
      ? null
      : await this.store.reduceSlice?.(operations, identity, {
          cover,
          legacyHash: needHash,
          mark: this.mark,
        });
    if (reduction && reduction.head === parent)
      return {
        previousState: reduction.base,
        state: reduction.state,
        resultHash: reduction.hash,
        resultSum: reduction.sum,
        slice: true,
      };
    const previousState =
      whole || (await this.store.readState({ mark: this.mark }));
    if (!whole)
      this.mark(
        "readState",
        this.trace && { entities: Object.keys(previousState.entities).length },
      );
    const reduce = () =>
        reduceMany(previousState, operations, identity, {
          persistentReceipts: true,
        }),
      state = received ? protocolValidation(reduce) : reduce();
    this.mark("reduce");
    const resultHash = stateHash(state),
      resultSum = stateSum(state);
    this.mark("stateHash");
    return { previousState, state, resultHash, resultSum, slice: false };
  }
  async cycle({
    initialize = false,
    receiveOnly = false,
    updateStatus = true,
    observedHead,
    loadCheckpoint: useCheckpoint = false,
  } = {}) {
    const owner = randomUUID();
    if (!(await this.store.acquire(owner))) return { busy: true };
    this.mark = phaseTimer(this.trace, this.identity.teamId);
    this.budget = this.maxRunCommits;
    this.runBytes = 0;
    let traced = false;
    try {
      let link = await this.store.readLink();
      if (!link) return { mode: "unlinked" };
      if (["disconnected", "paused"].includes(link.mode)) {
        if (updateStatus) await this.status(link);
        return { mode: link.mode };
      }
      if (initialize && link.mode === "initializing")
        link = await this.initialize(link);
      else {
        const before = link.canonical_head;
        link = await this.receive(link, observedHead, useCheckpoint);
        traced = link.canonical_head !== before;
      }
      if (!receiveOnly && link.mode !== "recovery")
        for (let attempt = 0; attempt < 4; attempt++) {
          if (this.workExhausted()) {
            this.mark("yield", { bytes: this.runBytes });
            break;
          }
          // With its budget spent short of the head it saw, the cycle leaves
          // the rest to the next one: a candidate on this parent cannot be
          // published, and receiving again would exceed the budget.
          if (this.behind && this.budget <= 0) {
            this.mark("behind", { head: link.canonical_head });
            break;
          }
          const pending = operationBatch(
            await this.store.readPending(),
            this.maxOperations,
            SYNC_FILE_MAX_BYTES,
            this.maxRunBytes - this.runBytes,
          );
          if (!pending.length) break;
          // As in receive(), finish the first atomic command even if it
          // crosses the remaining allowance after small independent work.
          this.chargeOperations(pending);
          traced = true;
          // Details cost a pass over the batch and C, so only a trace pays it.
          this.mark(
            "readPending",
            this.trace && {
              attempt,
              operations: pending.length,
              bytes: pending.reduce(
                (sum, op) => sum + Buffer.byteLength(canonical(op)),
                0,
              ),
            },
          );
          const parent = link.canonical_head;
          if (!parent) throw new Error("Initial publication required");
          const { previousState, state, resultHash, resultSum, slice } =
            await this.reduceCanonical(pending, this.identity, {
              parent,
              needHash: !peerSums(link),
            });
          const stateSize = this.assertCapacity(state, previousState);
          this.mark("capacity", { bytes: stateSize.bytes });
          const event = {
            protocol: protocolVersion(state),
            kind: "operations",
            parent,
            operations: pending,
            ...(resultHash ? { resultHash } : {}),
            resultSum,
          };
          const files = combineFileEntries(
            {
              ["events/" + randomUUID() + ".json"]: canonical(event),
            },
            this.images?.publish?.(state, {
              parent,
              transport: this.transport,
              operations: pending,
            }),
          );
          this.mark("event");
          const oid = await this.transport.createCandidate(parent, files);
          this.mark("createCandidate");
          let published;
          try {
            published = await this.transport.publish(oid, parent);
          } catch (error) {
            await this.receive(await this.store.readLink());
            throw error;
          }
          this.mark("publishRef", { published });
          // false: a peer moved the branch first, so receive what is there.
          link =
            published === true
              ? await this.commitPublished(link, oid, state, {
                  operations: pending.map((op) => op.opId),
                  previousState,
                  stateHash: resultHash || null,
                  stateSum: resultSum,
                  stateSize,
                  slice,
                  mark: this.mark,
                })
              : await this.receive(await this.store.readLink());
          this.mark("commitPublished", { head: link.canonical_head });
          if (link.canonical_head === oid) break;
        }
      if (updateStatus) await this.status(link);
      if (traced) this.mark("done");
      await this.store.setError?.(null);
      return { head: link.canonical_head };
    } catch (error) {
      if (traced) this.mark("failed", { error: error.code || error.message });
      await this.store.setError?.(error);
      throw error;
    } finally {
      this.mark = () => {};
      this.budget = null;
      this.runBytes = null;
      await this.store.release(owner);
    }
  }
  // The commit just published (the branch now points at it) applies exactly
  // these operations to C, which is what receiving it would recompute. Record
  // that result directly instead of reading, reducing, hashing and checking
  // images for the whole state again; anything unexpected falls back to
  // receiving the commit like any other.
  async commitPublished(link, oid, state, { operations, ...options }) {
    try {
      await this.store.commitCanonical(
        link.canonical_head,
        oid,
        state,
        operations,
        options,
      );
    } catch (error) {
      if (isSyncInterruption(error)) throw error;
      return this.receive(await this.store.readLink());
    }
    return this.store.readLink();
  }
  async status(link) {
    if (!link.canonical_head) return;
    const branch = "sync-status/" + link.installation_id;
    const status = {
      ...this.identity,
      installationId: link.installation_id,
      writerEpoch: link.writer_epoch,
      appliedCanonicalHead: link.canonical_head,
      mode: link.mode,
      capabilities: CAPABILITIES,
      observedAt: new Date().toISOString(),
    };
    const stable = ({ observedAt, peerInstallationId, ...value }) => value;
    await publishBranchJson(this.transport, {
      branch,
      file: "status.json",
      value: status,
      maxBytes: 64 * 1024,
      decode: (bytes) => decode(bytes, 64 * 1024),
      cacheKey: digest(stable(status)),
      unchanged: (previous) =>
        digest(stable(previous)) === digest(stable(status)) &&
        Date.parse(previous.observedAt) <= Date.now() &&
        Date.now() - Date.parse(previous.observedAt) < 60000,
      expiresAt: (value) => Date.parse(value.observedAt) + 60000,
    });
    if (this.identity.peerInstallationId) {
      const peer = await this.transport.readHead(
        "sync-status/" + this.identity.peerInstallationId,
      );
      if (peer) {
        const remote = decode(
          await this.transport.readFile(peer, "status.json"),
          64 * 1024,
        );
        remote.verified =
          remote.teamId === this.identity.teamId &&
          remote.repoId === this.identity.repoId &&
          remote.mode === "active" &&
          Date.now() - Date.parse(remote.observedAt) >= 0 &&
          Date.now() - Date.parse(remote.observedAt) < 180000 &&
          remote.installationId === this.identity.peerInstallationId &&
          typeof remote.appliedCanonicalHead === "string" &&
          /^[a-f0-9]{40}$/.test(remote.appliedCanonicalHead) &&
          (await this.transport.verifyReachable(
            link.canonical_head,
            remote.appliedCanonicalHead,
          ));
        remote.verifiedAgainstHead = link.canonical_head;
        await this.store.saveRemoteStatus?.(remote);
      }
    }
  }
  async upgrade({ expectedHead, expectedHash, peersStopped } = {}) {
    if (
      peersStopped !== true ||
      !/^[a-f0-9]{40}$/.test(expectedHead || "") ||
      !/^[a-f0-9]{64}$/.test(expectedHash || "")
    )
      throw Object.assign(
        new Error(
          "Protocol upgrade requires the exact head/hash and stopped peer confirmation",
        ),
        { status: 400, code: "SYNC_UPGRADE_CONFIRMATION" },
      );
    const owner = "upgrade:" + randomUUID();
    if (!(await this.store.acquire(owner))) return { busy: true };
    try {
      const link = await this.store.readLink();
      if (link?.mode !== "paused" || link.canonical_head !== expectedHead)
        throw Object.assign(
          new Error(
            "Pause both writers at the verified canonical head before upgrading",
          ),
          { status: 409, code: "SYNC_UPGRADE_HEAD" },
        );
      const state = await this.store.readState();
      if (
        stateHash(state) !== expectedHash ||
        (await this.store.readPending()).length ||
        Object.values(state.conflicts).some((conflict) => !conflict.resolution)
      )
        throw Object.assign(
          new Error(
            "Protocol upgrade requires the exact state and no pending/held commands or unresolved conflicts",
          ),
          { status: 409, code: "SYNC_TRANSITION_PENDING" },
        );
      const remoteHead = await this.transport.readHead();
      if (remoteHead !== expectedHead) {
        const remote =
          remoteHead && (await this.transport.readCommit(remoteHead));
        if (
          !remote ||
          remote.parents.length !== 1 ||
          remote.parents[0] !== expectedHead
        )
          throw Object.assign(
            new Error(
              "Remote head is not the single expected protocol transition",
            ),
            { status: 409, code: "SYNC_UPGRADE_HEAD" },
          );
        const added = await this.verifyFiles(remote, expectedHead),
          events = added.filter((file) => file.path.startsWith("events/"));
        if (
          events.length !== 1 ||
          decode(await this.transport.readFile(remoteHead, events[0].path))
            .kind !== "transition"
        )
          throw Object.assign(
            new Error("Remote head is not a protocol transition"),
            { status: 409, code: "SYNC_UPGRADE_HEAD" },
          );
        const received = await this.receive(link, remoteHead);
        return {
          head: received.canonical_head,
          stateHash: stateHash(await this.store.readState()),
          protocol: SPLIT_PROTOCOL,
          reducer: SPLIT_PROTOCOL,
          upgraded: true,
          received: true,
        };
      }
      if (protocolVersion(state) === SPLIT_PROTOCOL)
        return {
          head: expectedHead,
          stateHash: expectedHash,
          protocol: SPLIT_PROTOCOL,
          reducer: SPLIT_PROTOCOL,
          upgraded: false,
        };
      protocolValidation(() => validateSnapshot(state, this.identity));
      const next = protocolValidation(() =>
        validateSnapshot(upgradeState(state), this.identity),
      );
      this.assertCapacity(next);
      const path = "snapshots/" + randomUUID() + ".json.gz",
        previousPath = "snapshots/" + randomUUID() + ".json.gz",
        bytes = encodeSnapshot({ atCommit: expectedHead, state: next }),
        previousBytes = encodeSnapshot({ atCommit: expectedHead, state }),
        envelope = {
          protocol: SPLIT_PROTOCOL,
          reducer: SPLIT_PROTOCOL,
          kind: "transition",
          fromProtocol: PROTOCOL,
          parent: expectedHead,
          previousHash: expectedHash,
          resultHash: stateHash(next),
          path,
          previousPath,
          snapshotHash: digest(bytes),
          previousSnapshotHash: digest(previousBytes),
        };
      const oid = await this.transport.createCandidate(expectedHead, {
        [path]: bytes,
        [previousPath]: previousBytes,
        ["events/" + randomUUID() + ".json"]: canonical(envelope),
      });
      if (!(await this.transport.publish(oid, expectedHead)))
        throw Object.assign(
          new Error(
            "Protocol upgrade publication changed concurrently; canonical data is preserved",
          ),
          { status: 409, code: "SYNC_PUBLICATION_CONFLICT" },
        );
      const received = await this.receive(link, oid);
      return {
        head: received.canonical_head,
        stateHash: envelope.resultHash,
        protocol: SPLIT_PROTOCOL,
        reducer: SPLIT_PROTOCOL,
        upgraded: true,
      };
    } finally {
      await this.store.release(owner);
    }
  }
  async checkpoint() {
    const owner = randomUUID();
    if (!(await this.store.acquire(owner))) return { busy: true };
    try {
      const link = await this.store.readLink();
      if (link?.mode !== "active" || !link.canonical_head)
        throw new Error("Checkpoint requires an active reconciled connection");
      const state = await this.store.readState();
      this.assertCapacity(state);
      const { files } = checkpointFiles({
        head: link.canonical_head,
        bootstrapId: link.bootstrap_id,
        identity: this.identity,
        state,
      });
      const oid = await this.transport.createCandidate(
        link.canonical_head,
        files,
      );
      if (!(await this.transport.publish(oid, link.canonical_head)))
        throw Object.assign(
          new Error(
            "Checkpoint publication changed concurrently; retry checkpoint",
          ),
          { status: 409, code: "SYNC_PUBLICATION_CONFLICT" },
        );
    } finally {
      await this.store.release(owner);
    }
    return this.run({ receiveOnly: true });
  }
}
