import { requireThat } from "./http-error.js";

// Share copy name limits and comparison between the browser and server.
export const MAX_SHEET_CLONE_NAME_LENGTH = 50;
export const normalizeSheetCloneName = (name) => name.trim().normalize("NFC");
export const DUPLICATE_SHEET_CLONE_NAME =
  "같은 이름의 사본이 있습니다. 다른 이름을 입력하세요.";
// A copy name is unique in its team after normalization. Stored names are
// normalized too, so a name saved in another form (decomposed Korean text) is
// still the same name. Both sites refuse with the same message and code.
export function requireFreeSheetCloneName(storedNames, name) {
  requireThat(
    !storedNames.some((stored) => normalizeSheetCloneName(stored) === name),
    409,
    DUPLICATE_SHEET_CLONE_NAME,
    { code: "DUPLICATE_SHEET_CLONE_NAME" },
  );
}
