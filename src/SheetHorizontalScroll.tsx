import { useLayoutEffect, useRef, useState } from "react";

// Keep the table's horizontal scrollbar directly above its footer. The existing
// scroll element still owns both coordinates, sticky columns and virtualization.
export default function SheetHorizontalScroll({ width }: { width: number }) {
  const rail = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const bar = rail.current!;
    const sheet = bar.parentElement!;
    let mirroredLeft = bar.scrollLeft;
    const fromSheet = () => {
      if (bar.scrollLeft !== sheet.scrollLeft)
        bar.scrollLeft = sheet.scrollLeft;
      // The rail may clamp its scroll position to a slightly smaller maximum.
      // Its queued scroll event must not feed that adjustment back into the sheet.
      mirroredLeft = bar.scrollLeft;
    };
    const fromBar = () => {
      if (bar.scrollLeft === mirroredLeft) return;
      mirroredLeft = bar.scrollLeft;
      if (sheet.scrollLeft !== bar.scrollLeft)
        sheet.scrollLeft = bar.scrollLeft;
    };
    const resize = new ResizeObserver(() => {
      setOverflow(bar.scrollWidth > bar.clientWidth + 1);
      fromSheet();
    });
    resize.observe(bar);
    resize.observe(bar.firstElementChild!);
    const insideFooter = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest(".annual-memos");
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        insideFooter(event.target) ||
        bar.contains(event.target as Node)
      )
        return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (
        !delta ||
        (!event.shiftKey && Math.abs(delta) < Math.abs(event.deltaY))
      )
        return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? sheet.clientWidth
            : 1;
      sheet.scrollLeft += delta * unit;
    };
    let touch: { x: number; y: number; left: number } | null = null;
    const touchstart = (event: TouchEvent) => {
      touch =
        event.touches.length === 1 &&
        !insideFooter(event.target) &&
        !bar.contains(event.target as Node)
          ? {
              x: event.touches[0].clientX,
              y: event.touches[0].clientY,
              left: sheet.scrollLeft,
            }
          : null;
    };
    const touchmove = (event: TouchEvent) => {
      if (!touch || event.touches.length !== 1) return;
      const dx = touch.x - event.touches[0].clientX;
      const dy = touch.y - event.touches[0].clientY;
      if (Math.abs(dx) <= Math.abs(dy)) return;
      event.preventDefault();
      sheet.scrollLeft = touch.left + dx;
    };
    sheet.addEventListener("scroll", fromSheet, { passive: true });
    bar.addEventListener("scroll", fromBar, { passive: true });
    sheet.addEventListener("wheel", wheel, { passive: false });
    sheet.addEventListener("touchstart", touchstart, { passive: true });
    sheet.addEventListener("touchmove", touchmove, { passive: false });
    return () => {
      resize.disconnect();
      sheet.removeEventListener("scroll", fromSheet);
      bar.removeEventListener("scroll", fromBar);
      sheet.removeEventListener("wheel", wheel);
      sheet.removeEventListener("touchstart", touchstart);
      sheet.removeEventListener("touchmove", touchmove);
    };
  }, []);
  return (
    <div
      ref={rail}
      className="sheet-horizontal-scroll"
      aria-label="업무 표 가로 스크롤"
      role="group"
      tabIndex={overflow ? 0 : -1}
      aria-hidden={!overflow}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div style={{ width, height: 1 }} />
    </div>
  );
}
