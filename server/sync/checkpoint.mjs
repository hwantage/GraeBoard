import {
  canonical,
  digest,
  stateHash,
  protocolVersion,
  supportedVersion,
} from "./protocol.mjs";
import { validateSnapshot } from "./reducer.mjs";
import { prepareStatePatch } from "../../shared/sync-team-store.mjs";
import { ProtocolError, protocolValidation } from "./errors.mjs";

export const snapshotCounts = (state) => ({
  entities: Object.keys(state.entities).length,
  receipts: Object.keys(state.receipts).length,
  conflicts: Object.keys(state.conflicts).length,
});
const invalid = (message) => {
  throw new ProtocolError("SYNC_INTEGRITY", message);
};
const json = (bytes) =>
  protocolValidation(() => {
    if (!bytes || bytes.byteLength > 64 * 1024 * 1024)
      throw new Error("Invalid checkpoint JSON size");
    return JSON.parse(new TextDecoder().decode(bytes));
  });

// Repository writers are trusted checkpoint authors. Hashes validate the bound
// snapshot, not a claim that this importer independently replayed its prefix.
// Healthy active replicas must always use ordinary per-commit reduction.
export async function loadCheckpoint(service, link, pinnedHead) {
  const { transport, identity, store } = service;
  if (!transport.latestSnapshot) return link;
  if (!["importing", "recovery"].includes(link.mode))
    throw new Error("Checkpoint load requires a drained import/recovery");
  const oid = await transport.latestSnapshot(pinnedHead);
  if (!oid || oid === link.canonical_head) return link;
  const commit = await transport.readCommit(oid);
  if (!commit.parents.length) return link; // Genesis remains the compatible fallback.
  const parent = commit.parents[0];
  await service.checkCommit(oid, parent);
  if (
    !(await transport.verifyReachable(oid, pinnedHead)) ||
    (link.canonical_head &&
      !(await transport.verifyReachable(link.canonical_head, parent)))
  )
    throw new ProtocolError(
      "SYNC_HISTORY",
      "Checkpoint is not compatible with the pinned canonical history",
    );
  const added = await service.verifyFiles(commit, parent);
  const events = added.filter((file) => file.path.startsWith("events/"));
  if (events.length !== 1) invalid("Invalid checkpoint event count");
  const envelope = json(await transport.readFile(oid, events[0].path));
  if (envelope.kind !== "checkpoint") return link;
  if (envelope.protocol > service.maxProtocol)
    throw new ProtocolError(
      "SYNC_VERSION",
      "Unsupported checkpoint protocol; canonical cursor is unchanged",
    );
  // Older checkpoints lacked a complete manifest and remain replayable, but
  // cannot serve as a shortcut for a new site's trust boundary.
  if (envelope.checkpointVersion === undefined) return link;
  if (envelope.checkpointVersion !== 1)
    throw new ProtocolError("SYNC_FORMAT", "Unsupported checkpoint version");
  if (
    !envelope.counts ||
    typeof envelope.counts !== "object" ||
    Object.keys(envelope.counts).length !== 3 ||
    !["entities", "receipts", "conflicts"].every(
      (key) =>
        Number.isSafeInteger(envelope.counts[key]) && envelope.counts[key] >= 0,
    ) ||
    !/^[a-f0-9]{64}$/.test(envelope.snapshotHash || "") ||
    !/^[a-f0-9]{64}$/.test(envelope.resultHash || "")
  )
    invalid("Incomplete checkpoint manifest");
  const manifest = json(await transport.readFile(oid, "manifest.json"));
  for (const [field, value] of Object.entries({
    teamId: identity.teamId,
    repoId: identity.repoId,
    bootstrapId: link.bootstrap_id,
  })) {
    if (manifest[field] !== value || envelope[field] !== value)
      throw new ProtocolError(
        "SYNC_IDENTITY",
        "Checkpoint repository identity mismatch",
      );
  }
  if (
    manifest.protocol !== 1 ||
    manifest.reducer !== 1 ||
    !supportedVersion(envelope.protocol, envelope.reducer)
  )
    throw new ProtocolError("SYNC_VERSION", "Unsupported checkpoint protocol");
  if (
    envelope.parent !== parent ||
    envelope.atCommit !== parent ||
    !/^snapshots\/[a-zA-Z0-9-]+\.json\.gz$/.test(envelope.path) ||
    !added.some((file) => file.path === envelope.path) ||
    added.length !== 2
  )
    invalid("Invalid checkpoint parent or manifest");
  const bytes = await transport.readFile(oid, envelope.path);
  if (!bytes || digest(bytes) !== envelope.snapshotHash)
    invalid("Checkpoint byte checksum mismatch");
  const bundle = protocolValidation(() => service.snapshotDecoder(bytes));
  const state = protocolValidation(() =>
    validateSnapshot(bundle.state, identity),
  );
  if (
    protocolVersion(state) !== envelope.protocol ||
    bundle.atCommit !== parent ||
    stateHash(state) !== envelope.resultHash ||
    canonical(snapshotCounts(state)) !== canonical(envelope.counts)
  )
    invalid("Checkpoint state checksum or counts mismatch");
  service.assertCapacity?.(state);
  // The checkpoint's claimed canonical hash is also bound to its parent's
  // recorded reducer result; atCommit is not merely an arbitrary ancestor.
  const parentCommit = await transport.readCommit(parent);
  let parentHash;
  if (!parentCommit.parents.length) {
    const genesisBytes = await transport.readFile(parent, manifest.genesis);
    if (!genesisBytes || digest(genesisBytes) !== manifest.genesisHash)
      invalid("Checkpoint genesis checksum mismatch");
    parentHash = protocolValidation(() =>
      service.snapshotDecoder(genesisBytes),
    ).hash;
  } else {
    await service.checkCommit(parent, parentCommit.parents[0]);
    const parentAdded = await service.verifyFiles(
      parentCommit,
      parentCommit.parents[0],
    );
    const parentEvents = parentAdded.filter((file) =>
      file.path.startsWith("events/"),
    );
    if (parentEvents.length !== 1)
      invalid("Checkpoint parent event count mismatch");
    parentHash = json(
      await transport.readFile(parent, parentEvents[0].path),
    ).resultHash;
  }
  if (parentHash !== envelope.resultHash)
    invalid("Checkpoint parent result checksum mismatch");
  const previousState = await store.readState();
  // Existing receipts, tombstones and conflicts cannot disappear or change.
  protocolValidation(
    () => prepareStatePatch(previousState, state),
    "SYNC_INTEGRITY",
  );
  for (const operation of await store.readPending()) {
    const receipt = state.receipts[operation.opId];
    if (receipt && receipt.payloadHash !== digest(operation))
      invalid("Checkpoint pending receipt payload mismatch");
  }
  if (link.canonical_head)
    await service.verifyFiles(commit, link.canonical_head);
  // Pin the immutable manifest to the observed ref, detecting changed identity
  // even if the latest checkpoint itself still belongs to the old repository.
  if (
    canonical(manifest) !==
    canonical(json(await transport.readFile(pinnedHead, "manifest.json")))
  )
    throw new ProtocolError(
      "SYNC_IDENTITY",
      "Checkpoint manifest changed at canonical head",
    );
  await service.images?.receive?.(state, oid, transport, {
    added: commit.files,
  });
  const currentHead = await transport.readHead();
  if (!(await transport.verifyReachable(pinnedHead, currentHead)))
    throw new ProtocolError(
      "SYNC_HISTORY",
      "Canonical head moved outside pinned checkpoint history",
    );
  await store.commitCanonical(
    link.canonical_head || null,
    oid,
    state,
    Object.keys(state.receipts),
    { previousState },
  );
  return store.readLink();
}
