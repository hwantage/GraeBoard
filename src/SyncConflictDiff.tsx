import { useMemo, useState } from "react";
import { Button } from "./components";
import {
  changedFields,
  conflictChanges,
  conflictReason,
  diffSides,
  splitContested,
} from "../shared/conflict-diff.js";

type ConflictView = {
  target: string;
  result?: string;
  base: unknown;
  current: unknown;
  desired: unknown;
};
type Change = ReturnType<typeof conflictChanges>[number];
type Rows = ReturnType<typeof diffSides>["rows"];
type Mode = "result" | "theirs" | "mine";

const modes: {
  id: Mode;
  label: string;
  from: "base" | "current";
  to: "current" | "desired";
  legend: string;
}[] = [
  {
    id: "result",
    label: "현재 공유 ↔ 제출",
    from: "current",
    to: "desired",
    legend:
      "− 현재 공유 내용에만 있는 줄, + 제출한 내용에만 있는 줄입니다. 제출한 내용을 적용하면 − 줄이 + 줄로 바뀝니다.",
  },
  {
    id: "theirs",
    label: "기준 → 현재 공유",
    from: "base",
    to: "current",
    legend: "상대가 바꾼 부분입니다. − 기준 내용, + 현재 공유 내용입니다.",
  },
  {
    id: "mine",
    label: "기준 → 제출",
    from: "base",
    to: "desired",
    legend: "제출에서 바꾼 부분입니다. − 기준 내용, + 제출한 내용입니다.",
  },
];

// Line diff of a conflict's sides so a person can see which sentence or
// field differs before choosing current or submitted. Raw JSON stays below.
export default function SyncConflictDiff({
  conflict,
}: {
  conflict: ConflictView;
}) {
  const { contested, clean } = useMemo(
    () => splitContested(conflictChanges(conflict)),
    [conflict],
  );
  const [mode, setMode] = useState<Mode>("result");
  const [cleanOpen, setCleanOpen] = useState(false);
  const selected = modes.find((item) => item.id === mode)!;
  const total = contested.length + clean.length;
  const list = (changes: Change[], offset: number) =>
    changes.map((change, index) => (
      <ChangeDiff
        key={`${offset + index}:${mode}`}
        change={change}
        from={selected.from}
        to={selected.to}
      />
    ));
  return (
    <section className="sync-conflict-diff" aria-label="변경 비교">
      <p className="sync-diff-summary">
        {conflictReason(conflict.result)}
        {total > 1 &&
          ` 변경 ${total}개 중 상대도 바꾼 항목은 ${contested.length}개입니다.`}
      </p>
      <div className="sync-diff-modes" role="group" aria-label="비교 대상">
        {modes.map((item) => (
          <Button
            key={item.id}
            active={item.id === mode}
            aria-pressed={item.id === mode}
            onClick={() => setMode(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <p className="sync-diff-legend">{selected.legend}</p>
      {contested.length === 0 && (
        <p className="sync-diff-equal">상대가 바꾼 항목은 없습니다.</p>
      )}
      {list(contested, 0)}
      {clean.length > 0 && (
        <details
          className="sync-diff-clean"
          onToggle={(event) => setCleanOpen(event.currentTarget.open)}
        >
          <summary>상대가 바꾸지 않은 항목 {clean.length}개</summary>
          <p className="sync-diff-legend">
            기준과 현재 공유 내용이 같아 부딪히지 않은 항목입니다. 제출한 내용
            적용을 고르면 함께 반영되고, 현재 공유 내용 유지를 고르면 함께
            취소됩니다.
          </p>
          {/* A large command can carry hundreds of these; draw them on demand. */}
          {cleanOpen && list(clean, contested.length)}
        </details>
      )}
    </section>
  );
}

function ChangeDiff({
  change,
  from,
  to,
}: {
  change: Change;
  from: "base" | "current";
  to: "current" | "desired";
}) {
  const diff = useMemo(
    () => diffSides(change[from], change[to]),
    [change, from, to],
  );
  const theirs = changedFields(change.base, change.current),
    mine = changedFields(change.base, change.desired),
    both = mine.filter((field) => theirs.includes(field));
  return (
    <div className="sync-diff-change">
      <h5>
        {change.name}
        {change.key && <code>{change.key}</code>}
      </h5>
      <ul className="sync-diff-fields">
        <li>상대가 바꾼 항목: {fieldList(theirs)}</li>
        <li>제출에서 바꾼 항목: {fieldList(mine)}</li>
        {both.length > 0 && (
          <li className="is-overlap">
            양쪽이 함께 바꾼 항목: {fieldList(both)}
          </li>
        )}
      </ul>
      {diff.equal ? (
        <p className="sync-diff-equal">
          {from === "current"
            ? "현재 공유 내용과 제출한 내용이 같습니다."
            : "바뀐 부분이 없습니다."}
        </p>
      ) : (
        <DiffRows rows={diff.rows} />
      )}
    </div>
  );
}

const fieldList = (fields: string[]) =>
  fields.length ? fields.join(", ") : "없음";

function DiffRows({ rows }: { rows: Rows }) {
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  return (
    <div className="sync-diff-lines" role="table" aria-label="줄 비교">
      {rows.flatMap((row, index) => {
        if (row.type !== "fold") return [<Line key={index} row={row} />];
        if (opened.has(index))
          return row.rows.map((line, offset) => (
            <Line key={`${index}:${offset}`} row={line} />
          ));
        return [
          <div key={index} className="sync-diff-fold" role="row">
            <div role="cell">
              <button
                type="button"
                onClick={() => setOpened((set) => new Set(set).add(index))}
              >
                … {row.count}줄 같음 (펼치기)
              </button>
            </div>
          </div>,
        ];
      })}
    </div>
  );
}

const markers = { same: " ", removed: "−", added: "+" };

function Line({ row }: { row: Exclude<Rows[number], { type: "fold" }> }) {
  return (
    <div className={`sync-diff-line is-${row.type}`} role="row">
      <span className="sync-diff-number" role="cell" aria-hidden="true">
        {row.from ?? ""}
      </span>
      <span className="sync-diff-number" role="cell" aria-hidden="true">
        {row.to ?? ""}
      </span>
      <span className="sync-diff-marker" role="cell">
        {markers[row.type]}
      </span>
      <span className="sync-diff-text" role="cell">
        {row.segments
          ? row.segments.map((segment, index) =>
              segment.changed ? (
                <mark key={index}>{segment.text}</mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )
          : row.text}
      </span>
    </div>
  );
}
