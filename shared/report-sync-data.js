import { pack, unpack } from "./compact.js";

// 사본(report) 엔티티의 payload.data는 SQLite BLOB·HTTP 응답과 같은 공유 사전 형태
// `{ $styles, $formats, $data }`로 동기화한다. 업무마다 반복되는 공통 서식 규칙과
// 셀 서식을 한 번만 기록하며, 사전이 필요 없는 작은 사본은 pack이 평문을 그대로 둔다.
// 같은 내용이 사이트마다 같은 바이트가 되도록 키를 정렬한 뒤 번호를 매긴다.
// 기존 이벤트·기준본의 평문 data는 그대로 읽는다.
const REQUEST_STYLE_LIMIT = 50001;

// An object reached twice (the formatting rules every task under them shares)
// sorts once and stays shared, so pack() references it instead of
// serializing it again for each task.
function sortKeys(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  let sorted = value;
  if (Array.isArray(value)) sorted = value.map((item) => sortKeys(item, seen));
  else if (Object.getPrototypeOf(value) === Object.prototype)
    sorted = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key], seen)]),
    );
  seen.set(value, sorted);
  return sorted;
}

export const isPackedReportData = (data) =>
  !!data &&
  typeof data === "object" &&
  !Array.isArray(data) &&
  Object.hasOwn(data, "$styles");

// v2 부모 사본(행 배열이 없는 data)은 평문 그대로 둔다. 행·셀은 별도 엔티티다.
export const packReportData = (data) =>
  isPackedReportData(data) || !Array.isArray(data?.tasks)
    ? data
    : pack(sortKeys(data));

export const unpackReportData = (data, options = {}) =>
  isPackedReportData(data)
    ? unpack(data, { maxStyles: REQUEST_STYLE_LIMIT, ...options })
    : data;

export const packReportPayload = (payload) =>
  payload && isPackedReportData(payload.data) === false && payload.data
    ? { ...payload, data: packReportData(payload.data) }
    : payload;

export const unpackReportPayload = (payload) =>
  payload && isPackedReportData(payload.data)
    ? { ...payload, data: unpackReportData(payload.data) }
    : payload;

// 동기화 기준본·로컬 투영·명령 base를 비교할 때 표현 형식(평문/공유 사전)에 영향받지 않게 한다.
export const normalizeEntityPayload = (entity, payload) =>
  entity === "report" ? unpackReportPayload(payload) : payload;
