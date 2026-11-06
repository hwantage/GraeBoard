import type { RefObject } from "react";
import { TableOfContents } from "lucide-react";

// Opens or closes the table of contents beside the rich document. It ends
// the row, right of the mode switch. The Markdown source keeps its place
// hidden (`reserved`), so the switch stays put in either mode.
export default function DocumentTocToggle({
  open,
  disabled = false,
  reserved = false,
  onChange,
  ref,
}: {
  open: boolean;
  disabled?: boolean;
  reserved?: boolean;
  onChange: (open: boolean) => void;
  ref?: RefObject<HTMLButtonElement | null>;
}) {
  if (reserved)
    return (
      <button
        type="button"
        className="document-toc-toggle"
        data-reserved=""
        aria-hidden="true"
        tabIndex={-1}
        disabled
      >
        <TableOfContents size={16} aria-hidden="true" />
      </button>
    );
  return (
    <button
      ref={ref}
      type="button"
      className="document-toc-toggle"
      aria-label="목차"
      data-tooltip="목차"
      aria-pressed={open}
      disabled={disabled}
      // Like the toolbar's buttons, a click keeps the caret in the document.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChange(!open)}
    >
      <TableOfContents size={16} aria-hidden="true" />
    </button>
  );
}
