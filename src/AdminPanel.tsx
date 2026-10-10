import Select from "./Select";
import { useEffect, useRef, useState } from "react";
import { Plus, ArrowUp, ArrowDown, Trash2, CalendarDays } from "lucide-react";
import type { User, Team, Settings, Property, PropertyOption } from "./types";
import {
  normalizeSettings,
  propertiesFor,
  orderColumns,
  propertyValue,
  BUILTIN_PROPERTIES,
  PROPERTY_VALUE_MAX_LENGTH,
  CORE_PROPERTY_KEYS,
} from "../shared/domain.js";
import { api, send } from "./api";
import { Modal, Button, ErrorNote, Avatar } from "./components";
import PropertyBadge from "./PropertyBadge";
import DefaultStyleManager from "./DefaultStyleManager";
import ThemePicker from "./ThemePicker";
import AvatarEditor from "./AvatarEditor";
import { getTheme } from "../shared/themes.js";
import type { ThemeId } from "./types";
const roleNames = {
  admin: "시스템 관리자",
  manager: "팀 관리자",
  member: "팀원",
  viewer: "열람자",
};
const kinds = {
  option: "Option · 선택형",
  text: "Text · 텍스트",
  date: "Date · 날짜",
  number: "Number · 숫자",
  member: "Member · 팀원",
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
function move<T extends { id: string; archived?: boolean }>(
  items: T[],
  id: string,
  delta: number,
) {
  const active = items.filter((v) => !v.archived),
    index = active.findIndex((v) => v.id === id),
    target = index + delta;
  if (target < 0 || target >= active.length) return items;
  [active[index], active[target]] = [active[target], active[index]];
  return [...active, ...items.filter((v) => v.archived)];
}
function TeamRow({
  team,
  users,
  onSaved,
  onError,
  onDeleted,
}: {
  team: Team;
  users: User[];
  onSaved: () => Promise<void>;
  onError: (s: string) => void;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(team.name),
    [theme, setTheme] = useState<ThemeId>(getTheme(team.settings.theme).id),
    [memberIds, setMemberIds] = useState(
      users.filter((u) => u.teamIds.includes(team.id)).map((u) => u.id),
    ),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(team.name);
    setTheme(getTheme(team.settings.theme).id);
    setMemberIds(
      users.filter((u) => u.teamIds.includes(team.id)).map((u) => u.id),
    );
  }, [team, users]);
  return (
    <tr>
      <td>
        <input
          aria-label={`${team.name} 팀 이름`}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </td>
      <td>
        <details className="member-picker">
          <summary>팀원 선택 · {memberIds.length}명</summary>
          <div className="check-grid">
            {users.map((u) => (
              <label className="checkbox" key={u.id}>
                <input
                  type="checkbox"
                  checked={memberIds.includes(u.id)}
                  onChange={(e) =>
                    setMemberIds(
                      e.target.checked
                        ? [...memberIds, u.id]
                        : memberIds.filter((id) => id !== u.id),
                    )
                  }
                />
                {u.name}{" "}
                <small>
                  {u.username}
                  {u.active ? "" : " · 비활성"}
                </small>
              </label>
            ))}
          </div>
        </details>
        <div className="member-names">
          {users
            .filter((u) => memberIds.includes(u.id))
            .map((u) => u.name)
            .join(", ") || "선택된 팀원 없음"}
        </div>
      </td>
      <td className="team-theme-cell">
        <ThemePicker
          label={`${team.name} 테마`}
          value={theme}
          onChange={setTheme}
          disabled={busy}
        />
      </td>
      <td>
        <div className="team-row-actions">
          <Button
            disabled={busy || !name.trim()}
            title={`${team.name} 팀 저장`}
            onClick={async () => {
              setBusy(true);
              onError("");
              try {
                await send(
                  `/admin/teams/${team.id}`,
                  {
                    name,
                    memberIds,
                    theme,
                    settingsRevision: team.settings.revision || 0,
                  },
                  "PATCH",
                );
                await onSaved();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            저장
          </Button>
          <Button
            title={`${team.name} 팀 삭제`}
            className="danger team-delete"
            disabled={busy}
            onClick={async () => {
              if (
                !confirm(
                  `“${team.name}” 팀을 정말 삭제하시겠습니까?\n\n이 팀의 모든 연도 업무·일정·셀 서식·속성·보고본·저장 보기·변경 이력·가져오기 기록 등 모든 팀 데이터가 영구 삭제됩니다. 삭제한 데이터는 복구할 수 없습니다.\n\n팀원 계정과 다른 팀의 데이터는 유지됩니다.`,
                )
              )
                return;
              setBusy(true);
              onError("");
              try {
                await send(
                  `/admin/teams/${team.id}`,
                  { confirmed: true },
                  "DELETE",
                );
                await onDeleted();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </td>
    </tr>
  );
}
function PropertiesManager({
  team,
  visibleFields,
  onVisibilitySaved,
  onSaved,
}: {
  team: Team;
  visibleFields?: string[];
  onVisibilitySaved?: (changes: Record<string, boolean>) => void;
  onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>(() =>
    normalizeSettings(team.settings),
  );
  const [selected, setSelected] = useState(
      propertiesFor(team.settings)[0]?.id || "",
    ),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);
  const [visibilityChanges, setVisibilityChanges] = useState<
    Record<string, boolean>
  >({});
  const root = useRef<HTMLDivElement>(null),
    stored = useRef(settings);
  useEffect(() => {
    if (!focusTarget) return;
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
  function moveColumn(id: string, delta: number) {
    const next = move(columnList, id, delta);
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
      <p className="field-help">
        {team.name}의 공통 열 배치를 설정합니다. 위·아래 버튼으로 속성을 ‘주차
        날짜’ 아래로 옮기면 마지막 날짜 뒤에 표시됩니다. 체크박스로 열의 기본
        표시 여부를 정합니다.
      </p>
      <ErrorNote error={error} />
      {message && (
        <p role="status" className="success-note">
          {message}
        </p>
      )}
      <div className="properties-layout">
        <div className="property-list">
          {columnList.map((p, i) => (
            <div
              className={`property-list-row ${p.id === WEEK_COLUMNS.id ? "week-column-row" : ""} ${p.id === selected ? "current" : ""}`}
              key={p.id}
              data-column-item={p.id}
            >
              <button
                className={
                  p.id === WEEK_COLUMNS.id
                    ? "week-column-select"
                    : "property-select"
                }
                onClick={() => setSelected(p.id)}
              >
                {p.id === WEEK_COLUMNS.id && (
                  <CalendarDays size={14} aria-hidden="true" />
                )}
                {p.name || "이름 없는 속성"}
                <small>
                  {p.id === WEEK_COLUMNS.id ? (
                    "전체 주차 묶음"
                  ) : (
                    <>
                      {CORE_PROPERTY_KEYS.includes(p.id) && "기본 · "}
                      {p.kind === "option"
                        ? `${p.values.filter((v) => !v.archived).length}개 값`
                        : kinds[p.kind || "option"]}
                    </>
                  )}
                </small>
              </button>
              {p.id !== WEEK_COLUMNS.id && (
                <input
                  type="checkbox"
                  aria-label={`${p.name || "새 속성"} 열 표시`}
                  checked={
                    visibilityChanges[p.id] ??
                    (visibleFields &&
                    stored.current.properties?.some((v) => v.id === p.id)
                      ? visibleFields.includes(p.id)
                      : p.visible !== false)
                  }
                  disabled={p.id === "title"}
                  onChange={(e) => {
                    setVisibilityChanges((s) => ({
                      ...s,
                      [p.id]: e.target.checked,
                    }));
                    update(
                      properties.map((v) =>
                        v.id === p.id ? { ...v, visible: e.target.checked } : v,
                      ),
                    );
                  }}
                />
              )}
              <div className="order-buttons">
                <Button
                  title={`${p.name}${p.id === WEEK_COLUMNS.id ? "" : " 속성"} 위로`}
                  disabled={i === 0}
                  onClick={() => moveColumn(p.id, -1)}
                >
                  <ArrowUp size={13} />
                </Button>
                <Button
                  title={`${p.name}${p.id === WEEK_COLUMNS.id ? "" : " 속성"} 아래로`}
                  disabled={i === columnList.length - 1}
                  onClick={() => moveColumn(p.id, 1)}
                >
                  <ArrowDown size={13} />
                </Button>
              </div>
            </div>
          ))}
          <Button
            title="속성 추가"
            disabled={busy}
            onClick={() => {
              const blank = active.find((p) => !p.name.trim());
              if (blank) {
                setSelected(blank.id);
                setFocusTarget({ id: "property" });
                return;
              }
              const p: Property = {
                id: `prop_${crypto.randomUUID()}`,
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
            }}
          >
            <Plus size={15} />
            속성 추가
          </Button>
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
        </div>
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
              표시합니다. 날짜 경계선은 표에서 셀을 선택한 뒤 테두리 도구로
              지정하세요.
            </p>
            <p className="field-help">
              조회 기간에 해당하는 날짜 열을 한 묶음으로 표시합니다. 이 항목
              아래에 놓인 속성은 마지막 날짜 뒤에 나타납니다.
            </p>
            <p className="field-help">
              진척률·목표일을 날짜 뒤에 두려면 왼쪽 목록의 위·아래 버튼으로
              순서를 바꾼 뒤 속성 저장을 누르세요. 팀원 모두에게 적용됩니다.
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
                속성 종류
                <Select
                  aria-label="속성 종류"
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
                      {v}
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
                없습니다.
              </p>
            )}
            {property.id === "title" && (
              <p className="field-help">
                기본 작업 열은 이름과 순서를 바꿀 수 있으며 항상 표시됩니다.
              </p>
            )}
            {property.id === "status" && (
              <p className="field-help">
                기본 상태는 삭제하거나 종류를 바꿀 수 없습니다. 값의
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
                        id: `opt_${crypto.randomUUID()}`,
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
                <div className="admin-table-scroll">
                  <table className="admin-table property-values">
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
                    <tbody>
                      {values.map((v, i) => (
                        <tr key={v.id} data-option-id={v.id}>
                          <td>
                            <div className="order-buttons">
                              <span>{i + 1}</span>
                              <Button
                                title={`${v.label} 값 위로`}
                                disabled={i === 0}
                                onClick={() =>
                                  patchProperty({
                                    values: move(property.values, v.id, -1),
                                  })
                                }
                              >
                                <ArrowUp size={13} />
                              </Button>
                              <Button
                                title={`${v.label} 값 아래로`}
                                disabled={i === values.length - 1}
                                onClick={() =>
                                  patchProperty({
                                    values: move(property.values, v.id, 1),
                                  })
                                }
                              >
                                <ArrowDown size={13} />
                              </Button>
                            </div>
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
                          <td>
                            {v.label.trim() ? (
                              <PropertyBadge
                                property={property}
                                value={propertyValue(property, v)}
                              />
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
              onVisibilitySaved?.(visibilityChanges);
              setMessage("속성 설정을 저장했습니다.");
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
export default function AdminPanel({
  user,
  team,
  onClose,
  onRefresh,
  visibleFields,
  onVisibilitySaved,
}: {
  user: User;
  team: Team;
  visibleFields: string[];
  onVisibilitySaved: (changes: Record<string, boolean>) => void;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState(
    user.role === "admin" ? "teams" : "properties",
  );
  const [data, setData] = useState<{ users: User[]; teams: Team[] }>({
    users: [],
    teams: [team],
  });
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<Partial<User> | null>(null),
    [teamName, setTeamName] = useState(""),
    [newTeamTheme, setNewTeamTheme] = useState<ThemeId>("mint"),
    [templateTeamId, setTemplateTeamId] = useState(""),
    [memberTeam, setMemberTeam] = useState(""),
    [propertyTeam, setPropertyTeam] = useState(team.id);
  const isAdmin = user.role === "admin";
  const [avatarLoading, setAvatarLoading] = useState(false);
  async function refresh() {
    if (isAdmin) setData(await api("/admin/users"));
    else {
      const b = await api("/bootstrap");
      setData({ users: b.users, teams: b.teams });
    }
  }
  async function saved() {
    await refresh();
    await onRefresh();
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  async function saveUser(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await send(
        edit?.id ? `/admin/users/${edit.id}` : "/admin/users",
        {
          name: f.get("name"),
          username: edit?.username || f.get("username"),
          password: String(f.get("password") || "") || undefined,
          role: f.get("role"),
          active: f.get("active") === "on",
          teamIds: f.getAll("teams"),
          color: edit?.color,
          avatarInitials: edit?.avatarInitials,
          avatarImage: edit?.avatarImage,
        },
        edit?.id ? "PATCH" : "POST",
      );
      setEdit(null);
      await saved();
      setMessage("팀원 정보를 저장했습니다.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedTeam = data.teams.find((t) => t.id === propertyTeam) || team;
  const members = memberTeam
    ? data.users.filter((u) => u.teamIds.includes(memberTeam))
    : data.users;
  return (
    <Modal
      title="팀과 계정 관리"
      wide
      className={tab === "format" ? "format-settings-modal" : ""}
      onClose={onClose}
    >
      <div className="admin-tabs" role="tablist" aria-label="관리 메뉴">
        {[
          ["teams", "팀 관리"],
          ["members", "팀원 관리"],
          ["properties", "속성 관리"],
          ["format", "기본 서식"],
        ].map(([key, label]) => (
          <button
            key={key}
            id={`tab-${key}`}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            disabled={!isAdmin && !["properties", "format"].includes(key)}
            onClick={() => {
              setTab(key);
              setError("");
              setMessage("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {!isAdmin && (
        <p className="field-help">
          팀·계정 편집은 시스템 관리자가 담당합니다. 소속 팀의 속성을 관리할 수
          있고 기본 서식을 지정할 수 있습니다.
        </p>
      )}
      <ErrorNote error={error} />
      {message && (
        <p className="success-note" role="status">
          {message}
        </p>
      )}
      <section
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "teams" && (
          <>
            <p className="field-help">
              팀 이름·팀원·테마를 설정한 뒤 저장하세요. 테마는 해당 팀
              스페이스에 적용되며, 팀원은 여러 팀에 함께 배속할 수 있습니다.
            </p>
            <div className="admin-table-scroll">
              <table className="admin-table team-table">
                <thead>
                  <tr>
                    <th>팀 이름</th>
                    <th>팀원</th>
                    <th>테마</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {data.teams.map((t) => (
                    <TeamRow
                      key={t.id}
                      team={t}
                      users={data.users}
                      onDeleted={async () => {
                        if (templateTeamId === t.id) {
                          setTemplateTeamId("");
                          setNewTeamTheme("mint");
                        }
                        if (memberTeam === t.id) setMemberTeam("");
                        if (propertyTeam === t.id) setPropertyTeam("");
                        await saved();
                        setMessage(
                          `“${t.name}” 팀과 모든 팀 데이터를 삭제했습니다.`,
                        );
                      }}
                      onError={setError}
                      onSaved={async () => {
                        await saved();
                        setMessage("팀 정보를 저장했습니다.");
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <h3>신규 팀 추가</h3>
            <form
              className="inline-form team-create-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setBusy(true);
                try {
                  await send("/admin/teams", {
                    name: teamName,
                    theme: newTeamTheme,
                    ...(templateTeamId ? { templateTeamId } : {}),
                  });
                  setTeamName("");
                  setNewTeamTheme("mint");
                  setTemplateTeamId("");
                  await saved();
                  setMessage("팀을 추가했습니다. 목록에서 팀원을 선택하세요.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <input
                aria-label="신규 팀 이름"
                placeholder="팀 이름"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                maxLength={80}
                required
              />
              <Select
                aria-label="새 팀 양식"
                value={templateTeamId}
                onChange={(e) => {
                  setTemplateTeamId(e.target.value);
                  setNewTeamTheme(
                    getTheme(
                      data.teams.find((t) => t.id === e.target.value)?.settings
                        .theme,
                    ).id,
                  );
                }}
              >
                <option value="">기본 양식 · 작업·팀원·상태</option>
                {data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} 양식 복사
                  </option>
                ))}
              </Select>
              <ThemePicker
                label="신규 팀 테마"
                value={newTeamTheme}
                onChange={setNewTeamTheme}
                disabled={busy}
              />
              <Button type="submit" className="primary" disabled={busy}>
                팀 추가
              </Button>
            </form>
            <p className="field-help">
              기본 양식은 작업·팀원·상태로 시작합니다. 양식 복사는 저장된
              속성·선택값·순서·기본 서식·테마를 가져옵니다.
            </p>
          </>
        )}
        {tab === "members" && (
          <>
            <div className="section-heading">
              <h3 aria-live="polite">
                팀원 {members.length}명
                {memberTeam && (
                  <span className="member-total">
                    {" "}
                    / 전체 {data.users.length}명
                  </span>
                )}
              </h3>
              <Button
                onClick={() => {
                  setEdit({ role: "member", active: true, teamIds: [] });
                  setMessage("");
                }}
              >
                <Plus size={16} />
                팀원 추가
              </Button>
            </div>
            <div
              className="member-team-filters"
              role="group"
              aria-label="팀원 소속 팀 필터"
            >
              {[{ id: "", name: "전체" }, ...data.teams].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={memberTeam === t.id}
                  onClick={() => setMemberTeam(t.id)}
                >
                  {t.name}
                  <span aria-hidden="true">
                    {t.id
                      ? data.users.filter((u) => u.teamIds.includes(t.id))
                          .length
                      : data.users.length}
                  </span>
                </button>
              ))}
            </div>
            {edit && (
              <form
                key={edit.id || "new"}
                className="admin-edit"
                onSubmit={saveUser}
              >
                <h3>{edit.id ? "팀원 수정" : "신규 팀원"}</h3>
                <div className="form-grid">
                  <label>
                    이름
                    <input
                      name="name"
                      defaultValue={edit.name}
                      onChange={(e) =>
                        setEdit((u) => ({ ...u, name: e.target.value }))
                      }
                      maxLength={50}
                      required
                    />
                  </label>
                  <label>
                    아이디
                    <input
                      name="username"
                      defaultValue={edit.username}
                      disabled={!!edit.id}
                      maxLength={60}
                      required
                    />
                  </label>
                  <label>
                    {edit.id
                      ? "비밀번호 재설정 (비워두면 유지)"
                      : "초기 비밀번호"}
                    <input
                      type="password"
                      name="password"
                      required={!edit.id}
                      minLength={10}
                      maxLength={128}
                      autoComplete="new-password"
                    />
                  </label>
                  <label>
                    역할
                    <Select name="role" defaultValue={edit.role}>
                      {Object.entries(roleNames).map(([key, name]) => (
                        <option value={key} key={key}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <AvatarEditor
                  key={edit.id || "new"}
                  user={edit}
                  onChange={(patch) => setEdit((u) => ({ ...u, ...patch }))}
                  onLoading={setAvatarLoading}
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="active"
                    defaultChecked={edit.active}
                  />
                  계정 활성화
                </label>
                <fieldset>
                  <legend>배속 팀 · 복수 선택</legend>
                  <div className="check-grid">
                    {data.teams.map((t) => (
                      <label className="checkbox" key={t.id}>
                        <input
                          type="checkbox"
                          name="teams"
                          value={t.id}
                          defaultChecked={edit.teamIds?.includes(t.id)}
                        />
                        {t.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <footer className="form-actions">
                  <Button onClick={() => setEdit(null)}>취소</Button>
                  <Button
                    type="submit"
                    className="primary"
                    disabled={busy || avatarLoading}
                  >
                    팀원 저장
                  </Button>
                </footer>
              </form>
            )}
            <div className="admin-table-scroll">
              <table className="admin-table members-table">
                <thead>
                  <tr>
                    <th>팀원 / 아이디</th>
                    <th>배속 팀</th>
                    <th>역할</th>
                    <th>상태</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="member-identity">
                          <Avatar user={u} />
                          <span>
                            <strong>{u.name}</strong>
                            <small>{u.username}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="team-chips">
                          {u.teamIds.length ? (
                            data.teams
                              .filter((t) => u.teamIds.includes(t.id))
                              .map((t) => (
                                <span className="tag" key={t.id}>
                                  {t.name}
                                </span>
                              ))
                          ) : (
                            <span className="muted">미배속</span>
                          )}
                        </div>
                      </td>
                      <td>{roleNames[u.role]}</td>
                      <td>{u.active ? "활성" : "비활성"}</td>
                      <td>
                        <Button
                          title={`${u.name} 팀원 수정`}
                          onClick={() => setEdit(u)}
                        >
                          수정
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {members.length === 0 && (
                    <tr>
                      <td colSpan={5} className="members-empty">
                        {memberTeam
                          ? "이 팀에 배속된 팀원이 없습니다."
                          : "등록된 팀원이 없습니다."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
        {["properties", "format"].includes(tab) && (
          <>
            <label className="property-team-label">
              관리할 팀
              <Select
                value={selectedTeam.id}
                onChange={(e) => setPropertyTeam(e.target.value)}
              >
                {data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>
            {tab === "properties" ? (
              <PropertiesManager
                key={selectedTeam.id}
                team={selectedTeam}
                visibleFields={
                  selectedTeam.id === team.id ? visibleFields : undefined
                }
                onVisibilitySaved={
                  selectedTeam.id === team.id ? onVisibilitySaved : undefined
                }
                onSaved={saved}
              />
            ) : (
              <DefaultStyleManager
                key={selectedTeam.id}
                team={selectedTeam}
                onSaved={saved}
              />
            )}
          </>
        )}
      </section>
    </Modal>
  );
}
