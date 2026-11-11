import { useMemo } from "react";
import { statusSummary } from "../../shared/domain.js";
import { summaryPropertyWarning } from "../../shared/insights/insights-references.js";
import type { Settings, Task } from "../types";

export default function SheetSummary({
  tasks,
  settings,
}: {
  tasks: Task[];
  settings: Settings;
}) {
  const groups = useMemo(
    () => statusSummary(tasks, settings),
    [tasks, settings],
  );
  const warning = summaryPropertyWarning(settings);
  return (
    <div
      className="board-summary"
      aria-label="선택한 팀·표시 기간 전체 업무 통계"
      title="달력의 12개월에 해당하는 연도의 전체 업무 기준입니다. 필터와 숨김 설정에 영향을 받지 않습니다."
    >
      <span>
        <i className="summary-dot" />
        전체 업무 <strong>{tasks.length}</strong>
      </span>
      {!!warning && (
        <span className="summary-warning" role="status">
          {warning}
        </span>
      )}
      {groups.map((group) => (
        <span key={group.id}>
          <i className="summary-dot" style={{ backgroundColor: group.color }} />
          {group.label} <strong>{group.count}</strong>
        </span>
      ))}
    </div>
  );
}
