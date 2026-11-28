import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { isInTable } from "@milkdown/kit/prose/tables";

export type SlashItem = {
  id: string;
  label: string;
  keywords: string;
  icon: ReactNode;
  run: () => void;
  disabled?: boolean;
  // A heading is shown above the first item of each group.
  group?: string;
};
export type SlashMatch = {
  from: number;
  to: number;
  query: string;
  // The paragraph is a list item's own line, where the menu keeps the item.
  listItem: boolean;
};

// "/" at the start of a paragraph opens the menu, even with text after the
// caret. The characters typed after it filter the list; a space or leaving
// the paragraph closes it. A "/" after other text stays a character: block
// commands change the whole paragraph, which a "/" typed mid-sentence does
// not mean. Table cells keep "/" as plain text because block commands do not
// apply inside them.
export function slashMatch(state: EditorState): SlashMatch | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== "paragraph" || isInTable(state)) return null;
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = /^\/([^\s/]*)$/.exec(text);
  if (!match) return null;
  return {
    from: $from.pos - match[1].length - 1,
    to: $from.pos,
    query: match[1],
    listItem: $from.node(-1).type.name === "list_item",
  };
}

export function filterSlashItems(items: SlashItem[], query: string) {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return items;
  return items.filter((item) =>
    `${item.label}${item.keywords}`
      .toLowerCase()
      .replace(/\s+/g, "")
      .includes(needle),
  );
}

export default function DocumentSlashMenu({
  label = "편집 형식 선택",
  items,
  active,
  left,
  top,
  flip,
  onHover,
  onSelect,
}: {
  label?: string;
  items: SlashItem[];
  active: number;
  left: number;
  top: number;
  flip: boolean;
  onHover: (index: number) => void;
  onSelect: (item: SlashItem) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={list}
      className="document-slash-menu"
      role="listbox"
      aria-label={label}
      data-flip={flip || undefined}
      style={{ left, top }}
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.group && item.group !== items[index - 1]?.group && (
            <div className="document-slash-menu-group" aria-hidden="true">
              {item.group}
            </div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            disabled={item.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onSelect(item)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}
