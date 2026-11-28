import { Code, Pencil } from "lucide-react";

export type DocumentMode = "rich" | "source";

export default function DocumentModeToggle({
  mode,
  disabled = false,
  onChange,
}: {
  mode: DocumentMode;
  disabled?: boolean;
  // `pointer` is true for a click or tap, false for Enter or Space.
  onChange: (mode: DocumentMode, pointer: boolean) => void;
}) {
  return (
    <div className="document-modes" role="group" aria-label="문서 편집 모드">
      {(
        [
          ["source", "Markdown 원문", Code],
          ["rich", "리치 문서", Pencil],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          data-tooltip={label}
          aria-pressed={mode === value}
          disabled={disabled}
          onClick={(event) => onChange(value, event.detail > 0)}
        >
          <Icon size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
