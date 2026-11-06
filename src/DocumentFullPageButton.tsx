import type { MouseEvent, RefObject } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { documentFullPageUrl, type DocumentLinkTarget } from "./document-links";

// The full-page toggle of a task detail, calendar entry or memo card. With
// the document's link, ⌘/Ctrl+click or a middle click opens the document in
// a new tab already in full page, like a link, and leaves this one as it is.
// `onNewTab` starts this window's own save so the new tab reads the latest
// text; the tab opens in the click without waiting for it.
export default function DocumentFullPageButton({
  fullPage,
  link,
  onToggle,
  onNewTab,
  ref,
}: {
  fullPage: boolean;
  link?: DocumentLinkTarget;
  onToggle: () => void;
  onNewTab?: () => void;
  ref?: RefObject<HTMLButtonElement | null>;
}) {
  const label = fullPage ? "전체 페이지 닫기" : "문서 전체 페이지로 보기";
  function openNewTab(event: MouseEvent) {
    if (!link) return false;
    event.preventDefault();
    onNewTab?.();
    window.open(documentFullPageUrl(link), "_blank", "noopener,noreferrer");
    return true;
  }
  // The name stays the action; the tooltip adds the new tab, as the format
  // painter's does (Toolbar.tsx).
  return (
    <button
      ref={ref}
      type="button"
      className="button document-expand"
      aria-label={label}
      data-tooltip={fullPage || !link ? label : `${label} (⌘/Ctrl+클릭: 새 탭)`}
      aria-pressed={fullPage}
      onClick={(event) => {
        if (!((event.metaKey || event.ctrlKey) && openNewTab(event)))
          onToggle();
      }}
      // A middle press would otherwise start the browser's autoscroll.
      onMouseDown={(event) => {
        if (event.button === 1 && link) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) openNewTab(event);
      }}
    >
      {fullPage ? (
        <Minimize2 size={16} aria-hidden="true" />
      ) : (
        <Maximize2 size={16} aria-hidden="true" />
      )}
    </button>
  );
}
