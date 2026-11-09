import { useEffect, useRef, useState } from "react";
import type React from "react";
import { trackPointerDrag } from "../ui/trackPointerDrag";
import type { Task, View } from "../types";
import type { Column } from "./grid-types";

// Preview belongs to the gesture. Commit one view change on release, discard on
// Escape, pointer cancellation, window blur or unmount through the shared tracker.
export default function useGridResize({
  scopeKey,
  zoom,
  view,
  onView,
  onStart,
}: {
  scopeKey: string;

  zoom: number;
  view: View;
  onView: (view: Partial<View>) => void;
  onStart: () => void;
}) {
  const [columnResize, setColumnResize] = useState<{
    key: string;
    width: number;
  } | null>(null);
  const [rowResize, setRowResize] = useState<{
    taskId: string;
    height: number;
  } | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), [scopeKey]);
  function startColumnResize(event: React.PointerEvent, column: Column) {
    event.preventDefault();
    event.stopPropagation();
    stop.current?.();
    onStart();
    const start = column.width;
    const widthAt = (x: number) =>
      Math.min(
        850,
        Math.max(column.month ? 40 : 45, start + (x - event.clientX) / zoom),
      );
    stop.current = trackPointerDrag(event, {
      onMove: (position) =>
        setColumnResize({ key: column.key, width: widthAt(position.clientX) }),
      onEnd(position, cancelled) {
        stop.current = null;
        setColumnResize(null);
        const width = widthAt(position.clientX);
        if (!cancelled && width !== start)
          onView({ widths: { ...view.widths, [column.key]: width } });
      },
    });
  }
  function startRowResize(
    event: React.PointerEvent,
    task: Task,
    start: number,
  ) {
    event.preventDefault();
    event.stopPropagation();
    stop.current?.();
    onStart();
    const heightAt = (y: number) =>
      Math.min(500, Math.max(26, start + (y - event.clientY) / zoom));
    stop.current = trackPointerDrag(event, {
      onMove: (position) =>
        setRowResize({ taskId: task.id, height: heightAt(position.clientY) }),
      onEnd(position, cancelled) {
        stop.current = null;
        setRowResize(null);
        const height = heightAt(position.clientY);
        if (!cancelled && height !== start)
          onView({ rowHeights: { ...view.rowHeights, [task.id]: height } });
      },
    });
  }
  return { columnResize, rowResize, startColumnResize, startRowResize };
}
