import type { ReactNode } from "react";
import FormatSelect from "./FormatSelect";
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  PaintBucket,
  PaintRoller,
} from "lucide-react";
import type { Style, Border, BorderPreset } from "./types";
import BorderMenu from "./BorderMenu";
import ColorMenu from "./ColorMenu";
import ZoomControls from "./ZoomControls";
import { FONTS, FONT_SIZES, textMode } from "../shared/domain.js";
import { Button } from "./components";

const ICON_PATHS: Record<string, string> = {
  top: "M4 4h16M12 20V8m-4 4 4-4 4 4",
  middle: "M4 12h16M12 2v6m-3-3 3 3 3-3M12 22v-6m-3 3 3-3 3 3",
  bottom: "M4 20h16M12 4v12m-4-4 4 4 4-4",
  overflow: "M4 3v5m0 8v5M13 3v5m0 8v5M3 12h18m-4-4 4 4-4 4",
  wrap: "M4 5h11a4 4 0 0 1 0 8H9m3-3-3 3 3 3M4 9h3M4 17h3",
  clip: "M4 3v18M20 3v18M7 12h9m-3-3 3 3-3 3",
};
function FormatIcon({ kind }: { kind: string }) {
  const paths = ICON_PATHS;
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
// 선택이 바뀔 때마다 옵션 배열과 아이콘을 다시 만들지 않도록 모듈에서 한 번만 만든다.
const FONT_OPTIONS = FONTS.map((f) => ({ value: f, label: f }));
const FONT_SIZE_OPTIONS = FONT_SIZES.map((size) => ({
  value: String(size),
  label: String(size),
}));
const VERTICAL_ALIGN_OPTIONS = [
  { value: "top", label: "위", icon: <FormatIcon kind="top" /> },
  { value: "middle", label: "중간", icon: <FormatIcon kind="middle" /> },
  { value: "bottom", label: "아래", icon: <FormatIcon kind="bottom" /> },
];
const TEXT_MODE_OPTIONS = [
  {
    value: "overflow",
    label: "오버플로우",
    icon: <FormatIcon kind="overflow" />,
  },
  { value: "wrap", label: "줄바꿈", icon: <FormatIcon kind="wrap" /> },
  { value: "clip", label: "자르기", icon: <FormatIcon kind="clip" /> },
];
export default function Toolbar({
  style,
  disabled,
  onStyle,
  onBorder,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  leadingAction,
  trailingAction,
  selectionLabel,
  zoom,
  onZoom,
  label = "셀 서식 도구",
  formatPainting,
  canCopyFormat = true,
  onPaintFormat,
}: {
  style: Style;
  disabled: boolean;
  onStyle: (s: Partial<Style>) => void;
  onBorder: (preset: BorderPreset, border: Border | null) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  leadingAction?: ReactNode;
  trailingAction?: ReactNode;
  selectionLabel?: string;
  zoom?: number;
  onZoom?: (zoom: number) => void;
  label?: string;
  formatPainting?: boolean;
  canCopyFormat?: boolean;
  onPaintFormat?: (repeat: boolean) => void;
}) {
  return (
    <div className="format-toolbar" aria-label={label}>
      {leadingAction}
      <div className="toolbar-group">
        <Button tooltip="실행취소" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={16} />
        </Button>
        <Button tooltip="재실행" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={16} />
        </Button>
        {onPaintFormat && (
          <button
            type="button"
            className={`button${formatPainting ? " active" : ""}`}
            aria-label="서식 복사"
            data-tooltip="서식 복사 (두 번 클릭: 연속 적용 · Esc: 취소)"
            aria-pressed={!!formatPainting}
            disabled={disabled || !canCopyFormat}
            onClick={(event) => onPaintFormat(event.detail > 1)}
          >
            <PaintRoller size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="toolbar-group">
        <FormatSelect
          className="font-family"
          label="글꼴"
          value={style.fontFamily || FONTS[0]}
          options={FONT_OPTIONS}
          disabled={disabled}
          onSelect={(value) => onStyle({ fontFamily: value })}
        />
        <FormatSelect
          className="font-size"
          label="글자 크기"
          value={String(style.fontSize || 9)}
          options={FONT_SIZE_OPTIONS}
          disabled={disabled}
          onSelect={(value) => onStyle({ fontSize: Number(value) })}
        />
      </div>
      <div className="toolbar-group">
        {(
          [
            [Bold, "굵게", "bold"],
            [Italic, "기울임", "italic"],
            [Underline, "밑줄", "underline"],
            [Strikethrough, "취소선", "strike"],
          ] as const
        ).map(([Icon, title, key]) => (
          <Button
            key={key}
            tooltip={title}
            disabled={disabled}
            active={!!style[key]}
            onClick={() => onStyle({ [key]: !style[key] })}
          >
            <Icon size={16} />
          </Button>
        ))}
      </div>
      <div className="toolbar-group">
        <ColorMenu
          label="글자 색상"
          icon="A"
          value={style.color || "#243642"}
          disabled={disabled}
          onApply={(color) => onStyle({ color })}
        />
        <ColorMenu
          label="배경색"
          icon={<PaintBucket size={16} />}
          value={style.backgroundColor || "#ffffff"}
          disabled={disabled}
          onApply={(backgroundColor) => onStyle({ backgroundColor })}
        />
      </div>
      <div className="toolbar-group">
        {(
          [
            [AlignLeft, "왼쪽 정렬", "left"],
            [AlignCenter, "가운데 정렬", "center"],
            [AlignRight, "오른쪽 정렬", "right"],
          ] as const
        ).map(([Icon, label, key]) => (
          <Button
            key={key}
            tooltip={label}
            active={(style.textAlign || "left") === key}
            disabled={disabled}
            onClick={() => onStyle({ textAlign: key })}
          >
            <Icon size={16} />
          </Button>
        ))}
        <FormatSelect
          label="세로 정렬"
          iconOnly
          disabled={disabled}
          value={style.verticalAlign || "middle"}
          options={VERTICAL_ALIGN_OPTIONS}
          onSelect={(value) =>
            onStyle({ verticalAlign: value as Style["verticalAlign"] })
          }
        />
        <FormatSelect
          label="텍스트 표시"
          iconOnly
          disabled={disabled}
          value={textMode(style)}
          options={TEXT_MODE_OPTIONS}
          onSelect={(value) =>
            onStyle({
              textMode: value as Style["textMode"],
            })
          }
        />
      </div>
      <div className="toolbar-group">
        <BorderMenu
          disabled={disabled}
          onApply={onBorder}
          single={selectionLabel === undefined}
        />
      </div>
      {zoom !== undefined && onZoom && (
        <ZoomControls value={zoom} onChange={onZoom} />
      )}
      {trailingAction && <div className="toolbar-group">{trailingAction}</div>}
      {selectionLabel !== undefined && (
        <span className="selection-label">
          {selectionLabel || "셀을 선택해 편집하세요"}
        </span>
      )}
    </div>
  );
}
