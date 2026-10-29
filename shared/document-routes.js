// HTTP path translation only. Authorization and storage belong to repositories.
export function documentRouteScope(path) {
  let m;
  if ((m = /^\/tasks\/([^/]+)\/(document|documents)(?:\/([^/]+))?$/.exec(path)))
    return {
      kind: "task",
      taskId: m[1],
      ...(m[2] === "document"
        ? { documentId: "main" }
        : m[3]
          ? { documentId: m[3] }
          : {}),
    };
  if (
    (m =
      /^\/reports\/([^/]+)\/tasks\/([^/]+)\/(document|documents)(?:\/([^/]+))?$/.exec(
        path,
      ))
  )
    return {
      kind: "report",
      reportId: m[1],
      taskId: m[2],
      ...(m[3] === "document"
        ? { documentId: "main" }
        : m[4]
          ? { documentId: m[4] }
          : {}),
    };
  if (
    (m = /^\/teams\/([^/]+)\/years\/([^/]+)\/memos(?:\/([^/]+))?$/.exec(path))
  )
    return {
      kind: "annual",
      teamId: m[1],
      year: Number(m[2]),
      ...(m[3] ? { documentId: m[3] } : {}),
    };
  if ((m = /^\/reports\/([^/]+)\/memos(?:\/([^/]+))?$/.exec(path)))
    return {
      kind: "reportMemo",
      reportId: m[1],
      ...(m[2] ? { documentId: m[2] } : {}),
    };
  if ((m = /^\/calendar\/entries\/([^/]+)\/document$/.exec(path)))
    return { kind: "calendar", entryId: m[1], documentId: "main" };
  return null;
}
