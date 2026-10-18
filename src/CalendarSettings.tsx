import { useEffect, useState } from "react";
import { Button, ErrorNote, Modal } from "./components";
import Select from "./Select";
import PropertyFilter from "./PropertyFilter";
import { api, send, taskQuery } from "./api";
import { propertiesFor, todayKey } from "../shared/domain.js";
import {
  addDays,
  calendarWeek,
  calendarRuleProblem,
  canUseCalendarRuleProperty,
  CALENDAR_DAYS,
  DAY_LABELS,
} from "../shared/calendar.js";
import type { CalendarContext, CalendarRule } from "./calendar-types";
import type { FilterMode, Task } from "./types";

export function CalendarWeekdays({
  weekdays,
  onSaved,
  onClose,
}: {
  weekdays: number[];
  onSaved: (days: number[]) => void;
  onClose: () => void;
}) {
  const [days, setDays] = useState(weekdays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="내 캘린더 표시 요일"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        내 계정의 표시 요일입니다. 숨긴 날짜의 일정은 그대로 보관됩니다. 팀 주간
        보기에도 적용됩니다.
      </p>
      <div className="calendar-actions">
        {[
          ["일~토", CALENDAR_DAYS],
          ["월~금", [1, 2, 3, 4, 5]],
          ["월~목", [1, 2, 3, 4]],
        ].map(([label, values]) => (
          <Button
            key={String(label)}
            active={JSON.stringify(days) === JSON.stringify(values)}
            onClick={() => setDays(values as number[])}
          >
            {String(label)}
          </Button>
        ))}
      </div>
      <fieldset className="calendar-day-options">
        <legend>표시할 요일 (최소 1개)</legend>
        {CALENDAR_DAYS.map((day) => (
          <label key={day}>
            <input
              type="checkbox"
              checked={days.includes(day)}
              disabled={days.length === 1 && days.includes(day)}
              onChange={() =>
                setDays(
                  days.includes(day)
                    ? days.filter((d) => d !== day)
                    : [...days, day].sort(),
                )
              }
            />
            {DAY_LABELS[day]}요일
          </label>
        ))}
      </fieldset>
      <ErrorNote error={error} />
      <div className="calendar-actions">
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void send<{ weekdays: number[] }>(
              "/calendar/preferences",
              { weekdays: days },
              "PUT",
            )
              .then((r) => {
                onSaved(r.weekdays);
                onClose();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          요일 설정 저장
        </Button>
        <Button disabled={busy} onClick={onClose}>
          취소
        </Button>
      </div>
    </Modal>
  );
}

export function CalendarRuleSettings({
  teamId,
  context,
  onSaved,
  onClose,
}: {
  teamId: string;
  context: CalendarContext;
  onSaved: (rule: CalendarRule) => void;
  onClose: () => void;
}) {
  const properties = propertiesFor(context.settings);
  const [propertyId, setPropertyId] = useState(context.rule.propertyId);
  const [values, setValues] = useState(context.rule.values);
  const [mode, setMode] = useState<FilterMode>(context.rule.mode);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    tasks: Task[];
    error: string;
  } | null>(null);
  const property = properties.find((p) => p.id === propertyId);
  const allowedProperty = property && canUseCalendarRuleProperty(property);
  const problem = calendarRuleProblem({ propertyId, values, mode }, properties);
  const needsTasks =
    allowedProperty &&
    (property.kind === "text" ||
      property.kind === "date" ||
      property.kind === "number");
  const week = calendarWeek(todayKey());
  const year = Number(week.slice(0, 4));
  const query = taskQuery(
    teamId,
    year,
    Number(addDays(week, 6).slice(0, 4)) === year ? 1 : 2,
  );
  const key = JSON.stringify([query, attempt]);
  const ready = result?.key === key;
  const loading = needsTasks && !ready;
  const loadError = needsTasks && ready ? result.error : "";
  useEffect(() => {
    if (!needsTasks || ready) return;
    const controller = new AbortController();
    void api<{ tasks: Task[] }>(query, { signal: controller.signal })
      .then(({ tasks }) => {
        if (!controller.signal.aborted) setResult({ key, tasks, error: "" });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted)
          setResult({ key, tasks: [], error: e.message });
      });
    return () => controller.abort();
  }, [query, key, needsTasks, ready]);
  return (
    <Modal
      title="주간 할 일 기준"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        선택한 필터 조건에 맞는 연간 업무를 가져옵니다. 기준을 저장해도 기존
        주간 목록은 바뀌지 않습니다.
      </p>
      <label className="calendar-field">
        기준 속성
        <Select
          aria-label="기준 속성"
          value={propertyId}
          disabled={busy}
          onChange={(e) => {
            setPropertyId(e.target.value);
            setValues([]);
            setMode("include");
            setError("");
          }}
        >
          <option value="">속성을 선택하세요</option>
          {!property && propertyId && (
            <option value={propertyId}>삭제되거나 보관된 속성</option>
          )}
          {properties.map((p) => (
            <option
              key={p.id}
              value={p.id}
              disabled={!canUseCalendarRuleProperty(p)}
            >
              {p.name}
            </option>
          ))}
        </Select>
      </label>
      {loading && (
        <p role="status" className="calendar-hint">
          필터 값을 불러오고 있습니다…
        </p>
      )}
      {loadError && (
        <>
          <ErrorNote error={loadError} />
          <Button onClick={() => setAttempt((value) => value + 1)}>
            필터 값 다시 불러오기
          </Button>
        </>
      )}
      {allowedProperty && !loading && !loadError && (
        <fieldset className="calendar-rule-filter" disabled={busy}>
          <PropertyFilter
            key={property.id}
            property={property}
            tasks={ready ? result.tasks : []}
            users={context.members}
            selected={values}
            mode={mode}
            onChange={setValues}
            onModeChange={setMode}
          />
        </fieldset>
      )}
      {propertyId && <ErrorNote error={problem} />}
      <p className="calendar-hint">
        팀원 속성이 본인으로 설정된 업무만 가져옵니다. 담당자가 없는 업무는
        제외합니다. 대상 주의 연도에 속하는 업무만 가져옵니다.
      </p>
      <ErrorNote error={error} />
      <div className="calendar-actions">
        <Button
          disabled={busy || !!problem || loading || !!loadError}
          onClick={() => {
            setBusy(true);
            void send<{ rule: CalendarRule }>(
              `/calendar/teams/${teamId}/rule`,
              {
                propertyId,
                values,
                mode,
                expectedRevision: context.rule.revision,
              },
              "PUT",
            )
              .then((r) => {
                onSaved(r.rule);
                onClose();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          기준 저장
        </Button>
        <Button disabled={busy} onClick={onClose}>
          취소
        </Button>
      </div>
    </Modal>
  );
}
