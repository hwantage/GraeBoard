import {
  MousePointer2,
  Hand,
  Pencil,
  Square,
  Circle,
  Triangle,
  Type,
  ZoomIn,
  ZoomOut,
  Scan,
  Undo2,
  Redo2,
  Trash2,
  ListX,
  Eye,
  Check,
  PaintBucket,
  CircleOff,
} from "lucide-react";
import { Button } from "../../ui/Button";
import ColorMenu from "../../ui/ColorMenu";
import type { ImageStyle, ImageTool } from "./document-image-annotations";

type Props = {
  tool: ImageTool;
  onTool: (tool: ImageTool) => void;
  disabled: boolean;
  style: ImageStyle;
  onStyle: (change: Partial<ImageStyle>) => void;
  text: string;
  onText: (text: string) => void;
  textVisible: boolean;
} & (
  | { placement: "bottom" }
  | {
      placement: "top";
      scale: number;
      onZoom: (scale: number | null) => void;
      undo: () => void;
      redo: () => void;
      canUndo: boolean;
      canRedo: boolean;
      remove: () => void;
      clear: () => void;
      hasSelection: boolean;
      hasMarks: boolean;
      original: boolean;
      onOriginal: () => void;
      onSave: () => void;
      busy: boolean;
    }
);
const tools = [
  ["select", "선택", MousePointer2],
  ["pan", "화면 이동", Hand],
  ["pen", "펜", Pencil],
  ["rectangle", "사각형", Square],
  ["ellipse", "원", Circle],
  ["triangle", "삼각형", Triangle],
  ["text", "글자", Type],
] as const;
export default function DocumentImageTools(props: Props) {
  const { disabled, style, onStyle } = props;
  if (props.placement === "top")
    return (
      <div
        className="document-image-editor-toolbar"
        role="toolbar"
        aria-label="이미지 보기와 편집 이력"
      >
        <div className="document-image-editor-group">
          <Button
            tooltip="축소"
            disabled={disabled || props.scale <= 0.05}
            onClick={() => props.onZoom(props.scale / 1.25)}
          >
            <ZoomOut size={17} />
          </Button>
          <output
            className="document-image-editor-zoom"
            aria-label="이미지 배율"
          >
            {Math.round(props.scale * 100)}%
          </output>
          <Button
            tooltip="확대"
            disabled={disabled || props.scale >= 4}
            onClick={() => props.onZoom(props.scale * 1.25)}
          >
            <ZoomIn size={17} />
          </Button>
          <Button
            tooltip="화면에 맞추기"
            disabled={disabled}
            onClick={() => props.onZoom(null)}
          >
            <Scan size={17} />
          </Button>
        </div>
        <div className="document-image-editor-group">
          <Button
            tooltip="실행취소"
            disabled={disabled || !props.canUndo}
            onClick={props.undo}
          >
            <Undo2 size={17} />
          </Button>
          <Button
            tooltip="다시실행"
            disabled={disabled || !props.canRedo}
            onClick={props.redo}
          >
            <Redo2 size={17} />
          </Button>
        </div>
        <div className="document-image-editor-group">
          <Button
            tooltip="선택 삭제"
            disabled={disabled || !props.hasSelection || props.original}
            onClick={props.remove}
          >
            <Trash2 size={17} />
          </Button>
          <Button
            tooltip="전체 지우기"
            disabled={disabled || !props.hasMarks || props.original}
            onClick={props.clear}
          >
            <ListX size={17} />
          </Button>
        </div>
        <div className="document-image-editor-group document-image-editor-actions">
          <Button
            tooltip="원본 보기"
            aria-pressed={props.original}
            disabled={disabled}
            onClick={props.onOriginal}
          >
            <Eye size={17} />
            <span>원본</span>
          </Button>
          <Button
            className="primary"
            disabled={disabled || !props.hasMarks}
            onClick={props.onSave}
          >
            <Check size={16} />
            {props.busy ? "저장 중…" : "적용"}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="document-image-editor-bottom">
      <div
        className="document-image-editor-toolbar"
        role="toolbar"
        aria-label="이미지 그리기 도구"
      >
        <div className="document-image-editor-group document-image-editor-draw-tools">
          {tools.map(([value, label, Icon]) => (
            <Button
              key={value}
              tooltip={label}
              aria-pressed={props.tool === value}
              disabled={disabled}
              onClick={() => props.onTool(value)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </Button>
          ))}
        </div>
        <div className="document-image-editor-group document-image-editor-properties">
          <ColorMenu
            label="선 색상"
            value={style.stroke}
            icon={<Pencil size={16} />}
            disabled={disabled}
            onApply={(stroke) => onStyle({ stroke })}
          />
          <ColorMenu
            label="채우기 색상"
            value={style.fill}
            icon={<PaintBucket size={16} />}
            disabled={disabled}
            onApply={(fill) => onStyle({ fill })}
          />
          <Button
            tooltip="채우기 없음"
            aria-pressed={!style.fill}
            disabled={disabled}
            onClick={() => onStyle({ fill: "" })}
          >
            <CircleOff size={16} />
          </Button>
          <label>
            굵기
            <input
              type="number"
              aria-label="선 굵기"
              min={1}
              max={40}
              value={style.lineWidth}
              disabled={disabled}
              onChange={(event) => {
                const lineWidth = Number(event.target.value);
                if (lineWidth >= 1 && lineWidth <= 40) onStyle({ lineWidth });
              }}
            />
          </label>
        </div>
      </div>
      {props.textVisible && (
        <div className="document-image-editor-text">
          <input
            aria-label="이미지에 넣을 글자"
            placeholder="글자를 입력한 뒤 이미지에서 위치 선택"
            value={props.text}
            disabled={disabled}
            onChange={(event) => props.onText(event.target.value)}
          />
          <label>
            크기
            <input
              type="number"
              aria-label="글자 크기"
              min={6}
              max={300}
              value={Math.round(style.fontSize)}
              disabled={disabled}
              onChange={(event) => {
                const fontSize = Number(event.target.value);
                if (fontSize >= 6 && fontSize <= 300) onStyle({ fontSize });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
