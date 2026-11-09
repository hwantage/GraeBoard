import { useState } from "react";
import { appendHistory, rebaseHistory, cellsBefore } from "./history";
import type {
  BatchResult,
  HistoryEntry,
  TaskCreation,
  TaskDeletion,
} from "../types";
import type { CellFailure } from "./useSheetOperations";

// Undo and redo are one state transition, regardless of the command source.
export default function useSheetHistory() {
  const [history, setHistory] = useState<{
    undo: HistoryEntry[];
    redo: HistoryEntry[];
  }>({ undo: [], redo: [] });
  function recordCells(result: BatchResult, mode: CellFailure["mode"]) {
    if (mode === "normal" && !result.cells.length && !result.formatOperation)
      return;
    setHistory(({ undo, redo }) => {
      if (mode === "normal")
        return { undo: appendHistory(undo, result), redo: [] };
      const source = mode === "undo" ? undo : redo;
      const rest = rebaseHistory(
        source.slice(0, -1),
        cellsBefore(source.at(-1)),
        result.cells,
        source.at(-1),
        result,
      );
      return mode === "undo"
        ? { undo: rest, redo: appendHistory(redo, result) }
        : { undo: appendHistory(undo, result), redo: rest };
    });
  }
  function recordTask(
    entry: TaskCreation | TaskDeletion,
    mode: CellFailure["mode"] = "normal",
    nextEntry = entry,
  ) {
    setHistory(({ undo, redo }) =>
      mode === "undo"
        ? {
            undo: undo.filter((item) => item !== entry),
            redo: appendHistory(redo, nextEntry),
          }
        : {
            undo: appendHistory(undo, nextEntry),
            redo: mode === "redo" ? redo.filter((item) => item !== entry) : [],
          },
    );
  }
  return {
    undoStack: history.undo,
    redoStack: history.redo,
    recordCells,
    recordTask,
    reset() {
      setHistory({ undo: [], redo: [] });
    },
  };
}
