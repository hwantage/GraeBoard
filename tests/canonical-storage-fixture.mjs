// Adapter contract fixture only. Production SQLite commits use the snapshot/lease
// guarded Node mutation bridge, never this generic transaction helper.
import { prepareStatePatch } from "../shared/sync-team-store.mjs";
import { digest } from "../server/sync/protocol.mjs";
export function commitCanonicalForTest(
  adapter,
  teamId,
  expectedHead,
  newHead,
  state,
  ackOpIds,
  materialize,
  options = {},
) {
  if (adapter.engine !== "sqlite")
    return adapter.commitCanonical(
      teamId,
      expectedHead,
      newHead,
      state,
      ackOpIds,
      materialize,
      options,
    );
  if (materialize?.constructor.name === "AsyncFunction")
    throw new Error("SQLite materializer must be synchronous");
  const previous =
    options.previousState || (options.patch ? null : adapter.readState(teamId));
  const patch = options.patch || prepareStatePatch(previous, state);
  const hash = options.stateHash || digest(state);
  return adapter.withTeamTransaction(teamId, (tx) => {
    if (tx.sync.readLink()?.canonical_head !== expectedHead)
      throw new Error("Canonical head changed; recompute before retry");
    tx.sync.writeState(state, newHead, previous, patch);
    tx.sync.acknowledge(ackOpIds);
    const pending = tx.sync.readPending();
    const result = materialize?.(tx, {
      state,
      pending,
      exclusions: tx.sync.readExclusions(),
    });
    if (result && typeof result.then === "function") {
      result.catch(() => {});
      throw new Error("SQLite materializer must not return promises");
    }
    tx.sync.advanceHead(expectedHead, newHead, hash);
    return result;
  });
}
