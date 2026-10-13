import Select from "./Select";
import { useEffect, useRef, useState } from "react";
import { Plus, GripVertical, Trash2 } from "lucide-react";
import { reorderItems, useListReorder, type Placement } from "./useListReorder";
import type { Team, Settings, Property, PropertyOption } from "./types";
import {
  normalizeSettings,
  propertiesFor,
  orderColumns,
  PROPERTY_VALUE_MAX_LENGTH,
  CORE_PROPERTY_KEYS,
  shortId,
} from "../shared/domain.js";
import { send } from "./api";
import { Button, ErrorNote } from "./components";
import Toast, { useToast } from "./Toast";
import PropertyBadge from "./PropertyBadge";
import PropertyColumnOrder from "./PropertyColumnOrder";
import BorderControls from "./BorderControls";
const kinds = {
  option: { name: "Option", description: "선택형" },
  text: { name: "Text", description: "텍스트" },
  date: { name: "Date", description: "날짜" },
  number: { name: "Number", description: "숫자" },
  member: { name: "Member", description: "팀원" },
};
const displays = {
  text: "일반 텍스트",
  round: "원형 칩",
  square: "사각형 칩",
  dot: "포인트 칩",
  emoji: "이모지 칩",
};
const WEEK_COLUMNS: Property = {
  id: "__weeks",
  name: "주차 날짜",
  display: "text",
  values: [],
};
export default function PropertiesManager({
  team,
  onSaved,
}: {
  team: Team;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>(() =>
    normalizeSettings(team.settings),
  );
  const [selected, setSelected] = useState(
      propertiesFor(team.settings)[0]?.id || "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);
  const [message, setMessage] = useToast();
  const root = useRef<HTMLDivElement>(null),
    stored = useRef(settings);
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.id === "property") {
      root.current
        ?.querySelector(".property-list-row.current")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    root.current
      ?.querySelector<HTMLInputElement>(
        focusTarget.id === "property"
          ? "[data-property-name]"
          : `input[data-option-name="${focusTarget.id}"]`,
      )
      ?.focus();
  }, [focusTarget]);
  const properties = settings.properties || [],
    active = properties.filter((p) => !p.archived),
    property = active.find((p) => p.id === selected);
  const columnList = orderColumns(active, [WEEK_COLUMNS]) as Property[];
  const values = property?.values.filter((v) => !v.archived) || [];
  function update(items: Property[]) {
    setSettings((s) => ({ ...s, properties: items }));
    setMessage("");
    setError("");
  }
  function addProperty() {
    const blank = active.find((p) => !p.name.trim());
    if (blank) {
      setSelected(blank.id);
      setFocusTarget({ id: "property" });
      return;
    }
    const p: Property = {
      id: shortId("p"),
      name: "",
      kind: "option",
      visible: true,
      placement: "beforeWeeks",
      display: "square",
      values: [],
    };
    update([...properties, p]);
    setSelected(p.id);
    setFocusTarget({ id: "property" });
  }
  function moveColumn(id: string, targetId: string, placement: Placement) {
    const next = reorderItems(columnList, id, targetId, placement);
    const weekIndex = next.findIndex((p) => p.id === WEEK_COLUMNS.id);
    update([
      ...next.flatMap((p, i): Property[] =>
        p.id === WEEK_COLUMNS.id
          ? []
          : [{ ...p, placement: i < weekIndex ? "beforeWeeks" : "afterWeeks" }],
      ),
      ...properties.filter((p) => p.archived),
    ]);
  }
  function patchProperty(patch: Partial<Property>) {
    if (property)
      update(
        properties.map((p) => (p.id === property.id ? { ...p, ...patch } : p)),
      );
  }
  function patchValue(id: string, patch: Partial<PropertyOption>) {
    if (property)
      patchProperty({
        values: property.values.map((v) =>
          v.id === id ? { ...v, ...patch } : v,
        ),
      });
  }
  const valueReorder = useListReorder<HTMLTableSectionElement>(
    values.map((v) => v.id),
    (id, targetId, placement) => {
      if (property)
        patchProperty({
          values: [
            ...reorderItems(values, id, targetId, placement),
            ...property.values.filter((v) => v.archived),
          ],
        });
    },
    busy,
  );
  function removeValue(id: string) {
    if (!property) return;
    const saved = stored.current.properties
      ?.find((p) => p.id === property.id)
      ?.values.find((v) => v.id === id);
    patchProperty({
      values: property.values.flatMap((v) =>
        v.id !== id ? [v] : saved ? [{ ...saved, archived: true }] : [],
      ),
    });
  }
  function validateNames() {
    const status = properties.find((p) => p.id === "status");
    if (!status?.values.some((v) => !v.archived))
      throw new Error("기본 상태에는 선택값이 하나 이상 필요합니다.");
    for (const p of properties.filter((p) => !p.archived)) {
      if (!p.name.trim()) {
        setSelected(p.id);
        setFocusTarget({ id: "property" });
        throw new Error("속성 이름을 입력하세요.");
      }
      for (const v of p.values.filter((v) => !v.archived)) {
        const previous = stored.current.properties
          ?.find((s) => s.id === p.id)
          ?.values.find((s) => s.id === v.id);
        if (
          !v.label.trim() ||
          (v.label.trim().length > PROPERTY_VALUE_MAX_LENGTH &&
            v.label.trim() !== previous?.label)
        ) {
          setSelected(p.id);
          setFocusTarget({ id: v.id });
          throw new Error(
            `${p.name}의 값 이름을 1~${PROPERTY_VALUE_MAX_LENGTH}자로 입력하세요.`,
          );
        }
      }
    }
  }
  return (
    <div ref={root} className="properties-manager">
      <div className="properties-heading">
        <p className="field-help">
          속성을 좌우로 끌어 순서를 바꾸고, 클릭하여 편집하세요. ‘주차 날짜’
          오른쪽의 속성은 마지막 날짜 뒤에 표시됩니다.
        </p>
        <Button
          className="property-add"
          title="속성 추가"
          disabled={busy}
          onClick={addProperty}
        >
          <Plus size={15} />
          속성 추가
        </Button>
      </div>
      <ErrorNote error={error} />
      <Toast message={message} />
      <div className="properties-layout">
        <PropertyColumnOrder
          items={columnList.map((p) => ({
            id: p.id,
            name: p.name || "이름 없는 속성",
            week: p.id === WEEK_COLUMNS.id,
            description:
              p.id === WEEK_COLUMNS.id
                ? "전체 주차 묶음"
                : kinds[p.kind || "option"].name,
          }))}
          selected={selected}
          disabled={busy}
          onSelect={setSelected}
          onMove={moveColumn}
        />
        {properties.some((p) => p.archived) && (
          <details className="archived-properties">
            <summary>보관된 속성</summary>
            {properties
              .filter((p) => p.archived)
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    update(
                      properties.map((v) =>
                        v.id === p.id ? { ...v, archived: false } : v,
                      ),
                    );
                    setSelected(p.id);
                  }}
                >
                  {p.name} 복원
                </button>
              ))}
          </details>
        )}
        {selected === WEEK_COLUMNS.id && (
          <section className="property-editor" aria-label="주차 날짜 배치 안내">
            <h3>주차 날짜</h3>
            <fieldset className="week-header-colors" disabled={busy}>
              <legend>머리글 색</legend>
              {(
                [
                  ["backgroundColor", "배경색", "#f7f9f9"],
                  ["color", "글자색", "#72868b"],
                ] as const
              ).map(([key, label, fallback]) => (
                <label key={key}>
                  {label}
                  <input
                    type="color"
                    aria-label={`주차 머리글 ${label}`}
                    value={settings.weekHeader?.[key] || fallback}
                    onChange={(e) => {
                      const color = e.target.value;
                      setSettings((s) => ({
                        ...s,
                        weekHeader: { ...s.weekHeader, [key]: color },
                      }));
                      setMessage("");
                    }}
                  />
                </label>
              ))}
              <span
                className="week-header-preview"
                aria-hidden="true"
                style={{
                  background: settings.weekHeader?.backgroundColor,
                  color: settings.weekHeader?.color,
                }}
              >
                3/2
              </span>
              <Button
                disabled={
                  !settings.weekHeader?.color &&
                  !settings.weekHeader?.backgroundColor
                }
                onClick={() => {
                  setSettings((s) => ({ ...s, weekHeader: {} }));
                  setMessage("");
                }}
              >
                기본값
              </Button>
            </fieldset>
            <p className="field-help">
              날짜 열 머리글에만 적용됩니다. 이번 주와 선택한 열은 강조색으로
              표시합니다.
            </p>
            <fieldset className="week-boundary-settings" disabled={busy}>
              <legend>기본 경계선</legend>
              <div className="week-boundary-controls">
                {(
                  [
                    ["left", "왼쪽 경계선"],
                    ["right", "오른쪽 경계선"],
                  ] as const
                ).map(([side, label]) => (
                  <BorderControls
                    key={side}
                    label={label}
                    value={settings.weekBorders?.[side]}
                    allowNone
                    onChange={(border) => {
                      setSettings((s) => ({
                        ...s,
                        weekBorders: { ...s.weekBorders, [side]: border },
                      }));
                      setMessage("");
                      setError("");
                    }}
                  />
                ))}
              </div>
              <p className="field-help">
                현재 보이는 첫 날짜의 왼쪽과 마지막 날짜의 오른쪽에 적용합니다.
                기간을 바꾸거나 날짜 열을 숨기면 새 경계로 이동하며, 셀에서
                별도로 그린 선이 우선합니다. 셀 테두리를 지우면 기본 경계선이
                표시됩니다.
              </p>
            </fieldset>
            <p className="field-help">
              조회 기간에 해당하는 날짜 열을 한 묶음으로 표시합니다. 이 항목
              오른쪽에 놓인 속성은 마지막 날짜 뒤에 나타납니다.
            </p>
            <p className="field-help">
              속성을 날짜 뒤에 두려면 위 목록에서 좌우로 끌어 순서를 바꾼 뒤
              속성 저장을 누르세요. 팀원 모두에게 적용됩니다.
            </p>
          </section>
        )}
        {property && (
          <section className="property-editor" aria-label="속성 편집">
            <div className="form-grid">
              <label>
                속성 이름
                <input
                  data-property-name
                  value={property.name}
                  placeholder="속성 이름 입력"
                  maxLength={50}
                  onChange={(e) => patchProperty({ name: e.target.value })}
                />
              </label>
              <label>
                <span className="property-type-label">
                  타입
                  {CORE_PROPERTY_KEYS.includes(property.id) && (
                    <small>(필수 고정 타입)</small>
                  )}
                </span>
                <Select
                  aria-label="타입"
                  value={property.kind || "option"}
                  disabled={[...CORE_PROPERTY_KEYS, "supporters"].includes(
                    property.id,
                  )}
                  onChange={(e) =>
                    patchProperty({
                      kind: e.target.value as Property["kind"],
                      display:
                        e.target.value === "option"
                          ? "square"
                          : e.target.value === "member"
                            ? "avatar"
                            : "text",
                      multiple: false,
                      values: property.values.filter((v) => v.label.trim()),
                    })
                  }
                >
                  {Object.entries(kinds).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.name} · {v.description}
                    </option>
                  ))}
                </Select>
              </label>
              {(property.kind === "option" || property.kind === "member") && (
                <label>
                  표시 모양
                  <Select
                    value={property.display}
                    onChange={(e) =>
                      patchProperty({
                        display: e.target.value as Property["display"],
                      })
                    }
                  >
                    {Object.entries(
                      property.kind === "member"
                        ? { text: "일반 텍스트", avatar: "아바타" }
                        : displays,
                    ).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {property.kind === "member" && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    aria-label="여러 팀원 선택"
                    checked={!!property.multiple}
                    disabled={["owner", "supporters"].includes(property.id)}
                    onChange={(e) =>
                      patchProperty({ multiple: e.target.checked })
                    }
                  />
                  여러 팀원 선택
                </label>
              )}
            </div>
            {["owner", "supporters"].includes(property.id) && (
              <p className="field-help">
                팀원·지원자는 업무 편집 권한과 연결된 Member 속성입니다.
                이름·표시·순서는 변경할 수 있으며 기본 팀원 속성은 삭제할 수
                없습니다.{" "}
                {property.id === "owner"
                  ? "팀원은 업무를 책임지는 한 사람이라 단일 선택으로 고정됩니다. 함께하는 사람은 지원자로 지정하세요."
                  : "지원자는 여러 명을 지정하는 속성이라 복수 선택으로 고정됩니다."}{" "}
                여러 사람을 고르는 별도 열이 필요하면 Member 속성을 새로
                추가하세요.
              </p>
            )}
            {property.id === "title" && (
              <p className="field-help">
                기본 작업 열은 이름과 순서를 바꿀 수 있으며 항상 표시됩니다.
              </p>
            )}
            {property.id === "status" && (
              <p className="field-help">
                기본 상태는 삭제하거나 타입을 바꿀 수 없습니다. 값의
                이름·색상·순서를 변경하면 상단 상태별 통계에도 반영됩니다.
              </p>
            )}
            {property.kind !== "option" && (
              <p className="field-help">
                {property.kind === "member"
                  ? "팀에 배속된 팀원을 셀에서 선택합니다."
                  : "셀을 더블클릭하여 직접 입력합니다."}
              </p>
            )}
            {property.kind === "option" && (
              <>
                <div className="section-heading">
                  <h3>
                    속성 값 <small>{values.length}개</small>
                  </h3>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const blank = values.find((v) => !v.label.trim());
                      if (blank) {
                        setFocusTarget({ id: blank.id });
                        return;
                      }
                      const option: PropertyOption = {
                        id: shortId("o"),
                        label: "",
                        backgroundColor: "#edf6f4",
                        dotColor: "#177b70",
                        emoji: "📌",
                      };
                      patchProperty({ values: [...property.values, option] });
                      setFocusTarget({ id: option.id });
                    }}
                  >
                    <Plus size={14} />값 추가
                  </Button>
                </div>
                <p className="field-help property-value-help">
                  값 이름은 최대 {PROPERTY_VALUE_MAX_LENGTH}자까지 입력할 수
                  있습니다.
                </p>
                <div className="settings-table-scroll">
                  <table className="settings-table property-values">
                    <colgroup>
                      <col style={{ width: 40 }} />
                      <col style={{ width: 160 }} />
                      {property.display !== "emoji" && (
                        <col style={{ width: 62 }} />
                      )}
                      {property.display === "dot" && (
                        <col style={{ width: 62 }} />
                      )}
                      {property.display === "emoji" && (
                        <col style={{ width: 72 }} />
                      )}
                      <col />
                      <col style={{ width: 48 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>순서</th>
                        <th>값 이름</th>
                        {property.display !== "emoji" && <th>배경색</th>}
                        {property.display === "dot" && <th>점 색상</th>}
                        {property.display === "emoji" && <th>이모지</th>}
                        <th>미리보기</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody ref={valueReorder.root}>
                      {values.map((v, i) => (
                        <tr
                          key={v.id}
                          data-option-id={v.id}
                          {...valueReorder.itemProps(v.id)}
                        >
                          <td>
                            <button
                              {...valueReorder.handleProps(v.id)}
                              aria-label={`${v.label || "새 값"} 값 순서 이동`}
                            >
                              <GripVertical size={15} aria-hidden="true" />
                            </button>
                          </td>
                          <td>
                            <input
                              aria-label={`속성 값 ${i + 1} 이름`}
                              data-option-name={v.id}
                              placeholder="값 이름 입력"
                              value={v.label}
                              maxLength={PROPERTY_VALUE_MAX_LENGTH}
                              onChange={(e) =>
                                patchValue(v.id, { label: e.target.value })
                              }
                            />
                          </td>
                          {property.display !== "emoji" && (
                            <td>
                              <input
                                type="color"
                                aria-label={`${v.label} 배경색`}
                                value={v.backgroundColor}
                                onChange={(e) =>
                                  patchValue(v.id, {
                                    backgroundColor: e.target.value,
                                  })
                                }
                              />
                            </td>
                          )}
                          {property.display === "dot" && (
                            <td>
                              <input
                                type="color"
                                aria-label={`${v.label} 점 색상`}
                                value={v.dotColor}
                                onChange={(e) =>
                                  patchValue(v.id, { dotColor: e.target.value })
                                }
                              />
                            </td>
                          )}
                          {property.display === "emoji" && (
                            <td>
                              <input
                                className="emoji-input"
                                aria-label={`${v.label} 이모지`}
                                value={v.emoji}
                                maxLength={24}
                                onChange={(e) =>
                                  patchValue(v.id, { emoji: e.target.value })
                                }
                              />
                            </td>
                          )}
                          <td className="property-value-preview">
                            {v.label.trim() ? (
                              <PropertyBadge property={property} value={v.id} />
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            <Button
                              title={`${v.label} 값 제거`}
                              disabled={busy}
                              onClick={() => removeValue(v.id)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!values.length && (
                  <p className="field-help">
                    값 추가를 눌러 선택 항목을 만드세요.
                  </p>
                )}
                {property.values.some((v) => v.archived) && (
                  <details className="archived-properties">
                    <summary>보관된 값</summary>
                    {property.values
                      .filter((v) => v.archived)
                      .map((v) => (
                        <button
                          key={v.id}
                          onClick={() => patchValue(v.id, { archived: false })}
                        >
                          {v.label} 복원
                        </button>
                      ))}
                  </details>
                )}
              </>
            )}
            <p className="field-help">
              이름을 바꿔도 업무에 선택한 값은 유지됩니다. 제거한 속성과 값은
              보관되어 복원할 수 있습니다.
            </p>
          </section>
        )}
      </div>
      <footer className="form-actions">
        {property && !CORE_PROPERTY_KEYS.includes(property.id) && (
          <Button
            className="danger"
            title="선택 속성 삭제"
            disabled={busy}
            onClick={() => {
              const saved = stored.current.properties?.find(
                (p) => p.id === property.id,
              );
              if (
                !confirm(
                  `“${property.name.trim() || "이름 없는 속성"}” 속성을 삭제할까요?\n${saved ? "업무 표와 선택 목록에서 숨겨지며, 기존 업무 값은 보관됩니다.\n속성 저장을 눌러야 적용됩니다." : "아직 저장하지 않은 속성과 입력한 값을 지웁니다."}`,
                )
              )
                return;
              update(
                properties.flatMap((p) =>
                  p.id !== property.id
                    ? [p]
                    : saved
                      ? [{ ...saved, archived: true }]
                      : [],
                ),
              );
              setSelected(active.find((p) => p.id !== property.id)?.id || "");
              setError("");
            }}
          >
            <Trash2 size={14} />
            속성 삭제
          </Button>
        )}
        <Button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            setMessage("");
            try {
              validateNames();
              const result = await send(
                `/teams/${team.id}/settings`,
                settings,
                "PATCH",
              );
              setSettings(result.settings);
              stored.current = result.settings;
              await onSaved();
              setMessage("속성이 저장되었습니다.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          속성 저장
        </Button>
      </footer>
    </div>
  );
}
