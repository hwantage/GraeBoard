import { useMemo, useState } from "react";
import { Button } from "./components";
import { syncTime } from "./sync-types";
import {
  changedFields,
  conflictChanges,
  conflictReason,
  describeOrigin,
  describeWriters,
  diffSides,
  fieldLabel,
  siteName,
  splitContested,
} from "../shared/conflict-diff.js";

export type ConflictOrigin = {
  site: "internal" | "external" | null;
  initial?: boolean;
  actor: string | null;
  createdAt: string | null;
};
type ConflictView = {
  target: string;
  result?: string;
  base: unknown;
  current: unknown;
  desired: unknown;
  origin?: {
    held: ConflictOrigin;
    writers: Record<string, ConflictOrigin | null>;
  };
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
    label: "덮어쓰면 바뀌는 부분",
    from: "current",
    to: "desired",
    legend:
      "빨간 줄은 지금 내용, 초록 줄은 보류된 수정입니다. 보류된 수정으로 덮어쓰면 빨간 줄이 초록 줄로 바뀝니다.",
  },
  {
    id: "theirs",
    label: "먼저 반영된 수정",
    from: "base",
    to: "current",
    legend:
      "원래 내용에서 먼저 반영된 수정이 바꾼 부분입니다. 빨간 줄은 원래 내용, 초록 줄은 지금 내용입니다.",
  },
  {
    id: "mine",
    label: "보류된 수정",
    from: "base",
    to: "desired",
    legend:
      "원래 내용에서 보류된 수정이 바꾼 부분입니다. 빨간 줄은 원래 내용, 초록 줄은 보류된 수정입니다.",
  },
];

// Line diff of a conflict's sides so a person can see which sentence or
// field differs before keeping the current content or overwriting it with the
// held edit. "보류된 수정" is the API's desired, "지금 내용" its current and
// "원래 내용" its base. Raw JSON stays below.
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
  // Which site made each edit: the held one is the conflict's operation, the
  // first-applied one wrote the current values of the overlapping items.
  const held = conflict.origin?.held,
    writers = contested.length ? contested : clean,
    firstApplied = describeWriters(writers, syncTime),
    sites = [...new Set(writers.map((change) => siteName(change.writer)))],
    suffix: Record<Mode, string> = {
      result: "",
      theirs: sites.length === 1 && sites[0] ? ` (${sites[0]})` : "",
      mine: siteName(held) ? ` (${siteName(held)})` : "",
    };
  const list = (changes: Change[], offset: number) =>
    changes.map((change, index) => (
      <ChangeDiff
        key={`${offset + index}:${mode}`}
        change={change}
        held={siteName(held)}
        from={selected.from}
        to={selected.to}
      />
    ));
  return (
    <section className="sync-conflict-diff" aria-label="변경 비교">
      <p className="sync-diff-summary">
        {conflictReason(conflict.result)}
        {total > 1 &&
          ` 보류된 수정 ${total}개 항목 중 먼저 반영된 수정과 겹친 항목은 ${contested.length}개입니다.`}
      </p>
      {held && (
        <dl className="sync-diff-origin">
          <dt>보류된 수정</dt>
          <dd>{describeOrigin(held, syncTime) || "알 수 없음"}</dd>
          <dt>먼저 반영된 수정</dt>
          <dd>{firstApplied || "알 수 없음"}</dd>
        </dl>
      )}
      <p className="sync-diff-legend">
        원래 내용은 두 수정 전 값, 지금 내용은 지금 모두에게 보이는 값, 보류된
        수정은 반영되지 못하고 이 보관함에 남은 수정입니다.
      </p>
      <div className="sync-diff-modes" role="group" aria-label="비교 대상">
        {modes.map((item) => (
          <Button
            key={item.id}
            active={item.id === mode}
            aria-pressed={item.id === mode}
            onClick={() => setMode(item.id)}
          >
            {item.label + suffix[item.id]}
          </Button>
        ))}
      </div>
      <p className="sync-diff-legend">{selected.legend}</p>
      {contested.length === 0 && (
        <p className="sync-diff-equal">
          먼저 반영된 수정과 겹친 항목은 없습니다.
        </p>
      )}
      {list(contested, 0)}
      {clean.length > 0 && (
        <details
          className="sync-diff-clean"
          onToggle={(event) => setCleanOpen(event.currentTarget.open)}
        >
          <summary>겹치지 않은 항목 {clean.length}개</summary>
          <p className="sync-diff-legend">
            먼저 반영된 수정과 겹치지 않은 항목입니다. 보류된 수정으로 덮어쓰면
            함께 반영되고, 지금 내용을 유지하면 함께 버려집니다.
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
  held,
  from,
  to,
}: {
  change: Change;
  held: string;
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
        <li>
          먼저 반영된 수정{site(siteName(change.writer))}이 바꾼 항목:{" "}
          {fieldList(theirs)}
        </li>
        <li>
          보류된 수정{site(held)}이 바꾼 항목: {fieldList(mine)}
        </li>
        {both.length > 0 && (
          <li className="is-overlap">
            두 수정이 함께 바꾼 항목: {fieldList(both)}
          </li>
        )}
      </ul>
      {diff.equal ? (
        <p className="sync-diff-equal">
          {from === "current"
            ? "지금 내용과 보류된 수정이 같습니다."
            : "바뀐 부분이 없습니다."}
        </p>
      ) : (
        <DiffRows rows={diff.rows} />
      )}
    </div>
  );
}

const site = (name: string) => (name ? `(${name})` : "");

const fieldList = (fields: string[]) =>
  fields.length ? fields.map(fieldLabel).join(", ") : "없음";

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
