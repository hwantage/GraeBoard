import { editorStateOptionsCtx, inputRulesCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  wrapInBlockquoteInputRule,
  wrapInBulletListInputRule,
  wrapInHeadingInputRule,
  wrapInOrderedListInputRule,
} from "@milkdown/kit/preset/commonmark";
import { wrapInTaskListInputRule } from "@milkdown/kit/preset/gfm";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "@milkdown/kit/prose/inputrules";
import { liftListItem, sinkListItem } from "@milkdown/kit/prose/schema-list";
import { goToNextCell, isInTable } from "@milkdown/kit/prose/tables";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Mark, type Node } from "@milkdown/kit/prose/model";

// ProseMirror omits these runtime fields from its public declaration.
const implementation = (rule: InputRule) =>
  rule as InputRule & {
    match: RegExp;
    handler: (
      state: EditorState,
      match: RegExpMatchArray,
      start: number,
      end: number,
    ) => Transaction | null;
  };
// Milkdown reassigns each built-in rule's `inputRule` to the editor that
// initialized last, so match an editor's own rules by their pattern.
const source = (plugin: { inputRule: InputRule }) =>
  implementation(plugin.inputRule).match.source;
const codeMark = (node: Node) => node.marks.some((mark) => mark.type.spec.code);
// A block shortcut needs the typed marker to be the whole text before the
// caret. With `keepText`, the text after the caret becomes the new block's
// content; otherwise the marker must fill the paragraph. Only the marker must
// be plain text, so inline code later in the paragraph does not block it.
function canFormat(
  state: EditorState,
  start: number,
  end: number,
  keepText = false,
) {
  const { $from, empty } = state.selection;
  return (
    empty &&
    !isInTable(state) &&
    $from.parent.type === state.schema.nodes.paragraph &&
    start === $from.start() &&
    (end === $from.end() || (keepText && end === $from.pos)) &&
    !$from.marks().some((mark) => mark.type.spec.code) &&
    !$from.parent.content.cut(0, end - start).content.some(codeMark)
  );
}

// Same nodes, text and marks; node attributes such as heading ids may differ.
function sameContent(a: Node, b: Node): boolean {
  if (a === b) return true;
  if (
    a.type !== b.type ||
    a.text !== b.text ||
    a.childCount !== b.childCount ||
    !Mark.sameSet(a.marks, b.marks)
  )
    return false;
  for (let i = 0; i < a.childCount; i++)
    if (!sameContent(a.child(i), b.child(i))) return false;
  return true;
}

function documentRulesPlugin(rules: InputRule[]) {
  const plugin = inputRules({ rules });
  const field = plugin.spec.state!;
  const apply = field.apply;
  field.apply = function (tr, value, previous, state) {
    // The trailing plugin appends an empty paragraph in the same dispatch.
    // Keep the shortcut's inverse through that append, but clear it on edits.
    if (
      value &&
      tr.getMeta("appendedTransaction") &&
      !tr.selectionSet &&
      tr.doc.childCount === previous.doc.childCount + 1 &&
      tr.doc.lastChild?.type === state.schema.nodes.paragraph &&
      tr.doc.lastChild.content.size === 0 &&
      tr.doc.content.cut(0, previous.doc.content.size).eq(previous.doc.content)
    )
      return value;
    // Milkdown's heading id sync follows a heading with text in a separate
    // dispatch outside history. Attribute-only changes keep the inverse valid.
    if (
      value &&
      tr.docChanged &&
      !tr.selectionSet &&
      tr.getMeta("addToHistory") === false &&
      sameContent(tr.doc, previous.doc)
    )
      return value;
    return apply.call(this, tr, value, previous, state);
  };
  return plugin;
}

const inputRulesPlugin = (state: EditorState) =>
  state.plugins.find((plugin) => plugin.spec.isInputRules);
// Store the inverse that Backspace/Mod-Z (`undoInputRule`) apply: undo `tr`,
// then put `text` over from..to of the document before it.
function recordInputRule(
  state: EditorState,
  tr: Transaction,
  from: number,
  to: number,
  text: string,
) {
  const plugin = inputRulesPlugin(state);
  if (plugin) tr.setMeta(plugin, { transform: tr, from, to, text });
  return tr;
}

// An odd number of backticks in the plain text before `pos` means inline code
// is still being typed (`a->b`); its closing backtick makes the code mark.
function typingInlineCode(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  let ticks = 0;
  $pos.parent.forEach((node, offset) => {
    if (node.isText && offset < $pos.parentOffset && !codeMark(node))
      ticks +=
        node.text!.slice(0, $pos.parentOffset - offset).split("`").length - 1;
  });
  return ticks % 2 === 1;
}

// Typed arrows become symbols anywhere in text, table cells included. The
// plugin skips code blocks, and inCodeMark: false keeps inline code as typed.
// `<-` and `<=` convert before the `>` of `<->` and `<=>` is typed, so a `>`
// right after that conversion joins the arrow, and Backspace or Mod-Z restore
// all three typed characters instead of the intermediate arrow.
const arrowRules = [
  ...(
    [
      [/←>$/, "↔", "<->"],
      [/⇐>$/, "⇔", "<=>"],
    ] as const
  ).map(
    ([match, symbol, typed]) =>
      new InputRule(
        match,
        (state, _match, start, end) => {
          // Join only when the last input rule converted this `<-`/`<=`
          // where the caret is, not after a caret move or another rule.
          const undo = inputRulesPlugin(state)?.getState(state);
          if (undo?.text !== typed[1] || undo.to !== end) return null;
          const tr = state.tr.insertText(symbol, start, end);
          return recordInputRule(state, tr, start, end, typed);
        },
        { inCodeMark: false, undoable: false },
      ),
  ),
  ...[
    ["<->", "↔"],
    ["<=>", "⇔"],
    ["->", "→"],
    ["<-", "←"],
    ["=>", "⇒"],
    ["<=", "⇐"],
  ].map(
    ([typed, symbol]) =>
      new InputRule(
        new RegExp(`${typed}$`),
        (state, _match, start, end) =>
          typingInlineCode(state, start)
            ? null
            : state.tr.insertText(symbol, start, end),
        { inCodeMark: false },
      ),
  ),
];

// Preserve Milkdown's handlers and undo-input-rule metadata, with the same
// boundaries for every block shortcut, including the additional task forms.
export function configureDocumentInputRules(ctx: Ctx) {
  ctx.update(editorStateOptionsCtx, (previous) => (options) => {
    const configured = previous(options);
    const own = ctx.get(inputRulesCtx).map(implementation);
    const taskSource = source(wrapInTaskListInputRule);
    const gfmTask = own.find((rule) => rule.match.source === taskSource);
    const task = new InputRule(/^\[( |x)?\] $/, (state, match, start, end) => {
      if (!canFormat(state, start, end, true)) return null;
      const { $from } = state.selection;
      const { schema } = state;
      for (let depth = $from.depth - 1; depth > 0; depth--) {
        const item = $from.node(depth);
        if (item.type !== state.schema.nodes.list_item) continue;
        // Reuse GFM's conversion for an existing list item.
        const normalized = Object.assign([...match], {
          groups: { checked: match[1] || " " },
        }) as unknown as RegExpMatchArray;
        return gfmTask?.handler(state, normalized, start, end) ?? null;
      }
      const wrap = wrappingInputRule(/^\[( |x)?\] $/, schema.nodes.bullet_list);
      const tr = implementation(wrap).handler(state, match, start, end);
      if (!tr) return null;
      const $pos = tr.doc.resolve(tr.selection.from);
      for (let depth = $pos.depth - 1; depth > 0; depth--) {
        const item = $pos.node(depth);
        if (item.type === schema.nodes.list_item)
          return tr.setNodeMarkup($pos.before(depth), undefined, {
            ...item.attrs,
            checked: match[1] === "x",
          });
      }
      return null;
    });
    // List, checklist, heading and quote markers also convert a paragraph
    // that already has text. Code fences, rules and tables stay empty-only.
    const keepText = new Set([
      implementation(task).match.source,
      ...[
        wrapInBulletListInputRule,
        wrapInOrderedListInputRule,
        wrapInHeadingInputRule,
        wrapInBlockquoteInputRule,
      ].map(source),
    ]);
    const rules = [
      task,
      ...own.filter((rule) => rule.match.source !== taskSource),
    ]
      .map(implementation)
      .map(
        (rule) =>
          new InputRule(
            rule.match,
            (state, match, start, end) => {
              if (
                isInTable(state) ||
                state.selection.$from
                  .marks()
                  .some((mark) => mark.type.spec.code)
              )
                return null;
              if (
                rule.match.source.startsWith("^") &&
                !canFormat(state, start, end, keepText.has(rule.match.source))
              )
                return null;
              return rule.handler(state, match, start, end);
            },
            { inCodeMark: false },
          ),
      );
    return {
      ...configured,
      plugins: configured.plugins?.map((plugin) =>
        plugin.spec.isInputRules
          ? documentRulesPlugin([...rules, ...arrowRules])
          : plugin,
      ),
    };
  });
}

// Enter is a key event rather than text input. Apply the fence rule's block
// change and the input-rule plugin's metadata so Backspace/Mod-Z restore it.
// Build it from this editor's schema; the shared Milkdown rule object may
// belong to another editor on the page.
function fenceEnter(view: EditorView) {
  const { state } = view;
  const { $from } = state.selection;
  if ($from.pos !== $from.end()) return false;
  const fence = /^```(?<language>[a-z]*)?\n$/;
  const match = fence.exec($from.parent.textContent + "\n");
  if (!match || !canFormat(state, $from.start(), $from.end())) return false;
  const rule = implementation(
    textblockTypeInputRule(fence, state.schema.nodes.code_block, (match) => ({
      language: match.groups?.language ?? "",
    })),
  );
  const tr = rule.handler(state, match, $from.start(), $from.end());
  if (!tr) return false;
  view.dispatch(recordInputRule(state, tr, $from.pos, $from.pos, ""));
  return true;
}

export function documentInputKeydown(view: EditorView, event: KeyboardEvent) {
  if (!view.editable) return false;
  if (
    event.key === "Backspace" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    undoInputRule(view.state, view.dispatch)
  )
    return true;
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "z"
  )
    return undoInputRule(view.state, view.dispatch);
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    fenceEnter(view)
  )
    return true;
  if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  const { state } = view;
  if (isInTable(state))
    goToNextCell(event.shiftKey ? -1 : 1)(state, view.dispatch);
  else if (state.selection.$from.parent.type.spec.code) {
    if (!event.shiftKey)
      view.dispatch(state.tr.insertText("  ").scrollIntoView());
  } else {
    const item = state.schema.nodes.list_item;
    (event.shiftKey ? liftListItem(item) : sinkListItem(item))(
      state,
      view.dispatch,
    );
  }
  return true;
}
