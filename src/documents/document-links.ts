import { createContext, useContext, useEffect, useRef } from "react";
import { api } from "../platform/api";
import {
  DOCUMENT_LINK_BATCH,
  documentLinkPath,
  parseDocumentLinkPath,
} from "../../shared/documents/document-links.js";

// Links between documents point at a task detail, a calendar entry, a tail
// memo or a copy's task detail or memo. The Markdown stores the app path
// (shared/documents/document-links.js); the clipboard carries this site's absolute
// address of the same path.
export type DocumentLinkTarget =
  | { kind: "task"; id: string }
  | { kind: "calendar"; id: string }
  | { kind: "memo"; teamId: string; year: number; id: string }
  | { kind: "sheet-clone-task"; sheetCloneId: string; id: string }
  | { kind: "sheet-clone-memo"; sheetCloneId: string; id: string };
export type DocumentLinkTitle =
  | { status: "loading" }
  | { status: "ready"; title: string }
  | { status: "unavailable" };

export const documentLinkKey = (target: DocumentLinkTarget): string =>
  documentLinkPath(target);
export const documentLinkHref = (target: DocumentLinkTarget): string =>
  documentLinkPath(target);
export const documentLinkUrl = (target: DocumentLinkTarget) =>
  new URL(documentLinkPath(target), location.origin).href;
// The full-page button opens its document in a new tab at this address. The
// workspace reads the flag once and cleans the address (App.tsx); stored and
// copied links never carry it.
// A task with several documents also names the one shown, so the new tab
// opens that document rather than the first.
export const documentFullPageUrl = (
  target: DocumentLinkTarget,
  documentId?: string,
) =>
  `${documentLinkUrl(target)}?${new URLSearchParams({
    view: "full",
    ...(documentId ? { document: documentId } : {}),
  })}`;
export const documentLinkFullPage = (search: string) =>
  new URLSearchParams(search).get("view") === "full";
export const documentLinkDocument = (search: string) =>
  new URLSearchParams(search).get("document") || undefined;
export const UNAVAILABLE_LINK_MESSAGE =
  "링크한 문서를 열 수 없습니다. 삭제되었거나 접근 권한이 없습니다.";

// The stored path, or this site's absolute address of it. Other origins
// stay ordinary web links.
export function documentLinkTarget(href: string): DocumentLinkTarget | null {
  if (href.startsWith("/")) return parseDocumentLinkPath(href);
  try {
    const url = new URL(href);
    return url.origin === location.origin && !url.search && !url.hash
      ? parseDocumentLinkPath(url.pathname)
      : null;
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
// Plain text is the address for other apps and the browser bar. The HTML
// anchor also carries the title, which a rich document keeps as link text.
export async function copyDocumentLink(
  target: DocumentLinkTarget,
  title: string,
) {
  const url = documentLinkUrl(target);
  await copyToClipboard(
    url,
    `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`,
  );
}

export async function copyToClipboard(text: string, html?: string) {
  if (
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    navigator.clipboard?.write
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        ...(html && { "text/html": new Blob([html], { type: "text/html" }) }),
      }),
    ]);
    return;
  }
  // A site served over plain HTTP has no asynchronous clipboard. The click's
  // copy command still lets the page fill the clipboard; Safari only runs it
  // with a selection, so a hidden one is made when the first attempt is idle.
  // The copy never reaches an editor, which would put its selection there.
  let copied = false;
  const fill = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    if (html) event.clipboardData?.setData("text/html", html);
    event.preventDefault();
    event.stopPropagation();
    copied = true;
  };
  document.addEventListener("copy", fill, true);
  try {
    document.execCommand("copy");
    if (!copied) {
      const focused = document.activeElement as HTMLElement | null;
      const holder = document.createElement("span");
      holder.textContent = text;
      holder.style.cssText = "position:fixed;opacity:0;white-space:pre";
      (focused?.closest("dialog") || document.body).append(holder);
      const selection = getSelection();
      selection?.selectAllChildren(holder);
      document.execCommand("copy");
      selection?.removeAllRanges();
      holder.remove();
      focused?.focus({ preventScroll: true });
    }
  } finally {
    document.removeEventListener("copy", fill, true);
  }
  if (!copied) throw new Error("copy failed");
}

// Current titles of the links in one open document. Link views ask for a
// title as they are drawn; the requests of one render share a lookup.
const openTitles = new Set<DocumentLinkTitles>();
export class DocumentLinkTitles {
  private titles = new Map<string, DocumentLinkTitle>();
  private watchers = new Map<string, Set<() => void>>();
  private queued = new Set<string>();
  private waiting = new Map<string, (() => void)[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshed = 0;
  private onFocus = () => {
    // Titles renamed in another tab or window.
    if (Date.now() - this.refreshed > 5000) this.refresh();
  };
  constructor() {
    openTitles.add(this);
    window.addEventListener("focus", this.onFocus);
  }
  dispose() {
    openTitles.delete(this);
    window.removeEventListener("focus", this.onFocus);
    if (this.timer) clearTimeout(this.timer);
    this.watchers.clear();
    this.waiting.clear();
  }
  get(target: DocumentLinkTarget): DocumentLinkTitle {
    return this.titles.get(documentLinkKey(target)) || { status: "loading" };
  }
  watch(target: DocumentLinkTarget, listener: () => void) {
    const key = documentLinkKey(target);
    if (!this.watchers.has(key)) this.watchers.set(key, new Set());
    this.watchers.get(key)!.add(listener);
    if (!this.titles.has(key)) this.request(key);
    return () => {
      const listeners = this.watchers.get(key);
      listeners?.delete(listener);
      if (listeners && !listeners.size) this.watchers.delete(key);
    };
  }
  // Resolves once the next lookup of this target has finished.
  load(target: DocumentLinkTarget) {
    return new Promise<void>((resolve) => {
      const key = documentLinkKey(target);
      this.waiting.set(key, [...(this.waiting.get(key) || []), resolve]);
      this.request(key);
    });
  }
  refresh() {
    for (const key of this.watchers.keys()) this.request(key);
  }
  set(target: DocumentLinkTarget, title: DocumentLinkTitle) {
    this.setKey(documentLinkKey(target), title);
  }
  private setKey(key: string, title: DocumentLinkTitle) {
    this.titles.set(key, title);
    for (const listener of this.watchers.get(key) || []) listener();
  }
  private request(key: string) {
    this.queued.add(key);
    this.timer ??= setTimeout(() => void this.lookup(), 0);
  }
  private async lookup() {
    this.timer = null;
    this.refreshed = Date.now();
    const keys = [...this.queued];
    this.queued.clear();
    for (let offset = 0; offset < keys.length; offset += DOCUMENT_LINK_BATCH) {
      const asked = keys.slice(offset, offset + DOCUMENT_LINK_BATCH);
      try {
        const { links } = await api<{
          links: { path: string; title: string }[];
        }>(
          `/document-links?${new URLSearchParams({ links: asked.join(",") })}`,
        );
        if (!openTitles.has(this)) return;
        const found = new Map(links.map((link) => [link.path, link.title]));
        for (const key of asked) {
          const title = found.get(key);
          this.setKey(
            key,
            title === undefined
              ? { status: "unavailable" }
              : { status: "ready", title },
          );
        }
      } catch {
        // Keep the stored text; the next refresh tries again.
      }
      for (const key of asked) {
        for (const resolve of this.waiting.get(key) || []) resolve();
        this.waiting.delete(key);
      }
    }
  }
}
// A title saved in this tab, shown by every open document that links to it.
export function updateDocumentLinkTitle(
  target: DocumentLinkTarget,
  title: string,
) {
  for (const titles of openTitles) {
    const current = titles.get(target);
    if (current.status === "ready") titles.set(target, { ...current, title });
  }
}
export function refreshDocumentLinkTitles() {
  for (const titles of openTitles) titles.refresh();
}

// Opening a link is provided by the workspace, which knows the screens and
// the detail windows already open. `close` leaves a detail window through its
// own save path and says whether it closed.
export type DocumentLinkOpener = {
  open: (target: DocumentLinkTarget) => Promise<void>;
  register: (
    target: DocumentLinkTarget,
    close: () => Promise<boolean>,
  ) => () => void;
};
export const DocumentLinkContext = createContext<DocumentLinkOpener | null>(
  null,
);
// Only link panels in a tab opened at a document address publish page titles.
// The workspace owns the title and picks the topmost panel, including on close.
export const DocumentPageTitleContext = createContext<
  ((title: string) => void) | null
>(null);
export function useDocumentPageTitle(title: string) {
  const reportTitle = useContext(DocumentPageTitleContext);
  useEffect(() => {
    reportTitle?.(title);
  }, [reportTitle, title]);
}
export function useDocumentLinkOpener() {
  return useContext(DocumentLinkContext);
}
// A detail window marks its target as open, so its own link does not open
// a second window over it, and lets a link elsewhere close it first.
export function useOpenDocumentLink(
  target: DocumentLinkTarget | null,
  close: () => Promise<boolean>,
) {
  const opener = useContext(DocumentLinkContext);
  const latestClose = useRef(close);
  latestClose.current = close;
  const key = target && documentLinkKey(target);
  useEffect(() => {
    if (!opener || !target) return;
    return opener.register(target, () => latestClose.current());
  }, [opener, key]);
}
