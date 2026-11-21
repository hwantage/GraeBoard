// Runtime manifest of the external slide store, kept apart from the Node-only
// migration loader so the Edge bundle can check it.
export const SLIDE_SCHEMA = "graeboard_slides";
export const SLIDE_SCHEMA_VERSION = 1;
export const SLIDE_SCHEMA_CHECKSUM =
  "5eb6561dd72a4e2285bf747590dadca3da5519a9180fed65da725ee1b757771d";

// The store is usable only with exactly this history.
export function slideSchemaReady(rows) {
  return (
    rows.length === 1 &&
    Number(rows[0].version) === SLIDE_SCHEMA_VERSION &&
    rows[0].checksum === SLIDE_SCHEMA_CHECKSUM
  );
}
