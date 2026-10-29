// Both publishers must leave room for the immutable event envelope before an
// operation is committed locally. The external receiver accepts at most 4 MiB.
export const SYNC_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const SYNC_ENVELOPE_RESERVE_BYTES = 1024;
export const SYNC_OPERATION_MAX_BYTES =
  SYNC_FILE_MAX_BYTES - SYNC_ENVELOPE_RESERVE_BYTES - 1;
export const SYNC_RECEIPT_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_RECEIPT_WARNING_BYTES = 12 * 1024 * 1024;
export const SYNC_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
