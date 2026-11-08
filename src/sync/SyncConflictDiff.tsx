import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Avatar, Button } from "../components";
import { syncTime } from "./sync-types";
import type { User } from "../types";
import {
  changedFields,
  conflictChanges,
  conflictReason,
  describeOrigin,
  describeWriters,
  diffSides,
  fieldLabel,
  personLabel,
  siteName,
  splitContested,
} from "../../shared/conflict-diff.js";

export type ConflictOrigin = {
  site: "internal" | "external" | null;
  initial?: boolean;
  actorId?: string | null;
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
type Mode = "result" | "first" | "later";

// The API's current side is what the first edit left, desired is the later
// edit kept in the box and base the value both edits started from.
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
      "빨간 줄은 먼저 수정이 반영된 지금 내용, 초록 줄은 나중에 수정입니다. 나중에 수정으로 덮어쓰면 빨간 줄이 초록 줄로 바뀝니다.",
  },
  {
    id: "first",
    label: "먼저 수정",
    from: "base",
    to: "current",
    legend:
      "원래 내용에서 먼저 수정이 바꾼 부분입니다. 빨간 줄은 원래 내용, 초록 줄은 먼저 수정입니다.",
  },
  {
    id: "later",
    label: "나중에 수정",
    from: "base",
    to: "desired",
    legend:
      "원래 내용에서 나중에 수정이 바꾸려던 부분입니다. 빨간 줄은 원래 내용, 초록 줄은 나중에 수정입니다.",
  },
];

// Line diff of a conflict's sides so a person can see which sentence or
// field differs before keeping the first edit or overwriting it with the
// later one. Raw JSON stays below.
export default function SyncConflictDiff({
  conflict,
  people = [],
}: {
  conflict: ConflictView;
  people?: User[];
}) {
  const { contested, clean } = useMemo(
    () => splitContested(conflictChanges(conflict)),
    [conflict],
  );
  const [mode, setMode] = useState<Mode>("result");
  const [cleanOpen, setCleanOpen] = useState(false);
  const selected = modes.find((item) => item.id === mode)!;
  const total = contested.length + clean.length;
  // Which site made each edit: the later one is the conflict's operation, the
  // first one wrote the current values of the overlapping items.
  const later = conflict.origin?.held,
    writers = contested.length ? contested : clean,
    first = writers.map((change) => change.writer).find(Boolean),
    // One person (or site) wrote all first values, or several did.
    firstWriter =
      first &&
      writers.every(
        (change) =>
          !change.writer ||
          describeOrigin(change.writer) === describeOrigin(first),
      )
        ? first
        : null,
    sites = [...new Set(writers.map((change) => siteName(change.writer)))],
    suffix: Record<Mode, string> = {
      result: "",
      first: sites.length === 1 && sites[0] ? ` (${sites[0]})` : "",
      later: siteName(later) ? ` (${siteName(later)})` : "",
    };
  const list = (changes: Change[], offset: number) =>
    changes.map((change, index) => (
      <ChangeDiff
        key={`${offset + index}:${mode}`}
        change={change}
        later={siteName(later)}
        from={selected.from}
        to={selected.to}
      />
    ));
  return (
    <section className="sync-conflict-diff" aria-label="변경 비교">
      <p className="sync-diff-summary">
        {conflictReason(conflict.result)}
        {total > 1 &&
          ` 나중에 수정 ${total}개 항목 중 먼저 수정과 겹친 항목은 ${contested.length}개입니다.`}
      </p>
      {later && (
        <ul className="sync-diff-origin" aria-label="수정한 사람">
          <li>
            <span className="sync-diff-origin-label">먼저 수정</span>
            {firstWriter ? (
              <Editor origin={firstWriter} people={people} />
            ) : (
              <>
                <Avatar user={personFor(first, people)} small />
                <span className="sync-diff-origin-name">
                  {describeWriters(writers, syncTime) || "알 수 없음"}
                </span>
              </>
            )}
          </li>
          <li>
            <span className="sync-diff-origin-label">나중에 수정</span>
            <Editor origin={later} people={people} />
          </li>
        </ul>
      )}
      <p className="sync-diff-legend">
        원래 내용은 두 수정 전 값입니다. 먼저 수정은 먼저 반영되어 지금 보이는
        내용이고, 나중에 수정은 같은 곳을 뒤늦게 고쳐 반영되지 못하고 이
        보관함에 남은 수정입니다.
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
        <p className="sync-diff-equal">먼저 수정과 겹친 항목은 없습니다.</p>
      )}
      {list(contested, 0)}
      {clean.length > 0 && (
        <details
          className="sync-diff-clean"
          onToggle={(event) => setCleanOpen(event.currentTarget.open)}
        >
          <summary>겹치지 않은 항목 {clean.length}개</summary>
          <p className="sync-diff-legend">
            먼저 수정과 겹치지 않은 항목입니다. 나중에 수정으로 덮어쓰면 함께
            반영되고, 먼저 수정으로 유지하면 함께 버려집니다.
          </p>
          {/* A large command can carry hundreds of these; draw them on demand. */}
          {cleanOpen && list(clean, contested.length)}
        </details>
      )}
    </section>
  );
}

/** Avatar, "김정환 (외부)" and the time when known. */
function Editor({
  origin,
  people,
}: {
  origin: ConflictOrigin;
  people: User[];
}) {
  return (
    <>
      <Avatar user={personFor(origin, people)} small />
      <span className="sync-diff-origin-name">
        {personLabel(origin) || "알 수 없음"}
      </span>
      {origin.createdAt && (
        <time className="sync-diff-origin-time" dateTime={origin.createdAt}>
          {syncTime(origin.createdAt)}
        </time>
      )}
    </>
  );
}

/**
 * The team member who made an edit, for the avatar: by person ID, else by
 * name, else a placeholder named after the site ("외부" → "외").
 */
export function personFor(
  origin: ConflictOrigin | null | undefined,
  people: User[],
): Partial<User> {
  const found =
    (origin?.actorId &&
      people.find((person) => person.id === origin.actorId)) ||
    (origin?.actor && people.find((person) => person.name === origin.actor));
  if (found) return found;
  return { name: origin?.actor || siteName(origin) || "?" };
}

function ChangeDiff({
  change,
  later,
  from,
  to,
}: {
  change: Change;
  later: string;
  from: "base" | "current";
  to: "current" | "desired";
}) {
  const diff = useMemo(
    () => diffSides(change[from], change[to]),
    [change, from, to],
  );
  const first = changedFields(change.base, change.current),
    second = changedFields(change.base, change.desired),
    both = second.filter((field) => first.includes(field));
  return (
    <div className="sync-diff-change">
      <h5>
        {change.name}
        {change.key && <code>{change.key}</code>}
      </h5>
      <ul className="sync-diff-fields">
        <li>
          먼저 수정{site(siteName(change.writer))}이 바꾼 항목:{" "}
          {fieldList(first)}
        </li>
        <li>
          나중에 수정{site(later)}이 바꾼 항목: {fieldList(second)}
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
            ? "두 수정의 결과가 같습니다."
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

/**
 * Source/destination line numbers stay fixed when a fold expands. Keep its
 * key distinct from the first hidden line so measured heights cannot cross.
 */
const diffRowKey = (row: Rows[number]) => {
  const line = row.type === "fold" ? row.rows[0] : row;
  return `${row.type}:${line.from ?? ""}:${line.to ?? ""}`;
};

/** Expand selected unchanged blocks and virtualize long comparisons. */
function DiffRows({ rows }: { rows: Rows }) {
  const [opened, setOpened] = useState<Set<Rows[number]>>(() => new Set());
  const visible = useMemo(() => {
    const result: Rows = [];
    for (const row of rows) {
      if (row.type === "fold" && opened.has(row)) {
        for (const line of row.rows) result.push(line);
      } else result.push(row);
    }
    return result;
  }, [rows, opened]);
  const renderRow = (row: Rows[number]) =>
    row.type !== "fold" ? (
      <Line key={diffRowKey(row)} row={row} />
    ) : (
      <div key={diffRowKey(row)} className="sync-diff-fold" role="row">
        <div role="cell">
          <button
            type="button"
            onClick={() => setOpened((set) => new Set(set).add(row))}
          >
            … {row.count}줄 같음 (펼치기)
          </button>
        </div>
      </div>
    );
  // A whole-sheet creation or expanded unchanged block can contain hundreds
  // of thousands of lines. Reuse the grid's virtualizer; keep every line
  // reachable without creating its DOM until it enters the viewport.
  if (visible.length > 200)
    return <VirtualDiffRows rows={visible} renderRow={renderRow} />;
  return (
    <div className="sync-diff-lines" role="table" aria-label="줄 비교">
      {visible.map(renderRow)}
    </div>
  );
}

function VirtualDiffRows({
  rows,
  renderRow,
}: {
  rows: Rows;
  renderRow: (row: Rows[number]) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback(
    (index: number) => diffRowKey(rows[index]),
    [rows],
  );
  const virtual = useVirtualizer({
    count: rows.length,
    getItemKey,
    getScrollElement: () => scroll.current,
    estimateSize: () => 19.2,
    overscan: 8,
  });
  return (
    <div
      ref={scroll}
      className="sync-diff-lines sync-diff-virtual"
      role="table"
      aria-label="줄 비교"
      aria-rowcount={rows.length}
      tabIndex={0}
    >
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtual.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(rows[item.index])}
          </div>
        ))}
      </div>
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
