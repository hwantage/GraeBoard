import { Fragment, type Node, type Schema } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, Selection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const title = "원본 이미지";
const imageKey = (src: unknown) =>
  typeof src === "string" ? src.split("#")[0] : "";

// Originals remain ordinary image references in the existing Markdown toggle
// format, so permissions, sync, backup and image retention keep seeing them.
export function originalImageIn(node: Node): Node | null {
  if (node.type.name !== "toggle" || node.childCount !== 2) return null;
  const summary = node.firstChild!,
    content = node.lastChild!;
  if (
    summary.textContent !== title ||
    summary.attrs.level ||
    content.childCount !== 1
  )
    return null;
  const paragraph = content.firstChild!;
  return paragraph.type.name === "paragraph" &&
    paragraph.childCount === 1 &&
    paragraph.firstChild?.type.name === "image"
    ? paragraph.firstChild
    : null;
}

type Archive = { node: Node; pos: number; image: Node };
export function findImageOriginal(
  doc: Node,
  src: string,
  pos: number,
): Archive | null {
  let linked: Archive | null = null;
  doc.descendants((node, at) => {
    const image = originalImageIn(node);
    if (!image) return;
    const link = node.firstChild?.firstChild?.marks.find(
      (mark) => mark.type.name === "link",
    );
    if (!linked && link && imageKey(link.attrs.href) === imageKey(src))
      linked = { node, pos: at, image };
    return false;
  });
  if (linked) return linked;

  // Older saves have an unlinked toggle after the containing block. Associate
  // it only when that block has one image; never guess between inline images.
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const parent = $pos.node(depth - 1),
      index = $pos.index(depth - 1);
    const block = parent.child(index);
    let count = 0;
    block.descendants((child) => {
      if (originalImageIn(child)) return false;
      if (child.type.name === "image") count++;
    });
    if (count !== 1) continue;
    let at = $pos.after(depth),
      found: Archive | null = null;
    for (let i = index + 1; i < parent.childCount; i++) {
      const node = parent.child(i),
        image = originalImageIn(node);
      if (
        !image ||
        node.firstChild?.firstChild?.marks.some(
          (mark) => mark.type.name === "link",
        )
      )
        break;
      found = { node, pos: at, image };
      at += node.nodeSize;
    }
    if (found) return found;
  }
  return null;
}

export function imageOriginalBlock(
  schema: Schema,
  original: Node,
  editedSrc: string,
) {
  return schema.nodes.toggle.create({ open: false }, [
    schema.nodes.toggle_summary.create(
      { level: 0 },
      schema.text(title, [schema.marks.link.create({ href: editedSrc })]),
    ),
    schema.nodes.toggle_content.create(
      null,
      schema.nodes.paragraph.create(null, original),
    ),
  ]);
}

const linked = (archive: Node) =>
  archive.firstChild?.firstChild?.marks.find(
    (mark) => mark.type.name === "link",
  );
const imageCount = (block: Node) => {
  let count = 0;
  block.descendants((child) => {
    if (originalImageIn(child)) return false;
    if (child.type.name === "image") count++;
  });
  return count;
};

// Positions of the archives that belong to an image still in the document:
// a linked one needs its edited image, an unlinked one of older saves must
// follow a block with one image, as findImageOriginal reads them. Any other
// toggle of the same shape, such as an archive left by deleting its edited
// image or a user's own toggle, stays visible and in exports.
function attachedOriginals(doc: Node): Set<number> {
  const archives: { pos: number; parent: Node; index: number }[] = [];
  const images = new Set<string>();
  doc.descendants((node, pos, parent, index) => {
    if (originalImageIn(node)) {
      archives.push({ pos, parent: parent!, index });
      return false;
    }
    if (node.type.name === "image") images.add(imageKey(node.attrs.src));
  });
  const attached = new Set<number>();
  for (const { pos, parent, index } of archives) {
    const link = linked(parent.child(index));
    if (link) {
      if (images.has(imageKey(link.attrs.href))) attached.add(pos);
      continue;
    }
    for (let i = index - 1; i >= 0; i--) {
      const block = parent.child(i);
      if (originalImageIn(block)) {
        if (linked(block)) break;
        continue;
      }
      if (imageCount(block) === 1) attached.add(pos);
      break;
    }
  }
  return attached;
}

// Visual exports show the same content as the document. Stored Markdown keeps
// the original references; opening the image preview is the viewing entry point.
export function withoutImageOriginals(doc: Node): Node {
  const attached = attachedOriginals(doc);
  if (!attached.size) return doc;
  const strip = (node: Node, start: number): Node => {
    if (node.isLeaf) return node;
    const children: Node[] = [];
    node.forEach((child, offset) => {
      if (!attached.has(start + offset))
        children.push(strip(child, start + offset + 1));
    });
    return node.copy(Fragment.fromArray(children));
  };
  return strip(doc, 0);
}

const originalsKey = new PluginKey<DecorationSet>("document-image-originals");
function originalDecorations(doc: Node) {
  return DecorationSet.create(
    doc,
    [...attachedOriginals(doc)].map((pos) =>
      Decoration.node(pos, pos + doc.nodeAt(pos)!.nodeSize, {
        class: "document-image-original-archive",
        "aria-hidden": "true",
        style: "display: none",
      }),
    ),
  );
}
export const imageOriginals = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: originalsKey,
      state: {
        init: (_, state) => originalDecorations(state.doc),
        apply: (tr, value) =>
          tr.docChanged ? originalDecorations(tr.doc) : value,
      },
      props: { decorations: (state) => originalsKey.getState(state) },
      appendTransaction: (_, before, state) => {
        if (!state.selection.empty) return null;
        const archives = originalsKey.getState(state)?.find() ?? [];
        const direction = state.selection.head < before.selection.head ? -1 : 1;
        let selection = state.selection;
        const visited = new Set<number>();
        while (!visited.has(selection.head)) {
          visited.add(selection.head);
          const archive = archives.find(
            (item) => selection.head > item.from && selection.head < item.to,
          );
          if (!archive)
            return selection === state.selection
              ? null
              : state.tr.setSelection(selection).setMeta("addToHistory", false);
          selection = Selection.near(
            state.doc.resolve(direction > 0 ? archive.to : archive.from),
            direction,
          );
        }
        return null;
      },
    }),
);
