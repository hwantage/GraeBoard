import { documentImageUrls } from "./document-image-references.js";
export function syncImageReferences(state) {
  const markdowns = [];
  for (const e of Object.values(state.entities))
    if (e.entity === "document") markdowns.push(e.payload.markdown);
  for (const c of Object.values(state.conflicts))
    if (!c.resolution)
      for (const change of c.operation.changes)
        if (change.entity === "document") {
          if (change.base?.markdown) markdowns.push(change.base.markdown);
          if (change.desired?.markdown) markdowns.push(change.desired.markdown);
        }
  return [...new Set(markdowns.flatMap(documentImageUrls))];
}
