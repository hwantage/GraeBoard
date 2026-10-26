// Only protocol violations quarantine a connection. Transport/database failures
// remain retryable regardless of their human-readable message.
const recoveryCodes = new Set([
  "SYNC_HISTORY",
  "SYNC_IDENTITY",
  "SYNC_FORMAT",
  "SYNC_INTEGRITY",
]);
export class ProtocolError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProtocolError";
    this.code = code;
  }
}
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
