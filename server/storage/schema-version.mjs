// Runtime manifest: kept separate from the Node-only migration loader for Workers.
export const POSTGRES_CHECKSUMS = Object.freeze({
  control: "4fd51af986baa021025c0be7a8bccbabfb57e6f756db81826aa53e5acaccf52a",
  team: "fa8f2cbdd8db268cc984ea3a516a67ec21b068482cccc665834dd380a2b9c2e3",
  site: "3d7c378b0c446e515e8f2615ce5f8e7321086e150433fe80801f7c0da37ab58d",
});

export function postgresLayout(scope, site = false) {
  if (!["control", "team"].includes(scope))
    throw new Error("Invalid PostgreSQL scope");
  return scope === "control" && site
    ? { schema: "graeboard_site", migrationScope: "site" }
    : { schema: "graeboard", migrationScope: scope };
}

export const SITE_KEY_CHECKSUM =
  "36ac6929900353521f57dda03ab45d11066ad869329d5efa4bcea251029974ad";
export function postgresHistoryVersion(
  rows,
  scope,
  { allowPreviousSite = false } = {},
) {
  const expected = [
    POSTGRES_CHECKSUMS[scope],
    ...(scope === "site" ? [SITE_KEY_CHECKSUM] : []),
  ];
  const length =
    allowPreviousSite && scope === "site" && rows.length === 1
      ? 1
      : expected.length;
  if (
    !POSTGRES_CHECKSUMS[scope] ||
    rows.length !== length ||
    rows.some(
      (row, index) =>
        row.scope !== scope ||
        Number(row.version) !== index + 1 ||
        row.checksum !== expected[index],
    )
  )
    throw new Error("PostgreSQL schema scope/version/checksum mismatch");
  return length;
}
