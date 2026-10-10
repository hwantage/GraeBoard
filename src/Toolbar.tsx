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
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  WrapText,
  PaintBucket,
  EyeOff,
  ChevronsLeftRight,
  Copy,
} from "lucide-react";
import type { Style, Border, BorderPreset } from "./types";
import BorderMenu from "./BorderMenu";
import { FONTS, FONT_SIZES, PALETTE, textMode } from "../shared/domain.js";
import { Button } from "./components";
export default function Toolbar({
  style,
  disabled,
  onStyle,
  onBorder,
  onReset,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onHide,
  selectionLabel,
  onCopy,
}: {
  style: Style;
  disabled: boolean;
  onStyle: (s: Partial<Style>) => void;
  onBorder: (preset: BorderPreset, border: Border) => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onHide: () => void;
  selectionLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className="format-toolbar" aria-label="셀 서식 도구">
      <div className="toolbar-group">
        <Button title="실행취소" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={16} />
        </Button>
        <Button title="재실행" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={16} />
        </Button>
      </div>
      <div className="toolbar-group">
        <FormatSelect
          className="font-family"
          label="글꼴"
          value={style.fontFamily || FONTS[0]}
          options={FONTS.map((f) => ({ value: f, label: f }))}
          disabled={disabled}
          onSelect={(value) => onStyle({ fontFamily: value })}
        />
        <FormatSelect
          className="font-size"
          label="글자 크기"
          value={String(style.fontSize || 9)}
          options={FONT_SIZES.map((size) => ({
            value: String(size),
            label: String(size),
          }))}
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
            title={title}
            disabled={disabled}
            active={!!style[key]}
            onClick={() => onStyle({ [key]: !style[key] })}
          >
            <Icon size={16} />
          </Button>
        ))}
      </div>
      <div className="toolbar-group">
        <label
          className={`color-tool ${disabled ? "disabled" : ""}`}
          title="글자 색상"
        >
          <span className="color-tool-icon" aria-hidden="true">
            A
          </span>
          <span
            className="color-tool-swatch"
            style={{ backgroundColor: style.color || "#243642" }}
            aria-hidden="true"
          />
          <input
            aria-label="글자 색상"
            type="color"
            value={style.color || "#243642"}
            list="cell-colors"
            disabled={disabled}
            onChange={(e) => onStyle({ color: e.target.value })}
          />
        </label>
        <label
          className={`color-tool ${disabled ? "disabled" : ""}`}
          title="배경색"
        >
          <span className="color-tool-icon" aria-hidden="true">
            <PaintBucket size={16} />
          </span>
          <span
            className="color-tool-swatch"
            style={{ backgroundColor: style.backgroundColor || "#ffffff" }}
            aria-hidden="true"
          />
          <input
            aria-label="배경색"
            type="color"
            value={style.backgroundColor || "#ffffff"}
            list="cell-colors"
            disabled={disabled}
            onChange={(e) => onStyle({ backgroundColor: e.target.value })}
          />
        </label>
        <datalist id="cell-colors">
          {PALETTE.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </datalist>
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
            title={label}
            active={(style.textAlign || "left") === key}
            disabled={disabled}
            onClick={() => onStyle({ textAlign: key })}
          >
            <Icon size={16} />
          </Button>
        ))}
        <FormatSelect
          label="세로 정렬"
          disabled={disabled}
          value={style.verticalAlign || "middle"}
          options={[
            { value: "top", label: "위" },
            { value: "middle", label: "중간" },
            { value: "bottom", label: "아래" },
          ]}
          onSelect={(value) =>
            onStyle({ verticalAlign: value as Style["verticalAlign"] })
          }
        />
        <FormatSelect
          label="텍스트 표시"
          disabled={disabled}
          value={textMode(style)}
          options={[
            { value: "overflow", label: "오버플로우" },
            { value: "wrap", label: "줄바꿈" },
            { value: "clip", label: "자르기" },
          ]}
          onSelect={(value) =>
            onStyle({
              textMode: value as Style["textMode"],
              wrap: value === "wrap",
            })
          }
        />
      </div>
      <div className="toolbar-group">
        <BorderMenu disabled={disabled} onApply={onBorder} />
        <Button title="서식 초기화" disabled={disabled} onClick={onReset}>
          <ChevronsLeftRight size={16} />
        </Button>
        <Button
          title="선택 셀 복사"
          onClick={onCopy}
          disabled={!selectionLabel}
        >
          <Copy size={15} />
        </Button>
        <Button
          title="선택 행 숨기기"
          onClick={onHide}
          disabled={!selectionLabel}
        >
          <EyeOff size={16} />
        </Button>
      </div>
      <span className="selection-label">
        {selectionLabel || "셀을 선택해 편집하세요"}
      </span>
    </div>
  );
}
