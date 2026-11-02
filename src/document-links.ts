import { createContext, useContext, useEffect } from "react";
import { api } from "./api";
import {
  DOCUMENT_LINK_BATCH,
  documentLinkPath,
  parseDocumentLinkPath,
} from "../shared/document-links.js";

// Links between documents point at a task detail or a calendar entry. The
// Markdown stores `/links/<kind>/<id>` (shared/document-links.js); the
// clipboard carries this site's absolute address of the same path.
export type DocumentLinkKind = "task" | "calendar";
export type DocumentLinkTarget = { kind: DocumentLinkKind; id: string };
export type DocumentLinkTitle =
  | { status: "loading" }
  | { status: "ready"; title: string }
  | { status: "unavailable" };

export const documentLinkKey = ({ kind, id }: DocumentLinkTarget) =>
  `${kind}:${id}`;
export const documentLinkHref = (target: DocumentLinkTarget): string =>
  documentLinkPath(target);
export const documentLinkUrl = (target: DocumentLinkTarget) =>
  new URL(documentLinkPath(target), location.origin).href;
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
  const html = `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`;
  if (
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    navigator.clipboard?.write
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([url], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    return;
  }
  // A site served over plain HTTP has no asynchronous clipboard. The click's
  // copy command still lets the page fill the clipboard; Safari only runs it
  // with a selection, so a hidden one is made when the first attempt is idle.
  let copied = false;
  const fill = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", url);
    event.clipboardData?.setData("text/html", html);
    event.preventDefault();
    copied = true;
  };
  document.addEventListener("copy", fill, true);
  try {
    document.execCommand("copy");
    if (!copied) {
      const focused = document.activeElement as HTMLElement | null;
      const holder = document.createElement("span");
      holder.textContent = url;
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
  private queued = new Map<string, DocumentLinkTarget>();
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
    if (!this.titles.has(key)) this.request(target);
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
      this.request(target);
    });
  }
  refresh() {
    for (const key of this.watchers.keys()) {
      const [kind, id] = key.split(":") as [DocumentLinkKind, string];
      this.request({ kind, id });
    }
  }
  set(target: DocumentLinkTarget, title: DocumentLinkTitle) {
    const key = documentLinkKey(target);
    this.titles.set(key, title);
    for (const listener of this.watchers.get(key) || []) listener();
  }
  private request(target: DocumentLinkTarget) {
    this.queued.set(documentLinkKey(target), target);
    this.timer ??= setTimeout(() => void this.lookup(), 0);
  }
  private async lookup() {
    this.timer = null;
    this.refreshed = Date.now();
    const targets = [...this.queued.values()];
    this.queued.clear();
    for (let offset = 0; offset < targets.length;) {
      // At most DOCUMENT_LINK_BATCH IDs of each kind per request.
      const batch = { task: [] as string[], calendar: [] as string[] };
      while (
        offset < targets.length &&
        batch[targets[offset].kind].length < DOCUMENT_LINK_BATCH
      )
        batch[targets[offset].kind].push(targets[offset++].id);
      const asked = [
        ...batch.task.map((id) => ({ kind: "task" as const, id })),
        ...batch.calendar.map((id) => ({ kind: "calendar" as const, id })),
      ];
      try {
        const { links } = await api<{
          links: (DocumentLinkTarget & { title: string })[];
        }>(
          `/document-links?${new URLSearchParams(
            Object.entries(batch)
              .filter(([, ids]) => ids.length)
              .map(([kind, ids]) => [kind, ids.join(",")]),
          )}`,
        );
        if (!openTitles.has(this)) return;
        const found = new Map(
          links.map((link) => [documentLinkKey(link), link]),
        );
        for (const target of asked) {
          const link = found.get(documentLinkKey(target));
          this.set(
            target,
            link
              ? { status: "ready", title: link.title }
              : { status: "unavailable" },
          );
        }
      } catch {
        // Keep the stored text; the next refresh tries again.
      }
      for (const target of asked) {
        const key = documentLinkKey(target);
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
// the detail windows already open.
export type DocumentLinkOpener = {
  open: (target: DocumentLinkTarget) => Promise<void>;
  register: (target: DocumentLinkTarget) => () => void;
};
export const DocumentLinkContext = createContext<DocumentLinkOpener | null>(
  null,
);
export function useDocumentLinkOpener() {
  return useContext(DocumentLinkContext);
}
// A detail window marks its target as open, so its own link does not open
// a second window over it.
export function useOpenDocumentLink(target: DocumentLinkTarget | null) {
  const opener = useContext(DocumentLinkContext);
  const key = target && documentLinkKey(target);
  useEffect(() => {
    if (!opener || !target) return;
    return opener.register(target);
  }, [opener, key]);
}
