import { useEffect, useRef, type MouseEvent, type RefObject } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { documentFullPageUrl, type DocumentLinkTarget } from "./document-links";

// The full-page toggle of a task detail, calendar entry or memo card. With
// the document's link, ⌘/Ctrl+click or a middle click opens the document in
// a new tab already in full page, like a link, and leaves this one as it is.
// `onNewTab` saves this window's text first. The tab opens in the click, as
// popup blockers require, and loads the document once the save has finished;
// a save that cannot finish yet (composing, uploading or failed) closes it,
// as closing the window would wait. ⌘/Ctrl+Shift+Enter inside the same
// dialog or memo card toggles full page like a plain click.
export default function DocumentFullPageButton({
  fullPage,
  link,
  documentId,
  onToggle,
  onNewTab,
  ref,
}: {
  fullPage: boolean;
  link?: DocumentLinkTarget;
  // The document shown, for a task with several documents.
  documentId?: string;
  onToggle: () => void;
  onNewTab?: () => Promise<boolean>;
  ref?: RefObject<HTMLButtonElement | null>;
}) {
  const label = fullPage ? "전체 페이지 닫기" : "문서 전체 페이지로 보기";
  const button = useRef<HTMLButtonElement | null>(null);
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  useEffect(() => {
    const scope = button.current?.closest<HTMLElement>(
      "dialog, .memo-document-card",
    );
    if (!scope) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        !event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.isComposing ||
        button.current?.disabled
      )
        return;
      // Before the editor, which would otherwise break the line.
      event.preventDefault();
      event.stopPropagation();
      toggle.current();
    };
    scope.addEventListener("keydown", keydown, true);
    return () => scope.removeEventListener("keydown", keydown, true);
  }, []);
  function openNewTab(event: MouseEvent) {
    if (!link) return false;
    event.preventDefault();
    const url = documentFullPageUrl(link, documentId);
    if (!onNewTab) {
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    }
    const tab = window.open("", "_blank");
    if (!tab) return true;
    tab.opener = null;
    onNewTab().then(
      (saved) => (saved ? tab.location.replace(url) : tab.close()),
      () => tab.close(),
    );
    return true;
  }
  // The name stays the action; the tooltip adds the new tab, as the format
  // painter's does (Toolbar.tsx).
  return (
    <button
      ref={(element) => {
        button.current = element;
        if (ref) ref.current = element;
      }}
      type="button"
      className="button document-expand"
      aria-label={label}
      aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
      data-tooltip={
        fullPage || !link
          ? `${label} (⌘/Ctrl+Shift+Enter)`
          : `${label} (⌘/Ctrl+Shift+Enter · ⌘/Ctrl+클릭: 새 탭)`
      }
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
