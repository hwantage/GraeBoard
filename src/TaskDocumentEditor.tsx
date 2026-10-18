import { forwardRef } from "react";
import { send } from "./api";
import DocumentEditor, { type DocumentHandle } from "./DocumentEditor";
import type { Task, DocumentSaveResult } from "./types";
export { readDocumentDraft } from "./DocumentEditor";
export type { DocumentHandle } from "./DocumentEditor";
export type DocumentEditorProps = {
  documentId: string;
  controlsTarget: HTMLDivElement | null;
  task: Task;
  userId: string;
  readOnly: boolean;
  report?: { id: string; isNew: boolean };
  onSaved: (result: DocumentSaveResult) => void;
  onCloseWithDraft: () => void;
  onLoadingChange: (loading: boolean) => void;
};
export function documentDraftKey(
  props: Pick<DocumentEditorProps, "userId" | "task" | "report" | "documentId">,
) {
  return `weekly-plan:document:${props.userId}:${props.task.teamId}:${props.report?.id || "original"}:${props.task.id}:${props.documentId}`;
}
export default forwardRef<DocumentHandle, DocumentEditorProps>(
  function TaskDocumentEditor(props, ref) {
    const path = props.report
      ? `/reports/${props.report.id}/tasks/${props.task.id}/documents/${props.documentId}`
      : `/tasks/${props.task.id}/documents/${props.documentId}`;
    return (
      <DocumentEditor
        ref={ref}
        path={path}
        draftKey={documentDraftKey(props)}
        controlsTarget={props.controlsTarget}
        readOnly={props.readOnly || !!props.report?.isNew}
        emptyUntilSaved={props.report?.isNew}
        onCloseWithDraft={props.onCloseWithDraft}
        onLoadingChange={props.onLoadingChange}
        saveDocument={async (input) => {
          const result = await send<DocumentSaveResult>(path, input, "PUT");
          props.onSaved(result);
          return result;
        }}
      />
    );
  },
);
