export type SyncLogLevel = "changes" | "cycles" | "git";

// One line of the internal server's synchronization log
// (server/sync/node/sync-log.mjs). `line` is its position in the day's file.
export type SyncLogEntry = {
  at: string;
  line: number;
  kind: "cycle" | "git" | "action" | "state" | "server" | "worker" | "image";
  ok?: boolean;
  ms?: number;
  // cycle
  action?: string;
  recovered?: boolean;
  busy?: boolean;
  receiveOnly?: boolean;
  initialize?: boolean;
  mode?: string;
  head?: string | null;
  headBefore?: string | null;
  commits?: number;
  received?: boolean;
  published?: boolean;
  pending?: number;
  pendingBefore?: number;
  conflicts?: number;
  peerHead?: string | null;
  peerObservedAt?: string | null;
  peerVerified?: boolean;
  error?: { message: string; code?: string | number; status?: number };
  // git
  command?: string;
  args?: string;
  code?: string | number | null;
  stderr?: string;
  inputBytes?: number;
  timedOut?: boolean;
  aborted?: boolean;
  // action
  actor?: { id: string; name: string };
  // state, log-level
  change?: "mode" | "conflicts";
  from?: string | number;
  to?: string | number;
  reason?: string;
  // server, worker
  event?: string;
  pid?: number;
  node?: string;
  // image
  path?: string;
};

export type SyncLogPage = {
  level: SyncLogLevel;
  levels: SyncLogLevel[];
  canSetLevel: boolean;
  retentionDays: number;
  date: string;
  dates: string[];
  entries: SyncLogEntry[];
  next: number | null;
};
