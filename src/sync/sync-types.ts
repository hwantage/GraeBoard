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

export const syncModeNames: Record<SyncStatus["mode"], string> = {
  unlinked: "미연결",
  initializing: "초기 게시 중",
  importing: "가져오는 중",
  active: "동기화 중",
  paused: "일시정지",
  recovery: "복구 점검 필요",
  disconnected: "연결 해제",
};
