import { useId, useState, useMemo } from "react";
import type { FilterMode, Property, Task, User } from "./types";
import { value } from "../shared/domain.js";
import { Button } from "./components";
import PropertyBadge from "./PropertyBadge";

export default function PropertyFilter({
  property,
  tasks,
  users,
  selected,
  mode,
  onChange,
  onModeChange,
}: {
  property: Property;
  tasks: Task[];
  users: User[];
  selected: string[];
  mode: FilterMode;
  onChange: (values: string[]) => void;
  onModeChange: (mode: FilterMode) => void;
}) {
  const modeId = useId();
  const [search, setSearch] = useState("");
  // 텍스트·날짜·숫자 속성은 전체 업무를 훑어 값 목록을 만든다. 키 입력마다 반복하지 않는다.
  const values = useMemo(
    () =>
      property.kind === "option"
        ? property.values
            .filter((o) => !o.archived || selected.includes(o.id))
            .map((o) => ({
              value: o.id,
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
              .map((v) => ({ value: v, label: v, archived: false })),
    [property, tasks, users, selected],
  );
  const matching = useMemo(
    () =>
      values.filter((o) =>
        o.label.toLowerCase().includes(search.toLowerCase()),
      ),
    [values, search],
  );
  function toggle(value: string, checked: boolean) {
    onChange(
      checked ? [...selected, value] : selected.filter((v) => v !== value),
    );
  }
  return (
    <div
      className="property-filter"
      role="group"
      aria-label={`${property.name} 필터 선택`}
    >
      <div className="property-filter-title">
        <strong>필터</strong>
        <span>
          {selected.length
            ? `${selected.length}개 ${mode === "exclude" ? "제외" : "일치"}`
            : "전체 표시"}
        </span>
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
      <div className="property-filter-footer">
        <div
          className="property-filter-mode"
          role="radiogroup"
          aria-label={`${property.name} 필터 방식`}
        >
          {(["include", "exclude"] as const).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name={modeId}
                value={option}
                checked={mode === option}
                onChange={() => onModeChange(option)}
              />
              <span>{option === "include" ? "일치" : "제외"}</span>
            </label>
          ))}
        </div>
        <Button
          title={`${property.name} 필터 해제`}
          disabled={!selected.length}
          onClick={() => onChange([])}
        >
          필터 해제
        </Button>
      </div>
    </div>
  );
}
