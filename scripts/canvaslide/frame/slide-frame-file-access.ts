/**
 * GraeBoard's replacement for the editor's `platform/document-file-access`.
 *
 * Everything is the upstream module except Save: a document bound to a team
 * file is encoded with the editor's own codec and handed to GraeBoard, and the
 * editor's save command completes only after the server stored it. Local files
 * keep the upstream pickers and downloads.
 */
import * as upstream from "graeboard-upstream:document-file-access";
import type {
  SavedDocument,
  SaveTarget,
} from "graeboard-upstream:document-file-access";
import { encodeDocumentFile } from "@/lib/workers/document-file-codec";
import type { CanvasDocument } from "@shared/canvas/element-types";
import {
  bindingPath,
  parseBinding,
  type TeamFileBinding,
} from "./slide-frame-binding";
import { hosted, HostShownError, requestHost } from "./slide-frame-host";

export * from "graeboard-upstream:document-file-access";

type StoredFile = {
  teamId: string;
  fileId: string;
  revision: number;
  title: string;
};
type SaveTargetChoice =
  { kind: "team"; title: string } | { kind: "device" } | null;

const requestId = (): string =>
  crypto.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

async function storeTeamFile(
  document: CanvasDocument,
  binding: Pick<TeamFileBinding, "fileId" | "revision" | "title">,
  title: string,
): Promise<SavedDocument | null> {
  const bytes = await encodeDocumentFile(
    document.name === title ? document : { ...document, name: title },
  );
  const payload = { requestId: requestId(), title, bytes };
  // Null: the author cancelled, or chose to reopen the newer team file. The
  // document then stays unsaved, exactly like a dismissed file picker.
  const file =
    binding.fileId === null
      ? await requestHost<StoredFile | null>("create", payload)
      : await requestHost<StoredFile | null>("save", {
          ...payload,
          fileId: binding.fileId,
          baseRevision: binding.revision,
          baseTitle: binding.title,
        });
  return file ? { filePath: bindingPath(file) } : null;
}

export async function saveDocumentFile(
  document: CanvasDocument,
  target: SaveTarget,
  forcePrompt = false,
): Promise<SavedDocument | null> {
  if (!hosted) {
    return upstream.saveDocumentFile(document, target, forcePrompt);
  }
  const binding = parseBinding(target.filePath);
  if (forcePrompt) {
    const choice = await requestHost<SaveTargetChoice>("save-target", {
      name: document.name,
      bound: binding !== null,
    });
    if (!choice) {
      return null;
    }
    if (choice.kind === "team") {
      return storeTeamFile(
        document,
        {
          fileId: null,
          revision: 0,
          title: choice.title,
        },
        choice.title.trim().normalize("NFC"),
      );
    }
    if (!binding) {
      return upstream.saveDocumentFile(document, target, true);
    }
    // A copy for this device: the open document stays the team file, still unsaved there.
    await upstream.saveDocumentFile(
      document,
      { filePath: null, fileHandle: null },
      true,
    );
    return null;
  }
  return binding
    ? storeTeamFile(document, binding, document.name.trim().normalize("NFC"))
    : upstream.saveDocumentFile(document, target, false);
}

/** The parent already told the author about a failed team save. */
export async function reportError(error: unknown): Promise<void> {
  if (!(error instanceof HostShownError)) {
    await upstream.reportError(error);
  }
}
