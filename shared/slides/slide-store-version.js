// Runtime manifest of the external slide store, kept apart from the Node-only
// migration loader so the Edge bundle can check it. One checksum per released
// migration step, in order; a released step is never edited.
export const SLIDE_SCHEMA = "graeboard_slides";
export const SLIDE_SCHEMA_CHECKSUMS = Object.freeze([
  "5eb6561dd72a4e2285bf747590dadca3da5519a9180fed65da725ee1b757771d",
  "857e06a0b876a27de7ae6b9b0ad25d308965bf37ca113a5b6e9794c7e2c83e09",
]);
export const SLIDE_SCHEMA_VERSION = SLIDE_SCHEMA_CHECKSUMS.length;

// The history of a store up to `version` steps, exactly as this code knows it.
export function slideSchemaVersion(rows) {
  const valid =
    rows.length >= 1 &&
    rows.length <= SLIDE_SCHEMA_VERSION &&
    rows.every(
      (row, index) =>
        Number(row.version) === index + 1 &&
        row.checksum === SLIDE_SCHEMA_CHECKSUMS[index],
    );
  return valid ? rows.length : 0;
}
// The store is usable only at the current version.
export const slideSchemaReady = (rows) =>
  slideSchemaVersion(rows) === SLIDE_SCHEMA_VERSION;
