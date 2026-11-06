import type { RefObject } from "react";
import { TableOfContents } from "lucide-react";

// Opens or closes the table of contents beside the rich document. It sits
// left of the mode switch, so the switch keeps its place in either mode.
export default function DocumentTocToggle({
  open,
  disabled = false,
  onChange,
  ref,
}: {
  open: boolean;
  disabled?: boolean;
  onChange: (open: boolean) => void;
  ref?: RefObject<HTMLButtonElement | null>;
}) {
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
