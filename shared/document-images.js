// Relative, authenticated URLs only. Never render arbitrary image/HTML URLs in
// the rich editor. Kept separate from the server's Markdown parser and storage.
export const DOCUMENT_IMAGE_PATTERN =
  /^\/api\/document-images\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([a-f0-9]{64})\.webp(?:#width=([1-9][0-9]{0,3}))?$/;
export function isDocumentImage(url) {
  const match = typeof url === "string" && DOCUMENT_IMAGE_PATTERN.exec(url);
  return !!match && (!match[3] || (+match[3] >= 32 && +match[3] <= 4096));
}
// A URL fragment preserves standard Markdown image syntax. It changes only
// the displayed width; uploads, HTTP requests and backups share the same file.
export const documentImageSource = (url) =>
  isDocumentImage(url) ? url.split("#")[0] : "";
export const documentImageWidth = (url) =>
  isDocumentImage(url)
    ? Number(DOCUMENT_IMAGE_PATTERN.exec(url)?.[3]) || null
    : null;
export function withDocumentImageWidth(url, width) {
  const source = documentImageSource(url);
  if (!source) return "";
  return width == null
    ? source
    : `${source}#width=${Math.max(32, Math.min(4096, Math.round(width)))}`;
}
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
