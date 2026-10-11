import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  Circle,
  Crosshair,
  Eraser,
  MoveUpRight,
  Pencil,
  RotateCcw,
  Square,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type Tool = "cursor" | "pen" | "rectangle" | "ellipse" | "arrow" | "eraser";
type Point = { x: number; y: number };
type Mark = {
  id: number;
  tool: Exclude<Tool, "cursor" | "eraser">;
  color: string;
  points: Point[];
  fixedX: boolean;
  fixedY: boolean;
};
const COLORS = [
  { name: "빨강", value: "#e34d59" },
  { name: "노랑", value: "#d99a19" },
  { name: "초록", value: "#178665" },
  { name: "파랑", value: "#2869dc" },
  { name: "보라", value: "#8954c7" },
];
const TOOLS = [
  { id: "pen", name: "펜", Icon: Pencil },
  { id: "rectangle", name: "사각형", Icon: Square },
  { id: "ellipse", name: "원", Icon: Circle },
  { id: "arrow", name: "화살표", Icon: MoveUpRight },
  { id: "eraser", name: "지우개", Icon: Eraser },
] as const;

// 화면에 그리는 외곽선을 지우개 판정에도 함께 사용한다.
function outline(mark: Mark): Point[] {
  const a = mark.points[0],
    b = mark.points.at(-1)!;
  if (mark.tool === "pen") return mark.points;
  if (mark.tool === "rectangle")
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
  if (mark.tool === "ellipse") {
    const cx = (a.x + b.x) / 2,
      cy = (a.y + b.y) / 2;
    return Array.from({ length: 65 }, (_, i) => ({
      x: cx + (Math.abs(b.x - a.x) / 2) * Math.cos((i * Math.PI) / 32),
      y: cy + (Math.abs(b.y - a.y) / 2) * Math.sin((i * Math.PI) / 32),
    }));
  }
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const size = Math.min(13, Math.hypot(b.x - a.x, b.y - a.y) / 2);
  const head = (offset: number) => ({
    x: b.x - size * Math.cos(angle + offset),
    y: b.y - size * Math.sin(angle + offset),
  });
  return [a, b, head(Math.PI / 6), b, head(-Math.PI / 6)];
}
function nearSegment(p: Point, a: Point, b: Point, radius: number) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= radius;
}

export default function PresentationTools({
  workspaceRef,
  onClose,
}: {
  workspaceRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const [tool, setTool] = useState<Tool>("cursor");
  const [laserOn, setLaserOn] = useState(true);
  const [color, setColor] = useState(COLORS[0].value);
  const [pointerSize, setPointerSize] = useState(14);
  const [zoom, setZoom] = useState(100);
  const [zoomText, setZoomText] = useState("100");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [historySize, setHistorySize] = useState(0);
  const [viewport, setViewport] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const marksRef = useRef<Mark[]>([]);
  const history = useRef<Mark[][]>([]);
  const nextId = useRef(0);
  const pointer = useRef<HTMLDivElement>(null);
  const pointerPosition = useRef<Point | null>(null);
  const refreshPointer = useRef<(() => void) | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const finishRef = useRef<(() => void) | null>(null);
  const gesture = useRef<{
    pointerId: number;
    before: Mark[];
    mark?: Mark;
    link: HTMLAnchorElement | null;
    start: Point;
    moved: boolean;
  } | null>(null);
  const live = useRef({ tool, laserOn, color, zoom, undo });
  live.current = { tool, laserOn, color, zoom, undo };

  function showMarks(next: Mark[]) {
    marksRef.current = next;
    setMarks(next);
  }
  function remember(before: Mark[]) {
    history.current = [...history.current.slice(-49), before];
    setHistorySize(history.current.length);
  }
  function undo() {
    cancelRef.current?.();
    const previous = history.current.pop();
    if (previous) showMarks(previous);
    setHistorySize(history.current.length);
  }
  function clear() {
    cancelRef.current?.();
    if (!marksRef.current.length) return;
    remember(marksRef.current);
    showMarks([]);
  }
  function changeTool(next: Tool) {
    finishRef.current?.();
    setTool(next);
  }
  function changeZoom(value: number) {
    const next = Number.isFinite(value)
      ? Math.max(50, Math.min(200, Math.round(value)))
      : zoom;
    finishRef.current?.();
    setZoom(next);
    setZoomText(String(next));
  }

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const grid = workspace?.querySelector<HTMLElement>(".sheet-scroll");
    if (!workspace || !grid) return;
    let frame = 0;
    let suppressLinkClick = false;
    const measure = () => {
      const box = grid.getBoundingClientRect();
      const scale = live.current.zoom / 100;
      setViewport({
        left: box.left,
        top: box.top,
        width: grid.clientWidth * scale,
        height: grid.clientHeight * scale,
        scrollLeft: grid.scrollLeft,
        scrollTop: grid.scrollTop,
      });
    };
    measureRef.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    grid.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    measure();
    const position = (
      event: PointerEvent,
      space: Pick<Mark, "fixedX" | "fixedY">,
    ): Point => {
      const box = grid.getBoundingClientRect(),
        scale = live.current.zoom / 100;
      return {
        x:
          (event.clientX - box.left) / scale +
          (space.fixedX ? 0 : grid.scrollLeft),
        y:
          (event.clientY - box.top) / scale +
          (space.fixedY ? 0 : grid.scrollTop),
      };
    };
    const hidePointer = () => {
      if (pointer.current) pointer.current.hidden = true;
    };
    const insideGrid = (point: Point) => {
      const box = grid.getBoundingClientRect(),
        scale = live.current.zoom / 100;
      return (
        point.x >= box.left &&
        point.x < box.left + grid.clientWidth * scale &&
        point.y >= box.top &&
        point.y < box.top + grid.clientHeight * scale
      );
    };
    const renderPointer = () => {
      const point = pointerPosition.current;
      if (!pointer.current || !point) return;
      const box = workspace.getBoundingClientRect();
      const visible = live.current.laserOn
        ? point.x >= box.left &&
          point.x < box.right &&
          point.y >= box.top &&
          point.y < box.bottom
        : live.current.tool === "eraser" && insideGrid(point);
      pointer.current.hidden = !visible;
      pointer.current.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    };
    refreshPointer.current = renderPointer;
    const movePointer = (event: PointerEvent) => {
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      renderPointer();
    };
    const erase = (event: PointerEvent) => {
      const next = marksRef.current.filter((mark) => {
        const p = position(event, mark),
          points = outline(mark);
        const radius = 10 / (live.current.zoom / 100) + 1.5;
        return !points.some((point, i) =>
          nearSegment(p, points[Math.max(0, i - 1)], point, radius),
        );
      });
      if (next.length !== marksRef.current.length) showMarks(next);
    };
    const finish = (cancelled = false) => {
      const current = gesture.current;
      if (!current) return;
      gesture.current = null;
      suppressLinkClick = current.moved;
      cancelAnimationFrame(frame);
      frame = 0;
      setDraft(null);
      if (cancelled) showMarks(current.before);
      else if (current.mark && (!current.link || current.moved)) {
        const mark = current.mark;
        if (
          mark.tool === "pen" ||
          Math.hypot(
            mark.points[0].x - mark.points.at(-1)!.x,
            mark.points[0].y - mark.points.at(-1)!.y,
          ) >= 2
        ) {
          remember(current.before);
          showMarks([...current.before, mark]);
        }
      } else if (marksRef.current !== current.before) remember(current.before);
      if (grid.hasPointerCapture(current.pointerId))
        grid.releasePointerCapture(current.pointerId);
    };
    cancelRef.current = () => finish(true);
    finishRef.current = () => finish();
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        !insideGrid({ x: event.clientX, y: event.clientY })
      )
        return;
      movePointer(event);
      finish();
      suppressLinkClick = false;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]") || null;
      if (link && live.current.tool === "cursor") return;
      event.stopPropagation();
      grid.focus({ preventScroll: true });
      if (live.current.tool === "cursor") {
        // 그리기 도구가 꺼져 있으면 터치 스크롤은 브라우저가 처리한다.
        if (event.pointerType !== "touch") event.preventDefault();
        return;
      }
      event.preventDefault();
      const space = {
        fixedX: !!target?.closest(".fixed,.row-number"),
        fixedY: !!target?.closest(".sheet-header"),
      };
      const point = position(event, space);
      const mark =
        live.current.tool === "eraser"
          ? undefined
          : {
              id: ++nextId.current,
              tool: live.current.tool,
              color: live.current.color,
              points: [point],
              ...space,
            };
      gesture.current = {
        pointerId: event.pointerId,
        before: marksRef.current,
        mark,
        link,
        start: { x: event.clientX, y: event.clientY },
        moved: false,
      };
      // 링크의 단순 클릭은 브라우저가 열도록 클릭 대상을 그대로 둔다.
      // 드래그는 window 리스너로 받아, 이동이 확인된 뒤 필기를 시작한다.
      if (!link) {
        grid.setPointerCapture(event.pointerId);
        if (mark) setDraft({ ...mark });
        else erase(event);
      }
    };
    const move = (event: PointerEvent) => {
      movePointer(event);
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      // 창 밖에서 놓아 pointerup을 받지 못해도 이후 움직임이 필기에 붙지 않는다.
      if (!(event.buttons & 1)) {
        finish();
        return;
      }
      updateMark(event);
    };
    const updateMark = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      current.moved ||=
        Math.hypot(
          event.clientX - current.start.x,
          event.clientY - current.start.y,
        ) >= 4;
      if (current.link && !current.moved) return;
      if (!current.mark) {
        erase(event);
        return;
      }
      const mark = current.mark,
        p = position(event, mark),
        first = mark.points[0];
      if (mark.tool === "pen") {
        const last = mark.points.at(-1)!;
        if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.8) mark.points.push(p);
      } else {
        if (event.shiftKey && ["rectangle", "ellipse"].includes(mark.tool)) {
          const size = Math.max(
            Math.abs(p.x - first.x),
            Math.abs(p.y - first.y),
          );
          p.x = first.x + Math.sign(p.x - first.x || 1) * size;
          p.y = first.y + Math.sign(p.y - first.y || 1) * size;
        }
        mark.points = [first, p];
      }
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (gesture.current?.mark)
            setDraft({
              ...gesture.current.mark,
              points: [...gesture.current.mark.points],
            });
        });
    };
    const up = (event: PointerEvent) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      movePointer(event);
      updateMark(event);
      event.stopPropagation();
      finish();
    };
    const interrupted = (event: PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) finish();
    };
    const blur = () => {
      finish();
      hidePointer();
    };
    const block = (event: Event) => {
      const link =
        event.target instanceof Element && event.target.closest("a[href]");
      if (
        link &&
        (event.type === "contextmenu" ||
          (event.type === "click" &&
            (!suppressLinkClick || (event as MouseEvent).detail === 0)))
      ) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key === "Enter" &&
        event.target instanceof Element &&
        event.target.closest("a[href]")
      ) {
        suppressLinkClick = false;
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        live.current.undo();
      }
    };
    grid.addEventListener("pointerdown", down, true);
    // 캡처가 풀리거나 표 밖으로 나가도 동일한 제스처를 끝까지 받는다.
    // lostpointercapture는 입력 취소가 아니므로 필기를 되돌리지 않는다.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", interrupted, true);
    document.documentElement.addEventListener("pointerleave", hidePointer);
    for (const name of ["click", "dblclick", "contextmenu", "dragstart"])
      grid.addEventListener(name, block, true);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      cancelAnimationFrame(frame);
      const pointerId = gesture.current?.pointerId;
      gesture.current = null;
      if (pointerId !== undefined && grid.hasPointerCapture(pointerId))
        grid.releasePointerCapture(pointerId);
      grid.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", interrupted, true);
      document.documentElement.removeEventListener("pointerleave", hidePointer);
      for (const name of ["click", "dblclick", "contextmenu", "dragstart"])
        grid.removeEventListener(name, block, true);
      grid.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", keyboard, true);
      observer.disconnect();
      measureRef.current = null;
      cancelRef.current = null;
      finishRef.current = null;
      refreshPointer.current = null;
    };
  }, [workspaceRef]);
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const grid = workspace?.querySelector<HTMLElement>(".sheet-scroll");
    if (!workspace || !grid) return;
    const { scrollLeft, scrollTop } = grid;
    workspace.style.setProperty("--presentation-zoom", String(zoom / 100));
    workspace.dataset.presentationLaser = String(laserOn);
    grid.dataset.presentationTool = tool;
    grid.scrollTo(scrollLeft, scrollTop);
    refreshPointer.current?.();
    measureRef.current?.();
  }, [workspaceRef, tool, laserOn, zoom]);
  useLayoutEffect(
    () => () => {
      workspaceRef.current?.style.removeProperty("--presentation-zoom");
      if (workspaceRef.current)
        delete workspaceRef.current.dataset.presentationLaser;
      const grid =
        workspaceRef.current?.querySelector<HTMLElement>(".sheet-scroll");
      if (grid) delete grid.dataset.presentationTool;
    },
    [workspaceRef],
  );

  return (
    <>
      <div
        className="presentation-toolbar"
        role="toolbar"
        aria-label="보기모드 도구"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          );
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }}
      >
        <div className="presentation-tools">
          <div
            className="presentation-tool-group"
            role="group"
            aria-label="레이저 포인터 설정"
          >
            <button
              type="button"
              className="presentation-tool"
              title="레이저 포인터 켜기/끄기"
              aria-label="레이저 포인터"
              aria-pressed={laserOn}
              onClick={() => setLaserOn((on) => !on)}
            >
              <Crosshair size={17} />
              <span>레이저</span>
            </button>
            <label className="presentation-pointer-size">
              <span>포인터 크기</span>
              <input
                type="range"
                aria-label="레이저 포인터 크기"
                min={12}
                max={20}
                step={2}
                value={pointerSize}
                onChange={(event) => setPointerSize(Number(event.target.value))}
              />
              <output>{pointerSize}</output>
            </label>
          </div>
          <div
            className="presentation-tool-group"
            role="group"
            aria-label="그리기 도구"
          >
            {TOOLS.map(({ id, name, Icon }) => (
              <button
                key={id}
                type="button"
                className="presentation-tool"
                title={name}
                aria-label={name}
                aria-pressed={tool === id}
                onClick={() => changeTool(tool === id ? "cursor" : id)}
              >
                <Icon size={17} />
              </button>
            ))}
          </div>
          <div
            className="presentation-tool-group presentation-colors"
            role="group"
            aria-label="펜 색상"
          >
            {COLORS.map((item) => (
              <button
                key={item.value}
                type="button"
                className="presentation-color"
                title={item.name}
                aria-label={`펜 색상 ${item.name}`}
                aria-pressed={color === item.value}
                style={{ "--pen-color": item.value } as CSSProperties}
                onClick={() => {
                  setColor(item.value);
                  if (tool === "cursor" || tool === "eraser") changeTool("pen");
                }}
              />
            ))}
          </div>
          <div
            className="presentation-tool-group"
            role="group"
            aria-label="필기 정리"
          >
            <button
              type="button"
              className="presentation-tool"
              title="필기 실행취소 (⌘/Ctrl+Z)"
              aria-label="필기 실행취소"
              disabled={!historySize}
              onClick={undo}
            >
              <Undo2 size={17} />
            </button>
            <button
              type="button"
              className="presentation-tool"
              title="전체 지우기"
              aria-label="전체 지우기"
              disabled={!marks.length}
              onClick={clear}
            >
              <Eraser size={17} />
              <span>전체 지우기</span>
            </button>
          </div>
          <div
            className="presentation-tool-group presentation-zoom"
            role="group"
            aria-label="확대와 축소"
          >
            <button
              type="button"
              className="presentation-tool"
              title="축소"
              aria-label="축소"
              disabled={zoom <= 50}
              onClick={() => changeZoom(zoom - 25)}
            >
              <ZoomOut size={17} />
            </button>
            <label className="presentation-zoom-value">
              <input
                type="number"
                aria-label="확대율"
                title="확대율 (50~200%)"
                min={50}
                max={200}
                step={1}
                value={zoomText}
                onFocus={(event) => event.target.select()}
                onChange={(event) => setZoomText(event.target.value)}
                onBlur={(event) =>
                  changeZoom(
                    event.target.value === ""
                      ? zoom
                      : Number(event.target.value),
                  )
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === "Escape")
                    event.currentTarget.value = String(zoom);
                  event.currentTarget.blur();
                }}
              />
              <span aria-hidden="true">%</span>
            </label>
            <button
              type="button"
              className="presentation-tool"
              title="확대"
              aria-label="확대"
              disabled={zoom >= 200}
              onClick={() => changeZoom(zoom + 25)}
            >
              <ZoomIn size={17} />
            </button>
            <button
              type="button"
              className="presentation-tool"
              title="원래대로 (100%)"
              aria-label="원래대로"
              disabled={zoom === 100}
              onClick={() => changeZoom(100)}
            >
              <RotateCcw size={16} />
              <span>원래대로</span>
            </button>
          </div>
        </div>
        <button
          type="button"
          className="presentation-tool presentation-close"
          title="보기모드 닫기 (Esc)"
          aria-label="보기모드 닫기 (Esc)"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <svg
        className="presentation-annotations"
        aria-hidden="true"
        style={{
          left: viewport.left,
          top: viewport.top,
          width: viewport.width,
          height: viewport.height,
        }}
      >
        {[...marks, ...(draft ? [draft] : [])].map((mark) => {
          const points = outline(mark);
          return (
            <g
              key={mark.id}
              data-annotation={mark.tool}
              data-draft={draft?.id === mark.id || undefined}
              transform={`scale(${zoom / 100}) translate(${-(mark.fixedX ? 0 : viewport.scrollLeft)} ${-(mark.fixedY ? 0 : viewport.scrollTop)})`}
              fill="none"
              stroke={mark.color}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {points.length === 1 ? (
                <circle
                  cx={points[0].x}
                  cy={points[0].y}
                  r={1.5}
                  fill={mark.color}
                  stroke="none"
                />
              ) : (
                <polyline
                  points={points.map((p) => `${p.x},${p.y}`).join(" ")}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div
        ref={pointer}
        hidden
        className={`presentation-pointer ${!laserOn && tool === "eraser" ? "eraser" : "laser"}`}
        style={{ "--pointer-size": `${pointerSize}px` } as CSSProperties}
        aria-hidden="true"
      >
        <i />
      </div>
    </>
  );
}
