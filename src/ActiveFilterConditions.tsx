import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { displayValueFor, orderColumns } from "../shared/domain.js";
import type { Property, Task, User, View } from "./types";
import GridHeaderMenu from "./GridHeaderMenu";
import PropertyFilter from "./PropertyFilter";

type Filters = Pick<View, "propertyFilters" | "propertyFilterModes">;

export default function ActiveFilterConditions({
  properties,
  tasks,
  users,
  view,
  onChange,
  children,
}: {
  properties: Property[];
  tasks: Task[];
  users: User[];
  view: Filters;
  onChange: (filters: Filters) => void;
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{
    propertyId: string;
    x: number;
    y: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  const filters = view.propertyFilters || {};
  const [retainedIds, setRetainedIds] = useState<string[]>(() =>
    Object.keys(filters).filter((id) => filters[id].length),
  );
  useEffect(() => {
    const activeIds = Object.keys(filters).filter((id) => filters[id].length);
    setRetainedIds((ids) =>
      activeIds.every((id) => ids.includes(id))
        ? ids
        : [...new Set([...ids, ...activeIds])],
    );
  }, [filters]);
  const property = properties.find((p) => p.id === open?.propertyId);
  // Keep cleared conditions editable only until this saved filter view closes.
  const conditions = (orderColumns(properties, []) as Property[]).filter(
    (p) => filters[p.id]?.length || retainedIds.includes(p.id),
  );
  function close(restoreFocus = false) {
    setOpen(null);
    if (restoreFocus)
      (open && property ? open.trigger : root.current)?.focus({
        preventScroll: true,
      });
  }
  return (
    <div
      ref={root}
      className="active-filter-conditions"
      role="group"
      aria-label="적용된 필터 조건"
      tabIndex={-1}
    >
      {conditions.map((p) => {
        const selected = filters[p.id] || [];
        const summary = selected.length
          ? selected
              .map((v) => (v === "" ? "미지정" : displayValueFor(p, v, users)))
              .join(", ")
          : "전체 표시";
        const excluded =
          !!selected.length && view.propertyFilterModes?.[p.id] === "exclude";
        const label = `${p.name}: ${summary}${excluded ? " 제외" : ""}`;
        return (
          <button
            key={p.id}
            type="button"
            className={`active-filter-condition${selected.length ? "" : " is-cleared"}`}
            title={label}
            aria-label={`${p.name} 필터 변경: ${summary}${excluded ? " 제외" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={open?.propertyId === p.id}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              if (open?.propertyId === p.id) {
                close(true);
                return;
              }
              const trigger = e.currentTarget;
              const box = trigger.getBoundingClientRect();
              setOpen({
                propertyId: p.id,
                x: box.left,
                y: box.bottom + 5,
                trigger,
              });
            }}
          >
            <span className="active-filter-condition-name">{p.name}:</span>
            <span className="active-filter-condition-value">{summary}</span>
            {excluded && (
              <span className="active-filter-condition-mode">제외</span>
            )}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        );
      })}
      {!conditions.length && (
        <span className="active-filter-empty">전체 표시</span>
      )}
      {children}
      {open && property && (
        <GridHeaderMenu
          key={property.id}
          x={open.x}
          y={open.y}
          title={`${property.name} 필터`}
          actions={[]}
          anchor={open.trigger}
          scrollContainer={root.current}
          onClose={close}
        >
          <PropertyFilter
            property={property}
            tasks={tasks}
            users={users}
            selected={filters[property.id] || []}
            mode={view.propertyFilterModes?.[property.id] || "include"}
            onChange={(values) =>
              onChange({
                propertyFilters: { ...filters, [property.id]: values },
              })
            }
            onModeChange={(mode) =>
              onChange({
                propertyFilterModes: {
                  ...view.propertyFilterModes,
                  [property.id]: mode,
                },
              })
            }
          />
        </GridHeaderMenu>
      )}
    </div>
  );
}
