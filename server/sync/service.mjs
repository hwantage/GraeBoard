import { encodeSnapshot, decodeSnapshot } from "./snapshot.mjs";
import { randomUUID } from "node:crypto";
import { canonical, digest, stateHash } from "./protocol.mjs";
import { reduceMany, validateSnapshot } from "./reducer.mjs";
const decode = (bytes, limit = 128 * 1024 * 1024) => {
  if (!bytes || bytes.byteLength > limit)
    throw new Error("Synchronization JSON exceeds byte budget");
  return JSON.parse(new TextDecoder().decode(bytes));
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
  maxBytes = 64 * 1024 * 1024,
) {
  // Reserve space for the envelope and hashes before making a remote commit.
  // Each immutable user command stays whole, including large bulk edits.
  const result = [];
  let bytes = 1024;
  for (const operation of pending.slice(0, maxOperations)) {
    const size = Buffer.byteLength(canonical(operation)) + 1;
    if (bytes + size > maxBytes) {
      if (!result.length)
        throw new Error("Pending command exceeds event envelope byte budget");
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
    snapshotDecoder = decodeSnapshot,
  }) {
    Object.assign(this, {
      transport,
      store,
      identity,
      images,
      maxCommits,
      maxOperations,
      snapshotDecoder,
    });
    this.running = null;
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
      throw new Error("Non-linear synchronization history");
    if (
      commit.files.some(
        (f) =>
          f.type !== "blob" ||
          !["100644", "100644 ".trim()].includes(f.mode) ||
          !allowedPath(f.path),
      )
    )
      throw new Error("Unsupported repository file");
    return commit;
  }
  async readChain(head, after) {
    const chain = [];
    let oid = head;
    while (oid && oid !== after) {
      if (chain.length >= 10000)
        throw new Error(
          "History budget exceeded; import a verified checkpoint",
        );
      const c = await this.transport.readCommit(oid);
      if (c.parents.length > 1)
        throw new Error("Merge commit is not permitted");
      chain.push(c);
      oid = c.parents[0] || null;
    }
    if (after && oid !== after)
      throw new Error("Remote history rewritten; recovery required");
    return chain.reverse();
  }
  async verifyFiles(commit, parent) {
    const previous = parent
      ? await this.transport.readCommit(parent)
      : { files: [] };
    const old = new Map(previous.files.map((f) => [f.path, f.oid]));
    for (const f of commit.files) {
      if (old.has(f.path) && old.get(f.path) !== f.oid)
        throw new Error("Immutable repository file changed");
      old.delete(f.path);
    }
    if (old.size) throw new Error("Immutable repository file removed");
    const paths = new Set(previous.files.map((f) => f.path));
    return commit.files.filter((f) => !paths.has(f.path));
  }
  async receive(link) {
    const head = await this.transport.readHead();
    if (!head) {
      if (link.canonical_head)
        throw new Error("Synchronization branch was deleted");
      return link;
    }
    const chain = await this.readChain(head, link.canonical_head);
    let state = await this.store.readState();
    for (const commit of chain.slice(0, this.maxCommits)) {
      const previousState = state;
      const parent = link.canonical_head || null;
      await this.checkCommit(commit.oid, parent);
      const added = await this.verifyFiles(commit, parent);
      for (const file of added) {
        if (!/^(objects|images)\//.test(file.path)) continue;
        if (
          file.path.startsWith("images/") &&
          !file.path.startsWith("images/" + this.identity.teamId + "/")
        )
          throw new Error("Foreign image object");
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
          throw new Error("Repository object content hash or size mismatch");
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
        throw new Error("Repository identity mismatch");
      let operations = [];
      if (!parent) {
        if (
          !manifest.genesis ||
          added.some((f) => f.path.startsWith("events/"))
        )
          throw new Error("Invalid genesis");
        const bytes = await this.transport.readFile(
          commit.oid,
          manifest.genesis,
        );
        if (digest(bytes) !== manifest.genesisHash)
          throw new Error("Genesis checksum mismatch");
        const bundle = this.snapshotDecoder(bytes);
        state = validateSnapshot(bundle.state, this.identity);
        if (stateHash(state) !== bundle.hash)
          throw new Error("Genesis state checksum mismatch");
        operations = Object.keys(state.receipts);
      } else {
        const events = added.filter((f) => f.path.startsWith("events/"));
        if (events.length !== 1) throw new Error("Expected one event envelope");
        const envelope = decode(
          await this.transport.readFile(commit.oid, events[0].path),
          64 * 1024 * 1024,
        );
        if (envelope.parent !== parent || envelope.protocol !== 1)
          throw new Error("Invalid event parent");
        if (envelope.kind === "checkpoint") {
          if (
            !snapshotPath(envelope.path) ||
            envelope.atCommit !== parent ||
            envelope.resultHash !== stateHash(state)
          )
            throw new Error("Invalid checkpoint");
          const snap = this.snapshotDecoder(
            await this.transport.readFile(commit.oid, envelope.path),
          );
          validateSnapshot(snap.state, this.identity);
          if (
            snap.atCommit !== parent ||
            stateHash(snap.state) !== envelope.resultHash
          )
            throw new Error("Invalid checkpoint snapshot");
        } else if (envelope.kind === "operations") {
          if (
            !Array.isArray(envelope.operations) ||
            !envelope.operations.length ||
            envelope.operations.length > this.maxOperations
          )
            throw new Error("Operation envelope exceeds count budget");
          state = reduceMany(state, envelope.operations, this.identity);
          operations = envelope.operations.map((op) => op.opId);
          if (stateHash(state) !== envelope.resultHash)
            throw new Error("Reducer result checksum mismatch");
        } else throw new Error("Unsupported event kind");
      }
      await this.images?.receive?.(state, commit.oid, this.transport);
      await this.store.commitCanonical(parent, commit.oid, state, operations, {
        previousState,
      });
      link = await this.store.readLink();
      await new Promise((r) => setTimeout(r, 0));
    }
    return link;
  }
  async initialize(link) {
    const head = await this.transport.readHead();
    if (head) return this.receive(link);
    const bundle = await this.store.bootstrap();
    const bytes = encodeSnapshot(bundle);
    const manifest = {
      protocol: 1,
      reducer: 1,
      ...this.identity,
      bootstrapId: link.bootstrap_id,
      genesis: "snapshots/genesis.json.gz",
      genesisHash: digest(bytes),
    };
    const files = {
      "manifest.json": canonical(manifest),
      "snapshots/genesis.json.gz": bytes,
      ...((await this.images?.publish?.(bundle.state)) || {}),
    };
    const oid = await this.transport.createCandidate(null, files);
    await this.store.saveBootstrap?.({ oid, bundleHash: digest(bytes) });
    await this.transport.publish(oid, null);
    return this.receive(link);
  }
  async cycle({ initialize = false, receiveOnly = false } = {}) {
    const owner = randomUUID();
    if (!(await this.store.acquire(owner))) return { busy: true };
    try {
      let link = await this.store.readLink();
      if (!link) return { mode: "unlinked" };
      if (["disconnected", "paused"].includes(link.mode)) {
        await this.status(link);
        return { mode: link.mode };
      }
      if (initialize && link.mode === "initializing")
        link = await this.initialize(link);
      else link = await this.receive(link);
      if (!receiveOnly && link.mode !== "recovery")
        for (let attempt = 0; attempt < 4; attempt++) {
          const pending = operationBatch(
            await this.store.readPending(),
            this.maxOperations,
          );
          if (!pending.length) break;
          let state = reduceMany(
            await this.store.readState(),
            pending,
            this.identity,
          );
          const parent = link.canonical_head;
          if (!parent) throw new Error("Initial publication required");
          const event = {
            protocol: 1,
            kind: "operations",
            parent,
            operations: pending,
            resultHash: stateHash(state),
          };
          const files = {
            ["events/" + randomUUID() + ".json"]: canonical(event),
            ...((await this.images?.publish?.(state)) || {}),
          };
          const oid = await this.transport.createCandidate(parent, files);
          try {
            await this.transport.publish(oid, parent);
          } catch (error) {
            await this.receive(await this.store.readLink());
            throw error;
          }
          link = await this.receive(await this.store.readLink());
          if (link.canonical_head === oid) break;
        }
      await this.status(link);
      await this.store.setError?.(null);
      return { head: link.canonical_head };
    } catch (error) {
      await this.store.setError?.(error.message);
      throw error;
    } finally {
      await this.store.release(owner);
    }
  }
  async status(link) {
    if (!link.canonical_head) return;
    const branch = "sync-status/" + link.installation_id;
    const previous = await this.transport.readHead(branch);
    let old = null;
    if (previous)
      old = decode(
        await this.transport.readFile(previous, "status.json"),
        64 * 1024,
      );
    const status = {
      ...this.identity,
      installationId: link.installation_id,
      writerEpoch: link.writer_epoch,
      appliedCanonicalHead: link.canonical_head,
      mode: link.mode,
      observedAt: new Date().toISOString(),
    };
    // Refresh liveness at most once a minute; status never enters the canonical chain.
    if (
      !old ||
      old.appliedCanonicalHead !== status.appliedCanonicalHead ||
      old.mode !== status.mode ||
      Date.now() - Date.parse(old.observedAt) > 60000
    ) {
      const oid = await this.transport.createCandidate(previous, {
        "status.json": canonical(status),
      });
      await this.transport.publish(oid, previous, branch);
    }
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
          (await this.transport.verifyReachable(
            link.canonical_head,
            remote.appliedCanonicalHead,
          ));
        remote.verifiedAgainstHead = link.canonical_head;
        await this.store.saveRemoteStatus?.(remote);
      }
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
      const envelope = {
        protocol: 1,
        kind: "checkpoint",
        parent: link.canonical_head,
        atCommit: link.canonical_head,
        path,
        resultHash: stateHash(state),
      };
      const oid = await this.transport.createCandidate(link.canonical_head, {
        [path]: encodeSnapshot({ atCommit: link.canonical_head, state }),
        ["events/" + randomUUID() + ".json"]: canonical(envelope),
      });
      await this.transport.publish(oid, link.canonical_head);
    } finally {
      await this.store.release(owner);
    }
    return this.run({ receiveOnly: true });
  }
}
