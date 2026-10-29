import { requireThat } from "./http-error.js";

// Read ZIP central-directory sizes before ExcelJS allocates the XML contents.
export function checkWorkbookArchive(buffer) {
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i--
  ) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  requireThat(end >= 0, 400, "올바른 XLSX 파일이 아닙니다.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16),
    expanded = 0;
  requireThat(
    count > 0 && count <= 10000 && offset < end,
    400,
    "지원하는 XLSX 파일 크기를 초과했습니다.",
  );
  for (let n = 0; n < count; n++) {
    requireThat(
      offset + 46 <= end && buffer.readUInt32LE(offset) === 0x02014b50,
      400,
      "XLSX 파일 구조를 확인할 수 없습니다.",
    );
    const size = buffer.readUInt32LE(offset + 24);
    expanded += size;
    requireThat(
      size <= 32 * 1024 * 1024 && expanded <= 150 * 1024 * 1024,
      400,
      "압축 해제 용량이 큽니다. 시트를 나누어 가져오세요.",
    );
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}
