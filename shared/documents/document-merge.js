import { diffChars } from "diff";

// Bounded character diffs preserve independent edits within the same line,
// including Korean and emoji. Ambiguous replacements never discard a draft.
function edits(before, after) {
  const changes = diffChars(before, after, {
    timeout: 50,
    maxEditLength: 20000,
  });
  if (!changes) return null;
  const result = [];
  let offset = 0,
    pending = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (pending) result.push(pending);
      pending = null;
      offset += change.value.length;
    } else {
      pending ||= { start: offset, end: offset, text: "" };
      if (change.removed) {
        offset += change.value.length;
        pending.end = offset;
      } else pending.text += change.value;
    }
  }
  if (pending) result.push(pending);
  return result;
}

export function mergeDocument(base, local, remote) {
  if (local === remote || local === base) return remote;
  if (remote === base) return local;
  const ours = edits(base, local),
    theirs = edits(base, remote);
  if (!ours || !theirs) return null;
  const combined = [...theirs];
  for (const edit of ours) {
    let duplicate = false;
    for (const other of theirs) {
      if (
        edit.start === other.start &&
        edit.end === other.end &&
        edit.text === other.text
      ) {
        duplicate = true;
        break;
      }
      if (
        Math.max(edit.start, other.start) < Math.min(edit.end, other.end) ||
        (edit.start > other.start && edit.start < other.end) ||
        (other.start > edit.start && other.start < edit.end)
      )
        return null;
    }
    if (!duplicate) combined.push(edit);
  }
  // At a shared insertion point the saved text precedes the pending text.
  combined.sort((a, b) => a.start - b.start || a.end - b.end);
  let result = "",
    offset = 0;
  for (const edit of combined) {
    result += base.slice(offset, edit.start) + edit.text;
    offset = edit.end;
  }
  return result + base.slice(offset);
}

export function mapDocumentPosition(before, after, position) {
  const changes = edits(before, after);
  if (!changes) return Math.min(position, after.length);
  let delta = 0;
  for (const edit of changes) {
    if (position < edit.start) break;
    if (position <= edit.end) return edit.start + delta + edit.text.length;
    delta += edit.text.length - (edit.end - edit.start);
  }
  return position + delta;
}
