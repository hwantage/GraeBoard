// Rules for team slide files shared by the browser, the internal Node API and
// the external API: one stored unit is a standard `.canvaslide` file whose
// bytes GraeBoard never reinterprets.
export const SLIDE_FILE_EXTENSION = "canvaslide";
// One limit for both sites, inside the external API's request limit, so a file
// saved on either side can always be stored on the other.
export const MAX_SLIDE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SLIDE_TITLE_LENGTH = 120;
// Temporary share snapshots: the editor's own share protocol limits.
export const MAX_SLIDE_SHARE_BYTES = 5 * 1024 * 1024;
export const SLIDE_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

// A card thumbnail is a JPEG data URL of at most this many characters, so its
// stored bytes are fewer.
export const MAX_SLIDE_THUMBNAIL_LENGTH = 160 * 1024;
// The drawing version of stored card thumbnails. Each site keeps a thumbnail
// under the content it shows and this number. Raise it by one whenever
// scripts/canvaslide/frame/slide-card-render.ts changes what a card looks
// like: pictures stored under an older number are no longer served, so every
// card is drawn again once. An editor update alone is no reason to raise it.
// Never lower it or skip a number: the thumbnails of content that is no longer
// kept are removed under every number from 1 to this one.
export const SLIDE_THUMBNAIL_VERSION = 1;
export const slideThumbnailName = (contentHash, version) =>
  `${contentHash}.v${version}.thumbnail`;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function slideTitleProblem(value) {
  if (typeof value !== "string") return "자료 이름을 입력하세요.";
  const title = value.trim();
  if (!title) return "자료 이름을 입력하세요.";
  if (
    title.length > MAX_SLIDE_TITLE_LENGTH ||
    normalizeSlideTitle(title).length > MAX_SLIDE_TITLE_LENGTH
  )
    return `자료 이름은 ${MAX_SLIDE_TITLE_LENGTH}자까지 쓸 수 있습니다.`;
  if (CONTROL_CHARACTERS.test(title))
    return "자료 이름에 쓸 수 없는 문자가 있습니다.";
  return "";
}
// Reserve room for the suffix without cutting an emoji's surrogate pair.
export function slideCopyTitle(title) {
  const suffix = " 사본";
  const stem = title
    .slice(0, MAX_SLIDE_TITLE_LENGTH - suffix.length)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
  return stem + suffix;
}
export const normalizeSlideTitle = (value) => value.trim().normalize("NFC");

// A name the title can be downloaded under on macOS and Windows.
export function slideDownloadName(title) {
  const stem = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return `${stem || "slides"}.${SLIDE_FILE_EXTENSION}`;
}
export function slideTitleFromFileName(name) {
  return name.replace(/\.(?:canvaslide|json)$/i, "").trim();
}

export const isSlideRequestId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
export const isSlideShareId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{21}$/.test(value);

// The format itself is checked by the editor's codec when a file is opened or
// saved. The server only refuses bytes that cannot be a `.canvaslide` file: it
// is one UTF-8 JSON object.
export function slideFileProblem(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    return "빈 파일은 저장할 수 없습니다.";
  if (bytes.byteLength > MAX_SLIDE_FILE_BYTES)
    return `자료는 ${MAX_SLIDE_FILE_BYTES / 1024 / 1024}MB까지 저장할 수 있습니다.`;
  const blank = (byte) =>
    byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
  let start = 0;
  let end = bytes.byteLength - 1;
  while (start < end && blank(bytes[start])) start++;
  while (end > start && blank(bytes[end])) end--;
  if (bytes[start] !== 0x7b || bytes[end] !== 0x7d)
    return "CanvaSlide 자료 형식이 아닙니다.";
  return "";
}

// The name stored bytes are kept and verified under: their SHA-256 in
// lowercase hex. WebCrypto hashes away from the calling thread on Node, so
// hashing a 25MiB file does not hold up the other requests of the internal
// site's single process.
export async function slideContentHash(bytes) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
