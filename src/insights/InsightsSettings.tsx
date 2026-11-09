import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import Select from "../ui/Select";
import Toast, { useToast } from "../ui/Toast";
import { insightsSettingsSchema } from "../../shared/insights/insights-schema.js";
import { deadlinePropertyId } from "../../shared/insights/insights.js";
import { propertiesFor } from "../../shared/domain.js";
import type { Settings } from "../types";
import type { InsightsSettings as InsightsSettingsData } from "./insights-types";

export default function InsightsSettings({
  settings,
  onClose,
  onSave,
}: {
  settings: Settings;
  onClose: () => void;
  onSave: (draft: InsightsSettingsData, revision: number) => Promise<Settings>;
}) {
  const [draft, setDraft] = useState<InsightsSettingsData>(() => ({
    ...(settings.insights || { workColors: [], charts: [] }),
    deadlinePropertyId: deadlinePropertyId(settings),
  }));
  const [revision, setRevision] = useState(settings.revision || 0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [message, setMessage] = useToast();
  const dates = propertiesFor(settings, true).filter((p) => p.kind === "date");
  const deadline = draft.deadlinePropertyId;
  const deadlineProperty = dates.find((p) => p.id === deadline);
  const parsed = insightsSettingsSchema.safeParse(draft);
  return (
    <Modal
      title="인사이트 설정"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <fieldset disabled={busy} className="insights-settings">
        <label>
          목표일 기준 속성
          <Select
            aria-label="목표일 기준 속성"
            value={deadline || ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                deadlinePropertyId: event.target.value || null,
              })
            }
          >
            <option value="">사용 안 함</option>
            {dates.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
                {property.archived ? " (보관된 속성)" : ""}
              </option>
            ))}
            {!!deadline && !deadlineProperty && (
              <option value={deadline}>없는 속성: {deadline}</option>
            )}
          </Select>
        </label>
        {!!deadline && (!deadlineProperty || deadlineProperty.archived) && (
          <p className="field-help">
            {deadlineProperty ? "보관된 속성" : "참조 속성이 없습니다"}:{" "}
            {deadlineProperty?.name || deadline}
          </p>
        )}
        <ErrorNote
          error={
            error || (!parsed.success ? parsed.error.issues[0].message : "")
          }
        />
        <div className="panel-actions">
          <Button
            className="primary"
            disabled={busy || !parsed.success}
            onClick={async () => {
              if (!parsed.success) return;
              setBusy(true);
              setError("");
              setMessage("");
              try {
                const saved = await onSave(parsed.data, revision);
                setRevision(saved.revision || 0);
                setDraft(saved.insights!);
                setMessage("인사이트 설정을 저장했습니다.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            저장
          </Button>
        </div>
      </fieldset>
      <Toast message={message} />
    </Modal>
  );
}
