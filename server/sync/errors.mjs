// Only protocol violations quarantine a connection. Transport/database failures
// remain retryable regardless of their human-readable message.
const recoveryCodes = new Set([
  "SYNC_HISTORY",
  "SYNC_IDENTITY",
  "SYNC_FORMAT",
  "SYNC_INTEGRITY",
  "EXTERNAL_SYNC_CAPACITY",
]);
export class ProtocolError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProtocolError";
    this.code = code;
  }
}
export class SyncInterruption extends Error {
  constructor(
    message = "동기화가 중단되었습니다. 미전송 변경은 보존되어 있습니다.",
  ) {
    super(message);
    this.name = "SyncInterruption";
    this.code = "SYNC_INTERRUPTED";
    this.status = 409;
  }
}
export const isSyncInterruption = (error) => error?.code === "SYNC_INTERRUPTED";
export const isRecoveryError = (error) => recoveryCodes.has(error?.code);
export const normalizeSyncError = (error) =>
  error == null
    ? null
    : {
        message: error.message || String(error),
        code: typeof error.code === "string" ? error.code : undefined,
      };
export function protocolValidation(work, code = "SYNC_FORMAT") {
  try {
    return work();
  } catch (error) {
    if (
      error instanceof ProtocolError ||
      error.code === "EXTERNAL_SYNC_CAPACITY"
    )
      throw error;
    throw new ProtocolError(code, error.message, { cause: error });
  }
}
