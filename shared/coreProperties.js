export const CORE_PROPERTY_KEYS = ["title", "owner", "status"];
export const DEFAULT_STATUS_OPTIONS = [
  {
    id: "status-planned",
    label: "예정",
    backgroundColor: "#eef2f7",
    dotColor: "#718096",
    emoji: "📅",
  },
  {
    id: "status-review",
    label: "검토 중",
    backgroundColor: "#eee8f7",
    dotColor: "#8a6baa",
    emoji: "🔎",
  },
  {
    id: "status-progress",
    label: "진행 중",
    backgroundColor: "#e7effb",
    dotColor: "#467fc1",
    emoji: "🔵",
  },
  {
    id: "status-completed",
    label: "완료",
    backgroundColor: "#e4f2eb",
    dotColor: "#2f8a67",
    emoji: "✅",
  },
  {
    id: "status-paused",
    label: "보류",
    backgroundColor: "#fff1db",
    dotColor: "#bb8732",
    emoji: "⏸️",
  },
];
/** @returns {import("../src/types").Property[]} */
export function defaultCoreProperties() {
  return [
    {
      id: "title",
      name: "작업",
      kind: "text",
      display: "text",
      visible: true,
      values: [],
    },
    {
      id: "owner",
      name: "팀원",
      kind: "member",
      display: "avatar",
      multiple: false,
      visible: true,
      values: [],
    },
    {
      id: "status",
      name: "상태",
      kind: "option",
      display: "dot",
      visible: true,
      values: DEFAULT_STATUS_OPTIONS.map((v) => ({ ...v })),
    },
  ];
}
// Restore required definitions once, retaining stable IDs, custom values and colors.
export function upgradeCoreProperties(properties) {
  const remaining = properties.filter(
    (p) => !CORE_PROPERTY_KEYS.includes(p.id),
  );
  const names = new Set(
    remaining.filter((p) => !p.archived).map((p) => p.name),
  );
  const core = defaultCoreProperties().map((base) => {
    const old = properties.find((p) => p.id === base.id);
    const p = {
      ...base,
      ...old,
      kind: base.kind,
      archived: false,
      visible: true,
    };
    if (p.id === "owner") {
      p.multiple = false;
      if (p.name === "책임자") p.name = "팀원";
      if (!["avatar", "text"].includes(p.display)) p.display = "avatar";
    }
    if (p.id === "status") {
      if (!["text", "dot", "round", "square", "emoji"].includes(p.display))
        p.display = "dot";
      const oldValues = old?.values || [];
      p.values = DEFAULT_STATUS_OPTIONS.map((preset) => {
        const found = oldValues.find((v) => v.label === preset.label);
        if (!found) {
          let id = preset.id;
          while (oldValues.some((v) => v.id === id)) id += "-new";
          return { ...preset, id };
        }
        const untouched =
          found.dotColor === "#177b70" &&
          ["#ffffff", "#edf6f4"].includes(found.backgroundColor);
        return {
          ...found,
          ...(untouched
            ? {
                backgroundColor: preset.backgroundColor,
                dotColor: preset.dotColor,
                emoji: preset.emoji,
              }
            : {}),
          archived: false,
        };
      });
      p.values.push(
        ...oldValues.filter((v) => !p.values.some((n) => n.id === v.id)),
      );
    }
    const desired = p.name;
    let n = 1;
    while (names.has(p.name))
      p.name = `${desired} (기본${n++ === 1 ? "" : n - 1})`;
    names.add(p.name);
    return p;
  });
  return [
    ...properties.map((p) => core.find((c) => c.id === p.id) || p),
    ...core.filter((c) => !properties.some((p) => p.id === c.id)),
  ];
}
