export function setupGuideHtml(source) {
  const guide = source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return (
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GraeBoard Cloud Setup</title><style>body{max-width:80ch;margin:2rem auto;padding:1rem;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>' +
    guide +
    "</pre>"
  );
}
