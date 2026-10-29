import { canonical, digest } from "../server/sync/protocol.mjs";

// Stable ordering and a closed table allowlist are shared by offline transfer,
// complete backups and the Worker profile-switch workflow.
export const TEAM_TRANSFER_TABLES = [
  ["teams", "id"],
  ["team_sync_links", "team_id"],
  ["sync_entities", "entity,entity_key"],
  ["sync_outbox", "local_seq"],
  ["sync_receipts", "op_id"],
  ["sync_conflicts", "conflict_id"],
  ["sync_objects", "hash"],
  ["sync_person_refs", "person_id"],
  ["site_retention", "site_id,kind,entity_key,generation"],
  ["site_maintenance_jobs", "job_id"],
  ["site_entity_revisions", "entity,entity_key"],
  ["site_events", "cursor"],
  ["site_entities", "entity,entity_key"],
  ["site_audit", "id"],
  ["site_operations", "op_id"],
];
export function portableRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value instanceof Uint8Array)
        return [key, { $bytes: Buffer.from(value).toString("base64") }];
      if (typeof value === "bigint") {
        const n = Number(value);
        if (!Number.isSafeInteger(n))
          throw new Error("Unsafe database integer");
        return [key, n];
      }
      // pg returns bigint columns as strings. Normalize only known numeric fields.
      if (
        (["local_seq", "cursor", "revision", "lease_until"].includes(key) ||
          (key === "generation" && row.repo_id !== undefined)) &&
        typeof value === "string" &&
        /^\d+$/.test(value)
      ) {
        const n = Number(value);
        if (Number.isSafeInteger(n)) return [key, n];
      }
      return [key, value];
    }),
  );
}
export const databaseRow = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v &&
      typeof v === "object" &&
      Object.keys(v).length === 1 &&
      typeof v.$bytes === "string"
        ? Buffer.from(v.$bytes, "base64")
        : v,
    ]),
  );
export const portableHash = (value) => digest(canonical(value));
export function sealTransfer(payload) {
  return {
    format: "graeboard-team-transfer",
    version: 1,
    payload,
    hash: portableHash(payload),
  };
}
export function verifyTransfer(bundle) {
  if (
    bundle?.format !== "graeboard-team-transfer" ||
    bundle.version !== 1 ||
    portableHash(bundle.payload) !== bundle.hash
  )
    throw new Error("Logical transfer checksum or version mismatch");
  const p = bundle.payload;
  if (
    typeof p.teamId !== "string" ||
    !p.tables ||
    Object.keys(p.tables).some(
      (name) => !TEAM_TRANSFER_TABLES.some(([table]) => table === name),
    )
  )
    throw new Error("Invalid logical transfer tables");
  for (const [table] of TEAM_TRANSFER_TABLES) {
    if (!Array.isArray(p.tables[table]))
      throw new Error("Missing logical table " + table);
    for (const row of p.tables[table]) {
      if (Object.keys(row).some((key) => !/^[_a-z]+$/.test(key)))
        throw new Error("Invalid logical column");
      if (table === "teams" ? row.id !== p.teamId : row.team_id !== p.teamId)
        throw new Error("Foreign team in logical transfer");
    }
  }
  if (p.tables.teams.length !== 1 || p.tables.team_sync_links.length > 1)
    throw new Error("Invalid team transfer identity");
  return p;
}
