// Keep image bytes scoped to one object upload. An image-rich command must not
// retain every WebP in the Worker heap while preparing its immutable Git tree.
export async function* fileEntries(files) {
  files = await files;
  if (!files) return;
  if (files[Symbol.asyncIterator] || files[Symbol.iterator]) yield* files;
  else yield* Object.entries(files);
}
export async function* combineFileEntries(...sources) {
  for (const source of sources) yield* fileEntries(source);
}
