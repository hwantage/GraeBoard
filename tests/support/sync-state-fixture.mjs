import {
  entityId,
  protocolMarker,
  PROTOCOL,
} from "../../server/sync/core/protocol.mjs";

// An empty canonical state of the current protocol: every C names its
// protocol, so a hand-built genesis carries the marker the bootstrap writes.
export const markedState = (version = PROTOCOL, token = "test-protocol") => ({
  entities: { [entityId("protocol", [])]: protocolMarker(version, token) },
  receipts: {},
  conflicts: {},
});
