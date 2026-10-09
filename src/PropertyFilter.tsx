import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { Property, Task, User, Settings } from "./types";
import { propertyValue, value, displayValue } from "../shared/domain.js";
import { Button } from "./components";
import PropertyBadge from "./PropertyBadge";

export default function PropertyFilter({
  property,
  tasks,
  users,
  settings,
  selected,
  onChange,
}: {
  property: Property;
  tasks: Task[];
  users: User[];
  settings: Settings;
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const [search, setSearch] = useState("");
  const values =
    property.kind === "option"
      ? property.values
          .filter(
            (o) => !o.archived || selected.includes(propertyValue(property, o)),
          )
          .map((o) => ({
            value: propertyValue(property, o),
            label: o.label,
            archived: o.archived,
          }))
      : property.kind === "member"
        ? users.map((u) => ({ value: u.id, label: u.name, archived: false }))
        : [
            ...new Set([
              ...tasks.map((t) => String(value(t, property.id))),
              ...selected,
            ]),
          ]
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
            .map((v) => ({ value: v, label: v, archived: false }));
  const matching = values.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()),
  );
  function toggle(value: string, checked: boolean) {
    onChange(
      checked ? [...selected, value] : selected.filter((v) => v !== value),
    );
  }
  return (
    <div
      ref={root}
      className="popover-root property-filter"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          root.current?.querySelector("button")?.focus();
        }
      }}
    >
      <Button
        title={`${property.name} 필터`}
        className={selected.length ? "filter-active" : ""}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selected.length
          ? `${property.name} ${selected.length}개`
          : `모든 ${property.name}`}
        <ChevronDown size={12} />
      </Button>
      {open && (
        <div
          className="popover property-filter-popover"
          role="group"
          aria-label={`${property.name} 필터 선택`}
        >
          <div className="popover-title">
            <strong>{property.name}</strong>
            <Button
              title={`${property.name} 필터 닫기`}
              onClick={() => setOpen(false)}
            >
              <X size={14} />
            </Button>
          </div>
          <input
            type="search"
            aria-label={`${property.name} 필터 값 검색`}
            placeholder="값 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="property-filter-values">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selected.includes("")}
                onChange={(e) => toggle("", e.target.checked)}
              />
              미지정
            </label>
            {matching.slice(0, 200).map((option) => {
              const v = option.value;
              return (
                <label className="checkbox" key={option.value}>
                  <input
                    type="checkbox"
                    checked={selected.includes(v)}
                    onChange={(e) => toggle(v, e.target.checked)}
                  />
                  {property.kind === "option" ? (
                    <PropertyBadge property={property} value={v} />
                  ) : (
                    <span>{option.label}</span>
                  )}
                  {option.archived && <small>보관됨</small>}
                </label>
              );
            })}
          </div>
          {matching.length > 200 && (
            <small>검색어를 입력하여 나머지 값을 찾으세요.</small>
          )}
          <Button onClick={() => onChange([])}>
            {property.name} 필터 해제
          </Button>
        </div>
      )}
    </div>
  );
}
