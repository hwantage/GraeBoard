import { useEffect, useState, type KeyboardEvent } from "react";
import { CalendarDays, GripVertical } from "lucide-react";
import {
  AutoScrollActivator,
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import type { Placement } from "./useListReorder";

type Column = { id: string; name: string; description: string; week: boolean };
type Props = {
  items: Column[];
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, targetId: string, placement: Placement) => void;
};
const horizontal: Modifier = ({ transform }) => ({ ...transform, y: 0 });

function ColumnCard({
  item,
  selected,
  disabled,
  onSelect,
  onKeyDown,
}: {
  item: Column;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    disabled,
    transition: { duration: 160, easing: "ease" },
  });
  return (
    <div
      ref={setNodeRef}
      className={`property-list-row ${item.week ? "week-column-row" : ""} ${selected ? "current" : ""}`}
      data-column-item={item.id}
      data-reordering={isDragging || undefined}
      style={{
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
      }}
      {...listeners}
      onPointerDownCapture={(event) => {
        if (disabled) return;
        const button =
          (event.target as Element).closest<HTMLButtonElement>("button") ||
          event.currentTarget.querySelector<HTMLButtonElement>("button");
        button?.focus({ preventScroll: true });
      }}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget && !disabled) onSelect();
      }}
    >
      <button
        {...attributes}
        type="button"
        className="list-drag-handle"
        disabled={disabled}
        aria-label={`${item.name} 속성 순서 이동`}
        title="드래그하여 순서 이동 · Alt+왼쪽/오른쪽 방향키"
      >
        <GripVertical size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={item.week ? "week-column-select" : "property-select"}
        disabled={disabled}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {item.week && <CalendarDays size={14} aria-hidden="true" />}
        {item.name}
        <small>{item.description}</small>
      </button>
    </div>
  );
}

export default function PropertyColumnOrder({
  items,
  selected,
  disabled,
  onSelect,
  onMove,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const active = items.find((item) => item.id === activeId);
  useEffect(() => {
    if (!activeId) return;
    // Safari may blur the card on pointerdown. Keep Escape for the active
    // drag even when focus has left the list; the sensor handles cancellation.
    const keepDialogOpen = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", keepDialogOpen, true);
    return () => document.removeEventListener("keydown", keepDialogOpen, true);
  }, [activeId]);
  function keyboard(event: KeyboardEvent<HTMLDivElement>, id: string) {
    if (
      disabled ||
      activeId ||
      !event.altKey ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.key === "ArrowRight";
    const target =
      items[items.findIndex((item) => item.id === id) + (after ? 1 : -1)];
    if (!target) return;
    const element = event.currentTarget;
    onMove(id, target.id, after ? "after" : "before");
    requestAnimationFrame(() =>
      element.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  }
  return (
    <DndContext
      sensors={sensors}
      modifiers={[horizontal]}
      collisionDetection={closestCenter}
      autoScroll={{
        activator: AutoScrollActivator.DraggableRect,
        canScroll: (element) => element.classList.contains("property-list"),
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "좌우로 끌어 순서를 바꾸세요. 키보드는 Alt와 왼쪽 또는 오른쪽 방향키로 이동합니다.",
        },
        announcements: {
          onDragStart: ({ active }) =>
            `${items.find((item) => item.id === active.id)?.name} 이동 시작`,
          onDragOver: ({ over }) =>
            over
              ? `${items.findIndex((item) => item.id === over.id) + 1}번째 위치`
              : undefined,
          onDragEnd: () =>
            "속성 순서를 변경했습니다. 속성 저장으로 확정하세요.",
          onDragCancel: () => "이동을 취소했습니다.",
        },
      }}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={({ active, over }) => {
        setActiveId(null);
        if (!over || active.id === over.id) return;
        const from = items.findIndex((item) => item.id === active.id);
        const to = items.findIndex((item) => item.id === over.id);
        onMove(
          String(active.id),
          String(over.id),
          to < from ? "before" : "after",
        );
      }}
    >
      <SortableContext
        items={items.map((item) => item.id)}
        strategy={horizontalListSortingStrategy}
      >
        <div className="property-list" role="group" aria-label="열 순서">
          {items.map((item) => (
            <ColumnCard
              key={item.id}
              item={item}
              selected={item.id === selected}
              disabled={disabled}
              onSelect={() => onSelect(item.id)}
              onKeyDown={(event) => keyboard(event, item.id)}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {active && (
          <div className="property-drag-preview" aria-hidden="true">
            <GripVertical size={15} />
            <span>
              {active.week && <CalendarDays size={14} />} {active.name}
              <small>{active.description}</small>
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
