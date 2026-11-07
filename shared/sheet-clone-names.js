// Share copy name limits and comparison between the browser and server.
export const MAX_SHEET_CLONE_NAME_LENGTH = 50;
export const normalizeSheetCloneName = (name) => name.trim().normalize("NFC");
export const DUPLICATE_SHEET_CLONE_NAME =
  "같은 이름의 사본이 있습니다. 다른 이름을 입력하세요.";
