// Warm-paper palette: quiet card backgrounds and high-contrast colored badges.
// Stored values are color IDs, never CSS; palette updates also restyle existing tags.
export const CALENDAR_TAG_COLORS = [
  {
    id: "default",
    name: "기본",
    background: "#fff8e9",
    chip: "#f1e3c4",
    ink: "#4b3d2b",
    border: "#87745b",
  },
  {
    id: "gray",
    name: "회색",
    background: "#f4f0e8",
    chip: "#ddd5c8",
    ink: "#39332e",
    border: "#6a6054",
  },
  {
    id: "brown",
    name: "갈색",
    background: "#f8eee1",
    chip: "#dfb68c",
    ink: "#4d321f",
    border: "#795431",
  },
  {
    id: "orange",
    name: "주황색",
    background: "#fff0dd",
    chip: "#ffb07a",
    ink: "#5b2d16",
    border: "#8a4827",
  },
  {
    id: "yellow",
    name: "노란색",
    background: "#fff6d6",
    chip: "#ffd84d",
    ink: "#51400d",
    border: "#8c711e",
  },
  {
    id: "green",
    name: "초록색",
    background: "#edf6e6",
    chip: "#b9e6a6",
    ink: "#294a24",
    border: "#4f7543",
  },
  {
    id: "blue",
    name: "파란색",
    background: "#eaf5fc",
    chip: "#a5dcff",
    ink: "#214c67",
    border: "#47718a",
  },
  {
    id: "purple",
    name: "보라색",
    background: "#f3effb",
    chip: "#d3bdf2",
    ink: "#50346d",
    border: "#77549b",
  },
  {
    id: "pink",
    name: "분홍색",
    background: "#fff0f4",
    chip: "#ffb9cc",
    ink: "#713449",
    border: "#a25870",
  },
  {
    id: "red",
    name: "빨간색",
    background: "#fff0eb",
    chip: "#ff977e",
    ink: "#6d2c24",
    border: "#994c40",
  },
];

export const CALENDAR_TAG_LIMIT = 20;

export function calendarTagColor(id) {
  return (
    CALENDAR_TAG_COLORS.find((color) => color.id === id) ||
    CALENDAR_TAG_COLORS[0]
  );
}
