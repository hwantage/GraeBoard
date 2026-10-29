export type SyncStatus = {
  mode:
    | "unlinked"
    | "initializing"
    | "importing"
    | "active"
    | "paused"
    | "recovery"
    | "disconnected";
  siteId?: string;
  siteName?: string;
  profileId?: string;
  canReconnect?: boolean;
  canonicalHead?: string | null;
  canonicalHash?: string | null;
  protocol?: 1 | 2;
  receiptCapacity?: {
    bytes: number;
    limitBytes: number;
    warningBytes: number;
    warning: boolean;
    blocked: boolean;
  };
  pending: number;
  conflicts: number;
  lastLocalSavedAt?: string | null;
  lastReceivedAt?: string | null;
  lastPublishedAt?: string | null;
  lastError?: string | null;
  remoteStatus?: {
    observedAt: string;
    mode: string;
    appliedCanonicalHead: string;
    verified: boolean;
  } | null;
};

export const syncTime = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
    : "아직 없음";
