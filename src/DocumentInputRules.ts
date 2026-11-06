import { editorStateOptionsCtx, inputRulesCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { createCodeBlockInputRule } from "@milkdown/kit/preset/commonmark";
import { wrapInTaskListInputRule } from "@milkdown/kit/preset/gfm";
import {
  InputRule,
  inputRules,
  undoInputRule,
  wrappingInputRule,
} from "@milkdown/kit/prose/inputrules";
import { liftListItem, sinkListItem } from "@milkdown/kit/prose/schema-list";
import { goToNextCell, isInTable } from "@milkdown/kit/prose/tables";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";

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
const codeMark = (node: Node) => node.marks.some((mark) => mark.type.spec.code);
function canFormat(state: EditorState, start: number, end: number) {
  const { $from, empty } = state.selection;
  return (
    empty &&
    !isInTable(state) &&
    $from.parent.type === state.schema.nodes.paragraph &&
    start === $from.start() &&
    end === $from.end() &&
    !$from.marks().some((mark) => mark.type.spec.code) &&
    !$from.parent.content.content.some(codeMark)
  );
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
    return apply.call(this, tr, value, previous, state);
  };
  return plugin;
}

// Preserve Milkdown's handlers and undo-input-rule metadata, with the same
// boundaries for every block shortcut, including the additional task forms.
export function configureDocumentInputRules(ctx: Ctx) {
  ctx.update(editorStateOptionsCtx, (previous) => (options) => {
    const configured = previous(options);
    const task = new InputRule(/^\[( |x)?\] $/, (state, match, start, end) => {
      if (!canFormat(state, start, end)) return null;
      const { $from } = state.selection;
      const { schema } = state;
      for (let depth = $from.depth - 1; depth > 0; depth--) {
        const item = $from.node(depth);
        if (item.type !== state.schema.nodes.list_item) continue;
        // Reuse GFM's conversion for an existing list item.
        const normalized = Object.assign([...match], {
          groups: { checked: match[1] || " " },
        }) as unknown as RegExpMatchArray;
        return implementation(wrapInTaskListInputRule.inputRule).handler(
          state,
          normalized,
          start,
          end,
        );
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
    const rules = [
      task,
      ...ctx
        .get(inputRulesCtx)
        .filter((rule) => rule !== wrapInTaskListInputRule.inputRule),
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
                !canFormat(state, start, end)
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
        plugin.spec.isInputRules ? documentRulesPlugin(rules) : plugin,
      ),
    };
  });
}

// Enter is a key event rather than text input. Use the existing fence handler
// and the input-rule plugin's metadata so Backspace/Mod-Z restore the fence.
function fenceEnter(view: EditorView) {
  const { state } = view;
  const { $from } = state.selection;
  if ($from.pos !== $from.end()) return false;
  const match = /^```(?<language>[a-z]*)?\n$/.exec(
    $from.parent.textContent + "\n",
  );
  if (!match || !canFormat(state, $from.start(), $from.end())) return false;
  const rule = implementation(createCodeBlockInputRule.inputRule);
  const tr = rule.handler(state, match, $from.start(), $from.end());
  if (!tr) return false;
  const plugin = state.plugins.find((plugin) => plugin.spec.isInputRules);
  if (plugin)
    tr.setMeta(plugin, {
      transform: tr,
      from: $from.pos,
      to: $from.pos,
      text: "",
    });
  view.dispatch(tr);
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
