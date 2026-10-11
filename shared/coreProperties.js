// 모든 팀이 반드시 갖는 속성과, 예시 팀에 함께 만드는 속성 양식.
// 선택형(option) 셀 값은 언제나 옵션 ID다. 라벨은 표시에만 쓴다.
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
const option = (id, label) => ({
  id,
  label,
  backgroundColor: "#e5f0ee",
  dotColor: "#177b70",
  emoji: "📌",
});
const TITLE = {
  id: "title",
  name: "작업",
  kind: "text",
  display: "text",
  width: 330,
  visible: true,
  values: [],
};
const OWNER = {
  id: "owner",
  name: "팀원",
  kind: "member",
  display: "avatar",
  multiple: false,
  width: 112,
  visible: true,
  values: [],
};
const STATUS = {
  id: "status",
  name: "상태",
  kind: "option",
  display: "dot",
  width: 105,
  visible: true,
  values: DEFAULT_STATUS_OPTIONS,
};
/** 새 팀의 기본 속성. @returns {import("../src/types").Property[]} */
export function defaultCoreProperties() {
  return structuredClone([TITLE, OWNER, STATUS]);
}
/**
 * 예시 팀과 XLSX 가져오기가 쓰는 확장 양식. ID는 가져오기 열 별칭과 같다.
 * @returns {import("../src/types").Property[]}
 */
export function sampleProperties() {
  return structuredClone([
    {
      id: "category",
      name: "분류",
      kind: "option",
      display: "square",
      width: 108,
      visible: true,
      values: [
        option("category-ux", "UX 개선"),
        option("category-new", "차별화"),
        option("category-other", "기타"),
      ],
    },
    {
      id: "type",
      name: "유형",
      kind: "option",
      display: "square",
      width: 84,
      visible: false,
      values: [
        option("type-plan", "기획"),
        option("type-design", "디자인"),
        option("type-dev", "개발"),
        option("type-review", "검토"),
        option("type-research", "연구"),
      ],
    },
    TITLE,
    {
      id: "description",
      name: "설명",
      kind: "text",
      display: "text",
      width: 220,
      visible: false,
      values: [],
    },
    OWNER,
    {
      id: "supporters",
      name: "지원자",
      kind: "member",
      display: "text",
      multiple: true,
      width: 120,
      visible: false,
      values: [],
    },
    STATUS,
    {
      id: "progress",
      name: "진척률",
      kind: "text",
      display: "text",
      width: 80,
      visible: false,
      values: [],
    },
    {
      id: "deadline",
      name: "목표일",
      kind: "date",
      display: "text",
      width: 112,
      visible: false,
      values: [],
    },
    {
      id: "score",
      name: "Score",
      kind: "number",
      display: "text",
      width: 72,
      visible: false,
      values: [],
    },
    {
      id: "current",
      name: "Current",
      kind: "number",
      display: "text",
      width: 78,
      visible: false,
      values: [],
    },
  ]);
}
