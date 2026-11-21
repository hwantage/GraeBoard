/**
 * Which GraeBoard team file the open document saves to.
 *
 * The binding travels in the editor's own `filePath`: every way the editor
 * replaces its document (new, open, example, share link, recovery) already sets
 * that field, so a document that is not a team file can never inherit the
 * previous one's save target, and a recovery copy keeps the revision it was
 * edited from.
 */
import type { FilePath } from "@/platform/file-path";

const SCHEME = "graeboard-slides:";

export type TeamFileBinding = {
  teamId: string;
  /** Null until the first save gives a new team file its ID. */
  fileId: string | null;
  /** The server revision this document was opened from or last saved as. */
  revision: number;
  title: string;
};

export function bindingPath(binding: TeamFileBinding): string {
  const query = new URLSearchParams({
    revision: String(binding.revision),
    title: binding.title,
  });
  return `${SCHEME}//${encodeURIComponent(binding.teamId)}/${encodeURIComponent(binding.fileId ?? "new")}?${query.toString()}`;
}

export function parseBinding(
  path: FilePath | null | undefined,
): TeamFileBinding | null {
  if (typeof path !== "string" || !path.startsWith(`${SCHEME}//`)) {
    return null;
  }
  const [location = "", query = ""] = path.slice(SCHEME.length + 2).split("?");
  const [team = "", file = ""] = location.split("/");
  const values = new URLSearchParams(query);
  const revision = Number(values.get("revision"));
  if (!team || !file || !Number.isInteger(revision) || revision < 0) {
    return null;
  }
  const fileId = decodeURIComponent(file);
  return {
    teamId: decodeURIComponent(team),
    fileId: fileId === "new" ? null : fileId,
    revision,
    title: values.get("title") ?? "",
  };
}
