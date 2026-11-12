import { forwardRef } from "react";
import DocumentPanel, {
  type DocumentPanelHandle,
  type DocumentPanelProps,
} from "./DocumentPanel";

// Original memos belong to the team's year; a copy's memos to that copy only.
type MemoOwner =
  | { teamId: string; year: number; sheetCloneId?: string }
  | { teamId: string; year?: undefined; sheetCloneId: string };
export function annualMemoPath({ teamId, year, sheetCloneId }: MemoOwner) {
  return sheetCloneId
    ? `/sheet-clones/${sheetCloneId}/memos`
    : `/teams/${teamId}/years/${year}/memos`;
}
// A memo's unsaved draft, shared by its card, browser tab and link page.
export function annualMemoDraftKey({
  userId,
  teamId,
  year,
  sheetCloneId,
  documentId,
}: MemoOwner & { userId: string; documentId: string }) {
  return `weekly-plan:memo:${userId}:${teamId}:${sheetCloneId || year}:${documentId}`;
}
type Props = {
  teamId: string;
  year: number;
  sheetCloneId?: string;
  userId: string;
} & Omit<DocumentPanelProps, "path" | "draftKey" | "documentLink" | "label">;
// The tail memos of an original or a copy, as cards under the annual table
// (AnnualMemoPanel) or as tabs in the document browser. Both share the list,
// drafts and links.
export default forwardRef<DocumentPanelHandle, Props>(
  function AnnualMemoDocumentPanel(
    { teamId, year, sheetCloneId, userId, ...props },
    ref,
  ) {
    return (
      <DocumentPanel
        {...props}
        ref={ref}
        label="연간 업무 메모"
        path={annualMemoPath({ teamId, year, sheetCloneId })}
        draftKey={(documentId) =>
          annualMemoDraftKey({
            userId,
            teamId,
            year,
            sheetCloneId,
            documentId,
          })
        }
        documentLink={(id) =>
          sheetCloneId
            ? { kind: "sheet-clone-memo", sheetCloneId, id }
            : { kind: "memo", teamId, year, id }
        }
      />
    );
  },
);
