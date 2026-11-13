// Both publishers must leave room for the immutable event envelope before an
// operation is committed locally. Each event file is limited to 32 MiB so that
// one user command, such as copying a large sheetClone, always fits in one event.
// The team state as a whole has no budget (see capacityLimits).
export const SYNC_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const SYNC_ENVELOPE_RESERVE_BYTES = 1024;
// How much one published event gathers. A command larger than this still goes
// out whole, but alone: the site receiving it holds the event in memory, and
// several edits of one sheet copy (megabytes each) in one event exceeded the
// hosted site's memory. Small commands still share an event.
export const SYNC_EVENT_BATCH_BYTES = 1024 * 1024;
export const SYNC_OPERATION_MAX_BYTES =
  SYNC_FILE_MAX_BYTES - SYNC_ENVELOPE_RESERVE_BYTES - 1;
export const SYNC_RECEIPT_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_RECEIPT_WARNING_BYTES = 12 * 1024 * 1024;
// Include the state, its separate 16 MiB receipt budget and bundle metadata.
export const SYNC_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
