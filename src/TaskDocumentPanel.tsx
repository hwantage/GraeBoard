import { forwardRef } from "react";
import DocumentPanel, { type DocumentPanelHandle } from "./DocumentPanel";
import {
  documentDraftKey,
  type DocumentEditorProps,
} from "./TaskDocumentEditor";
import type { DocumentSaveResult } from "./types";
export type { DocumentHandle, DocumentPanelHandle } from "./DocumentPanel";
type Props = Omit<DocumentEditorProps, "documentId" | "controlsTarget"> & {
  initialDocumentId?: string;
  onDocumentSelected?: (id: string) => void;
};
export default forwardRef<DocumentPanelHandle, Props>(
  function TaskDocumentPanel(props, ref) {
    const path = props.report
      ? `/reports/${props.report.id}/tasks/${props.task.id}/documents`
      : `/tasks/${props.task.id}/documents`;
    return (
      <DocumentPanel
        {...props}
        ref={ref}
        path={path}
        draftKey={(documentId) => documentDraftKey({ ...props, documentId })}
        emptyUntilSaved={props.report?.isNew}
        onSaved={(result) => props.onSaved(result as DocumentSaveResult)}
        onListChanged={(result) =>
          props.onSaved({
            markdown: "",
            revision: 0,
            updatedAt: null,
            hasDocument: result.hasDocument!,
            documentCount: result.documentCount!,
            taskUpdatedAt: result.taskUpdatedAt!,
          })
        }
      />
    );
  },
);
