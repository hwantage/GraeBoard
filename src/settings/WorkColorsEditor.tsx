import { useState } from "react";
import { GripVertical } from "lucide-react";
import { Button } from "../ui/Button";
import ColorMenu from "../ui/ColorMenu";
import { reorderItems, useListReorder } from "../ui/useListReorder";
import type { Settings } from "../types";

type WorkColors = NonNullable<Settings["insights"]>["workColors"];
export default function WorkColorsEditor({
  value,
  onChange,
  disabled,
}: {
  value: WorkColors;
  onChange: (colors: WorkColors) => void;
  disabled: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const reorder = useListReorder<HTMLDivElement>(
    value.map((_, index) => String(index)),
    (id, target, placement) =>
      onChange(
        reorderItems(
          value.map((entry, index) => ({ ...entry, id: String(index) })),
          id,
          target,
          placement,
        ).map(({ id, ...entry }) => entry),
      ),
    disabled,
  );
  return (
    <div
      className="settings-field work-colors-editor"
      role="group"
      aria-label="업무 색상 설정"
    >
      <span>업무 색상</span>
      <div ref={reorder.root}>
        {value.map((entry, index) => (
          <div
            key={index}
            className="work-color-row"
            {...reorder.itemProps(String(index))}
          >
            <button
              {...reorder.handleProps(String(index))}
              aria-label={`업무 색상 ${index + 1} 순서 이동`}
              disabled={disabled}
            >
              <GripVertical size={16} />
            </button>
            <ColorMenu
              label={`업무 색상 ${index + 1}`}
              value={entry.color}
              compact
              disabled={disabled}
              onApply={(color) =>
                onChange(
                  value.map((entry, i) =>
                    i === index ? { ...entry, color } : entry,
                  ),
                )
              }
            />
            <input
              aria-label={`업무 색상 ${index + 1} 이름`}
              placeholder="이름 (선택)"
              maxLength={40}
              value={entry.name || ""}
              disabled={disabled}
              onChange={(event) =>
                onChange(
                  value.map((entry, i) =>
                    i === index
                      ? { ...entry, name: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            <span>{entry.color}</span>
            <Button
              title={`업무 색상 ${index + 1} 삭제`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              삭제
            </Button>
          </div>
        ))}
      </div>
      <Button
        disabled={disabled || value.length >= 20}
        onClick={() => setAdding(!adding)}
      >
        업무 색상 추가
      </Button>
      {adding && (
        <div className="work-color-row">
          <ColorMenu
            label="새 업무 색상"
            value="#ffffff"
            disabled={disabled}
            onApply={(color) => {
              onChange([...value, { color }]);
              setAdding(false);
            }}
          />
          <span>추가할 색상을 고르세요.</span>
        </div>
      )}
    </div>
  );
}
