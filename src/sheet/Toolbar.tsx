import { useState, type ReactNode } from "react";
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
  Tag,
  Ellipsis,
} from "lucide-react";
import type { Style, Border, BorderPreset } from "../types";
import BorderMenu from "./BorderMenu";
import ColorMenu from "../ui/ColorMenu";
import ZoomControls from "../ui/ZoomControls";
import { FONTS, FONT_SIZES, textMode } from "../../shared/domain.js";
import { Button } from "../ui/Button";
import { inkFor } from "../ui/color";

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
  workColors,
  markedWorkColors,
}: {
  style: Style;
  workColors?: { color: string; name?: string }[];
  // 선택 범위의 업무 표시에 쓰인 색. 있으면 배경색·다른 업무 칩을 막고,
  // 그 색의 칩은 눌린 상태로 다시 누르면 업무 표시를 해제한다.
  markedWorkColors?: ReadonlySet<string>;
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
  // 휴대폰 폭에서는 핵심 도구만 보이고 "도구 더 보기"로 전체 도구를 펼친다.
  const [expanded, setExpanded] = useState(false);
  const workLocked = !!markedWorkColors?.size;
  return (
    <div
      className={`format-toolbar${expanded ? " expanded" : ""}`}
      aria-label={label}
    >
      {leadingAction}
      <div className="toolbar-group toolbar-core">
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
      <div className="toolbar-group toolbar-core">
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
            className={key === "bold" ? "" : "toolbar-extra"}
            disabled={disabled}
            active={!!style[key]}
            onClick={() => onStyle({ [key]: !style[key] })}
          >
            <Icon size={16} />
          </Button>
        ))}
      </div>
      <div className="toolbar-group toolbar-core">
        <ColorMenu
          label="글자 색상"
          icon="A"
          value={style.color || "#243642"}
          disabled={disabled}
          onApply={(color) => onStyle({ color })}
        />
        <ColorMenu
          label="배경색"
          tooltip={
            workLocked
              ? "배경색: 업무 표시 칩을 다시 눌러 해제한 뒤 칠하세요"
              : undefined
          }
          icon={<PaintBucket size={16} />}
          value={style.backgroundColor || "#ffffff"}
          disabled={disabled || workLocked}
          onApply={(backgroundColor) =>
            onStyle({ backgroundColor, work: false })
          }
        />
      </div>
      {!!workColors?.length && (
        // 업무 표시는 일반 배경색과 결과가 같아 보여도 집계 여부가 다르므로
        // 별도 묶음에 실제 색을 채운 칩으로 구분한다. 휴대폰 폭에서도 접힌
        // 핵심 도구 줄에 남긴다.
        <div
          className="toolbar-group toolbar-core work-mark-group"
          role="group"
          aria-label="업무 표시"
        >
          {workColors.map(({ color, name }) => {
            const label = `업무 표시: ${name || color}`,
              marked = !!markedWorkColors?.has(color);
            return (
              <button
                key={color}
                type="button"
                className="work-mark-chip"
                aria-label={label}
                data-tooltip={
                  marked
                    ? `${label} (다시 눌러 해제)`
                    : workLocked
                      ? `${label} (업무 표시를 먼저 해제하세요)`
                      : label
                }
                aria-pressed={marked}
                disabled={disabled || (workLocked && !marked)}
                style={{ backgroundColor: color, color: inkFor(color) }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  onStyle(
                    marked
                      ? { backgroundColor: null, work: false }
                      : { backgroundColor: color, work: true },
                  )
                }
              >
                <Tag size={12} aria-hidden="true" />
                {name && (
                  <span className="work-mark-name" aria-hidden="true">
                    {name}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
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
      <Button
        className="toolbar-more"
        tooltip={expanded ? "도구 접기" : "도구 더 보기"}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </Button>
      {selectionLabel !== undefined && (
        <span className="selection-label">
          {selectionLabel || "셀을 선택해 편집하세요"}
        </span>
      )}
    </div>
  );
}
