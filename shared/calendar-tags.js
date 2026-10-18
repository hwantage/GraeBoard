// Fixed palette for calendar tags. Stored values are color IDs, never CSS.
export const CALENDAR_TAG_COLORS = [
  {
    id: "default",
    name: "기본",
    background: "#f7f7f5",
    chip: "#f2f1ef",
    ink: "#37352f",
    border: "#dedcd9",
  },
  {
    id: "gray",
    name: "회색",
    background: "#f1f1ef",
    chip: "#e9e8e7",
    ink: "#595854",
    border: "#d6d4d1",
  },
  {
    id: "brown",
    name: "갈색",
    background: "#f4eeee",
    chip: "#ece2de",
    ink: "#64473a",
    border: "#dccac0",
  },
  {
    id: "orange",
    name: "주황색",
    background: "#fbecdd",
    chip: "#f4dfd4",
    ink: "#854c1d",
    border: "#eac6b1",
  },
  {
    id: "yellow",
    name: "노란색",
    background: "#fbf3db",
    chip: "#f3e4c5",
    ink: "#715b24",
    border: "#ead098",
  },
  {
    id: "green",
    name: "초록색",
    background: "#edf3ec",
    chip: "#dee7e1",
    ink: "#385c46",
    border: "#c0d3c7",
  },
  {
    id: "blue",
    name: "파란색",
    background: "#e7f3f8",
    chip: "#d5e4f8",
    ink: "#285e82",
    border: "#b3cff2",
  },
  {
    id: "purple",
    name: "보라색",
    background: "#f6f3f9",
    chip: "#eae1f2",
    ink: "#694080",
    border: "#d8c7e7",
  },
  {
    id: "pink",
    name: "분홍색",
    background: "#faf1f5",
    chip: "#f4dde7",
    ink: "#8a3f67",
    border: "#ebc0d1",
  },
  {
    id: "red",
    name: "빨간색",
    background: "#fdebec",
    chip: "#f7dbdc",
    ink: "#933f37",
    border: "#f1bcbe",
  },
];

export const CALENDAR_TAG_LIMIT = 20;

export function calendarTagColor(id) {
  return (
    CALENDAR_TAG_COLORS.find((color) => color.id === id) ||
    CALENDAR_TAG_COLORS[0]
  );
}
