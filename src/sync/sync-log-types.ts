export type SyncLogLevel = "changes" | "cycles" | "git";

// One line of the internal server's synchronization log
// (server/sync/node/sync-log.mjs) or bounded Supabase logs from Edge.
// `line` is the internal file position or an external log's stable UUID.
export type SyncLogEntry = {
  at: string;
  line: number | string;
  kind:
    | "cycle"
    | "git"
    | "action"
    | "state"
    | "server"
    | "worker"
    | "image"
    | "external";
  message?: string;
  phase?: string;
  executionId?: string;
  cpuMs?: number;
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
  source?: "supabase";
  level: SyncLogLevel;
  levels: SyncLogLevel[];
  canSetLevel: boolean;
  retentionDays: number;
  date: string;
  dates: string[];
  entries: SyncLogEntry[];
  next: number | string | null;
};
