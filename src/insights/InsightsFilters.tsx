import { propertiesFor, isAssignable } from "../../shared/domain.js";
import PropertyFilter from "../sheet/PropertyFilter";
import type { Settings, Task, User, FilterMode } from "../types";
import type { InsightChart } from "./insights-types";
import { Button } from "../components";

export type InsightsFilter = NonNullable<InsightChart["filter"]>;
export default function InsightsFilters({
  settings,
  teamId,
  tasks,
  users,
  filter,
  onChange,
}: {
  settings: Settings;
  teamId: string;
  tasks: Task[];
  users: User[];
  filter: InsightsFilter;
  onChange: (filter: InsightsFilter) => void;
}) {
  return (
    <div className="insights-filters">
      {Object.values(filter.propertyFilters || {}).some(
        (values) => values.length > 0,
      ) && (
        <Button
          onClick={() =>
            onChange({ propertyFilters: {}, propertyFilterModes: {} })
          }
        >
          모든 필터 초기화
        </Button>
      )}
      {propertiesFor(settings).map((property) => (
        <details key={property.id}>
          <summary>
            {property.name}
            {filter.propertyFilters?.[property.id]?.length
              ? ` (${filter.propertyFilters[property.id].length})`
              : ""}
          </summary>
          <PropertyFilter
            property={property}
            tasks={tasks}
            users={users.filter((user) => isAssignable(user, teamId))}
            selected={filter.propertyFilters?.[property.id] || []}
            mode={filter.propertyFilterModes?.[property.id] || "include"}
            onChange={(values) =>
              onChange({
                ...filter,
                propertyFilters: {
                  ...filter.propertyFilters,
                  [property.id]: values,
                },
              })
            }
            onModeChange={(mode: FilterMode) =>
              onChange({
                ...filter,
                propertyFilterModes: {
                  ...filter.propertyFilterModes,
                  [property.id]: mode,
                },
              })
            }
          />
        </details>
      ))}
    </div>
  );
}
