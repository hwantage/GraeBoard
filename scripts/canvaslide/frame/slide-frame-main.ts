/**
 * Loaded before the editor's own entry: answers the parent's open/new/save
 * requests with the editor's real document commands, and reports the editor's
 * unsaved state so GraeBoard can guard navigation.
 */
import { createDocumentContentComparator } from "@shared/canvas/document-content";
import { createEmptyDocument } from "@shared/canvas/element-types";
import { decodeDocumentFile } from "@/lib/workers/document-file-codec";
import {
  loadReplacement,
  replaceDocument,
} from "@/lib/document/document-replacement";
import { saveCurrentDocument } from "@/lib/document/save-document";
import { useDocumentStore } from "@/store/document-store";
import { useRecoveryStore } from "@/store/recovery-store";
import type { OpenedDocument } from "graeboard-upstream:document-file-access";
import { bindingPath, parseBinding } from "./slide-frame-binding";
import { handleHost, hosted, notifyHost } from "./slide-frame-host";

type OpenRequest = {
  teamId: string;
  fileId: string;
  revision: number;
  title: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** The author already chose to drop the open document's unsaved work. */
  discard?: boolean;
};

function editorState() {
  const { dirty, filePath, document, session } = useDocumentStore.getState();
  const binding = parseBinding(filePath);
  return {
    dirty,
    binding,
    name: document.name,
    documentSession: session,
  };
}

async function replaceWith(
  read: () => Promise<OpenedDocument>,
  discard: boolean,
): Promise<{ outcome: string }> {
  if (discard) {
    const opened = await read();
    if (useDocumentStore.getState().editBaseline) {
      return { outcome: "refused" };
    }
    loadReplacement(opened, { camera: "saved" });
    return { outcome: "replaced" };
  }
  return {
    outcome: await replaceDocument({
      read,
      onDirty: "ask",
      load: { camera: "saved" },
    }),
  };
}

if (hosted) {
  handleHost("open", (payload) => {
    const request = payload as unknown as OpenRequest;
    return replaceWith(async () => {
      const parsed = await decodeDocumentFile(new Uint8Array(request.bytes));
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      return {
        // The team title is the file's name in GraeBoard, whatever the document was called before.
        document: { ...parsed.document, name: request.title },
        filePath: bindingPath(request),
      };
    }, request.discard === true);
  });

  handleHost("new", (payload) => {
    const { teamId, title } = payload as { teamId: string; title: string };
    return replaceWith(
      async () => ({
        document: { ...createEmptyDocument(), name: title },
        filePath: bindingPath({ teamId, fileId: null, revision: 0, title }),
      }),
      payload.discard === true,
    );
  });

  // The same queue the editor's menu and Ctrl/Cmd+S use.
  handleHost("save", async () => ({
    saved: await saveCurrentDocument(),
    ...editorState(),
  }));
  handleHost("rename", ({ name, documentSession }) => {
    const store = useDocumentStore.getState();
    if (
      store.session === documentSession &&
      typeof name === "string" &&
      store.document.name !== name
    )
      store.renameDocument(name);
    return {};
  });
  handleHost("state", () => editorState());
  // Leaving on purpose: the recovery copy of this session is no longer wanted.
  handleHost("discard", async () => {
    await useRecoveryStore.getState().prepareExit();
    return {};
  });

  let last = "";
  const report = () => {
    const state = editorState();
    const next = JSON.stringify(state);
    if (next !== last) {
      last = next;
      notifyHost("state", state);
    }
  };
  const sameContent = createDocumentContentComparator();
  useDocumentStore.subscribe((current, previous) => {
    // Save As and conflict copies may get their team title after the snapshot
    // was taken. Match the saved baseline and preserve edits made in flight.
    if (
      current.session === previous.session &&
      current.filePath !== previous.filePath &&
      current.savedDocument
    ) {
      const target = parseBinding(current.filePath);
      const snapshot = current.savedDocument;
      if (target && target.title !== snapshot.name) {
        const savedDocument = { ...snapshot, name: target.title };
        const document =
          current.document.name === snapshot.name
            ? { ...current.document, name: target.title }
            : current.document;
        useDocumentStore.setState({
          savedDocument,
          document,
          dirty: !sameContent(savedDocument, document),
        });
        return;
      }
    }
    report();
  });
  notifyHost("ready", editorState());
}
