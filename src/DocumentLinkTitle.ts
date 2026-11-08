import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { api } from "./platform/api";
import { parseDocumentLinkPath } from "../shared/document-links.js";

type Pending = { from: number; to: number; href: string };
const pendingTitles = new PluginKey<Map<object, Pending>>("documentLinkTitles");
export const documentLinkTitle = $prose(
  () =>
    new Plugin({
      key: pendingTitles,
      state: {
        init: () => new Map(),
        apply: (tr, previous) => {
          const next = new Map<object, Pending>();
          for (const [key, range] of previous) {
            let { from, to } = range;
            let touched = false;
            for (const map of tr.mapping.maps) {
              map.forEach((start, end) => {
                if (start <= to && end >= from) touched = true;
              });
              from = map.map(from, 1);
              to = map.map(to, -1);
            }
            if (!touched) next.set(key, { ...range, from, to });
          }
          const change = tr.getMeta(pendingTitles) as
            { key?: object; range?: Pending; remove?: object } | undefined;
          if (change?.key && change.range) next.set(change.key, change.range);
          if (change?.remove) next.delete(change.remove);
          return next;
        },
      },
    }),
);

export function pasteExternalLink(
  view: EditorView,
  text: string,
  linkTitles = true,
) {
  const href = text.trim();
  if (!/^https?:\/\/\S+$/i.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (
    parseDocumentLinkPath(url.pathname) &&
    url.origin === window.location.origin
  )
    return false;
  const { state } = view;
  const { selection, schema } = state;
  if (selection.$from.parent.type.spec.code) return false;
  const mark = schema.marks.link.create({ href });
  if (!selection.empty) {
    view.dispatch(state.tr.addMark(selection.from, selection.to, mark));
    return true;
  }
  const key = {};
  const from = selection.from;
  const tr = closeHistory(state.tr).replaceSelectionWith(
    schema.text(href, [mark]),
    false,
  );
  if (linkTitles)
    tr.setMeta(pendingTitles, {
      key,
      range: { from, to: from + href.length, href },
    });
  view.dispatch(tr.scrollIntoView());
  if (!linkTitles) return true;
  void api<{ title: string | null }>(
    `/link-title?url=${encodeURIComponent(href)}`,
  )
    .then(({ title }) => {
      if (!title || view.isDestroyed || !view.editable) return;
      const range = pendingTitles.getState(view.state)?.get(key);
      if (
        !range ||
        view.state.doc.textBetween(range.from, range.to, "", "") !== href
      )
        return;
      let linked = true;
      view.state.doc.nodesBetween(range.from, range.to, (node) => {
        if (node.isText && !mark.isInSet(node.marks)) linked = false;
      });
      if (!linked) return;
      // Isolate the title from both the paste and subsequent typing in history.
      view.dispatch(
        closeHistory(view.state.tr).replaceWith(
          range.from,
          range.to,
          schema.text(title, [mark]),
        ),
      );
      view.dispatch(closeHistory(view.state.tr));
    })
    .finally(() => {
      if (!view.isDestroyed && pendingTitles.getState(view.state)?.has(key))
        view.dispatch(view.state.tr.setMeta(pendingTitles, { remove: key }));
    })
    .catch(() => {});
  return true;
}
