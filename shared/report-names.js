// Share copy name limits and comparison between the browser and server.
export const MAX_REPORT_NAME_LENGTH = 50;
export const normalizeReportName = (name) => name.trim().normalize("NFC");
export const DUPLICATE_REPORT_NAME =
  "같은 이름의 사본이 있습니다. 다른 이름을 입력하세요.";
