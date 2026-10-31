import { upgradeState } from "./versions.mjs";
import {
  assertStateCapacity,
  assertStateCapacityFrom,
} from "../../shared/sync-capacity.mjs";
import { combineFileEntries } from "./file-entries.mjs";
import { publishBranchJson } from "./branch-publication.mjs";
import { loadCheckpoint, snapshotCounts } from "./checkpoint.mjs";
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
  protocolVersion,
  supportedVersion,
} from "./protocol.mjs";
import { reduceMany, validateSnapshot } from "./reducer.mjs";
import {
  SYNC_FILE_MAX_BYTES,
  SYNC_ENVELOPE_RESERVE_BYTES,
} from "../../shared/sync-limits.js";
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
    result.push(operation);
    bytes += size;
  }
  return result;
}
export class SyncService {
  constructor({
    transport,
    store,
    identity,
    images,
    maxCommits = 32,
    maxOperations = 50,
    maxProtocol = 2,
    stateLimits = { maxBytes: Infinity, maxEntities: Infinity },
    snapshotDecoder = decodeSnapshot,
    // An operator-side first import may commit the state first and install the
    // content-addressed images afterwards; each install still verifies the hash.
    deferImages = false,
  }) {
    Object.assign(this, {
      transport,
      store,
      identity,
      images,
      maxCommits,
      maxOperations,
      maxProtocol,
      stateLimits,
      snapshotDecoder,
      deferImages,
    });
    this.running = null;
    this.sizes = new WeakMap();
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
    this.running = this.cycle(options).finally(() => (this.running = null));
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
  async readChain(head, after) {
    if (head === after) return [];
    if (this.transport.readRange)
      return this.transport.readRange(head, after, this.maxCommits);
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
    const chain = await this.readChain(head, link.canonical_head);
    // An unchanged head needs no canonical state at all.
    let state = chain.length ? await this.store.readState() : null;
    for (const commit of chain.slice(0, this.maxCommits)) {
      const previousState = state;
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
        verifiedHash;
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
        const envelope = decode(
          await this.transport.readFile(commit.oid, events[0].path),
          64 * 1024 * 1024,
        );
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
          envelope.protocol !== protocolVersion(state)
        )
          throw new ProtocolError(
            "SYNC_VERSION",
            "Explicit protocol transition required",
          );
        if (envelope.kind === "transition") {
          if (!["paused", "importing"].includes(link.mode))
            throw new ProtocolError(
              "SYNC_TRANSITION_PENDING",
              "Pause this writer before accepting a protocol transition",
            );
          if (
            protocolVersion(state) !== 1 ||
            envelope.protocol !== 2 ||
            envelope.reducer !== 2 ||
            envelope.fromProtocol !== 1 ||
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
          state = protocolValidation(() =>
            reduceMany(
              state,
              envelope.operations,
              { ...this.identity, protocol: envelope.protocol },
              { persistentReceipts: true },
            ),
          );
          operations = envelope.operations.map((op) => op.opId);
          if (stateHash(state) !== envelope.resultHash)
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Reducer result checksum mismatch",
            );
          verifiedHash = envelope.resultHash;
        } else throw new ProtocolError("SYNC_FORMAT", "Unsupported event kind");
      }
      if (protocolVersion(state) > this.maxProtocol)
        throw new ProtocolError(
          "SYNC_VERSION",
          "Unsupported protocol version; canonical cursor is unchanged",
        );
      const stateSize = this.assertCapacity(state, previousState);
      if (!this.deferImages)
        await this.images?.receive?.(state, commit.oid, this.transport, {
          added,
          verifiedImages,
          previousState: parent ? previousState : null,
        });
      await this.store.commitCanonical(parent, commit.oid, state, operations, {
        previousState,
        transition,
        stateHash: verifiedHash,
        stateSize,
      });
      link = await this.store.readLink();
      await new Promise((r) => setTimeout(r, 0));
    }
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
  async cycle({
    initialize = false,
    receiveOnly = false,
    updateStatus = true,
    observedHead,
    loadCheckpoint: useCheckpoint = false,
  } = {}) {
    const owner = randomUUID();
    if (!(await this.store.acquire(owner))) return { busy: true };
    try {
      let link = await this.store.readLink();
      if (!link) return { mode: "unlinked" };
      if (["disconnected", "paused"].includes(link.mode)) {
        if (updateStatus) await this.status(link);
        return { mode: link.mode };
      }
      if (initialize && link.mode === "initializing")
        link = await this.initialize(link);
      else link = await this.receive(link, observedHead, useCheckpoint);
      if (!receiveOnly && link.mode !== "recovery")
        for (let attempt = 0; attempt < 4; attempt++) {
          const pending = operationBatch(
            await this.store.readPending(),
            this.maxOperations,
          );
          if (!pending.length) break;
          const previousState = await this.store.readState();
          let state = reduceMany(previousState, pending, this.identity, {
            persistentReceipts: true,
          });
          const stateSize = this.assertCapacity(state, previousState);
          const parent = link.canonical_head;
          if (!parent) throw new Error("Initial publication required");
          const event = {
            protocol: protocolVersion(state),
            kind: "operations",
            parent,
            operations: pending,
            resultHash: stateHash(state),
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
          const oid = await this.transport.createCandidate(parent, files);
          let published;
          try {
            published = await this.transport.publish(oid, parent);
          } catch (error) {
            await this.receive(await this.store.readLink());
            throw error;
          }
          // false: a peer moved the branch first, so receive what is there.
          link =
            published === true
              ? await this.commitPublished(link, oid, state, {
                  operations: pending.map((op) => op.opId),
                  previousState,
                  stateHash: event.resultHash,
                  stateSize,
                })
              : await this.receive(await this.store.readLink());
          if (link.canonical_head === oid) break;
        }
      if (updateStatus) await this.status(link);
      await this.store.setError?.(null);
      return { head: link.canonical_head };
    } catch (error) {
      await this.store.setError?.(error);
      throw error;
    } finally {
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
          protocol: 2,
          reducer: 2,
          upgraded: true,
          received: true,
        };
      }
      if (protocolVersion(state) === 2)
        return {
          head: expectedHead,
          stateHash: expectedHash,
          protocol: 2,
          reducer: 2,
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
          protocol: 2,
          reducer: 2,
          kind: "transition",
          fromProtocol: 1,
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
        protocol: 2,
        reducer: 2,
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
      const link = await this.store.readLink(),
        path = "snapshots/" + randomUUID() + ".json.gz";
      if (link?.mode !== "active" || !link.canonical_head)
        throw new Error("Checkpoint requires an active reconciled connection");
      const state = await this.store.readState();
      this.assertCapacity(state);
      const bytes = encodeSnapshot({ atCommit: link.canonical_head, state });
      const envelope = {
        protocol: protocolVersion(state),
        reducer: protocolVersion(state),
        checkpointVersion: 1,
        teamId: this.identity.teamId,
        repoId: this.identity.repoId,
        bootstrapId: link.bootstrap_id,
        snapshotHash: digest(bytes),
        counts: snapshotCounts(state),
        kind: "checkpoint",
        parent: link.canonical_head,
        atCommit: link.canonical_head,
        path,
        resultHash: stateHash(state),
      };
      const oid = await this.transport.createCandidate(link.canonical_head, {
        [path]: bytes,
        ["events/" + randomUUID() + ".json"]: canonical(envelope),
      });
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
