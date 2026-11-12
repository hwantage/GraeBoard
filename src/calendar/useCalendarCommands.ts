import { useEffect, useRef, useState } from "react";

import { api, ApiError, send } from "../platform/api";

import {
  deleteCalendarEntry,
  saveCalendarEntryTags,
} from "./calendar-entry-actions";

import {
  markSecretDocumentDeleted,
  discardSecretDocument,
} from "./secret-document-storage";
import {
  copySecretEntry,
  deleteSecretEntry,
  setSecretEntryTags,
  setSecretTagChecked,
  isSecretEntry,
  moveSecretEntry,
  saveSecretEntry,
  type SecretCalendarEntry,
} from "./secret-calendar";

import {
  applyCalendarTagCheck,
  saveCalendarTagCheck,
} from "./calendar-tag-checks";
import { type CalendarRange } from "./useCalendarDrag";

import { useCalendarData } from "./useCalendarData";
import { mergeCalendarLayout } from "../../shared/calendar/calendar-layout.js";

import { weekLabel } from "../../shared/calendar/calendar.js";

import type { Task, Team, User } from "../types";
import type {
  CalendarContext,
  CalendarEntry,
  CalendarEntryUpdate,
  CalendarTag,
  CalendarEntryDeletion,
  WeeklyItem,
  WeeklyAddResult,
  WeeklyRemoveResult,
  WeeklyRestoreResult,
} from "./calendar-types";
import type useCalendarMutation from "./useCalendarMutation";
import type useCalendarCreation from "./useCalendarCreation";
export default function useCalendarCommands({
  scope,
  mutation,
  team,
  user,
  members,
  tagOwner,
  undoBlocked,
  locked,
  writable,
  schedules,
  updateData,
  setContext,
  setTagEntry,
  setCreating,
  setEntry,
  setTask,
  setRangeChange,
  setRangeConflict,
  setError,
  onNotify,
}: {
  scope: string;
  mutation: ReturnType<typeof useCalendarMutation>;
  team: Team;
  user: User;
  members: User[];
  tagOwner: string | null;
  undoBlocked: boolean;
  locked: boolean;
  writable: (ownerId: string | null) => boolean;
  schedules: ReturnType<typeof useCalendarData>["schedules"];
  updateData: ReturnType<typeof useCalendarData>["updateData"];
  setContext: React.Dispatch<React.SetStateAction<CalendarContext | null>>;
  setTagEntry: React.Dispatch<React.SetStateAction<CalendarEntry | null>>;
  setCreating: ReturnType<typeof useCalendarCreation>["setCreating"];
  setEntry: React.Dispatch<React.SetStateAction<CalendarEntry | null>>;
  setTask: React.Dispatch<React.SetStateAction<Task | null>>;
  setRangeChange: React.Dispatch<
    React.SetStateAction<{
      entry: CalendarEntry;
      range: CalendarRange;
      lane?: number;
    } | null>
  >;
  setRangeConflict: React.Dispatch<
    React.SetStateAction<(CalendarRange & { lane?: number }) | null>
  >;
  setError: (message: string) => void;
  onNotify: (message: string) => void;
}) {
  const { activeScope, alive, busy, action, localAction } = mutation;
  const copyRequest = useRef<{ source: CalendarEntry; id: string } | null>(
    null,
  );
  const deleteRequests = useRef(new Map<string, string>());
  const [deleted, setDeleted] = useState<{
    entry: CalendarEntry;
    deletionId: string;
  } | null>(null);
  const [removedWeekly, setRemovedWeekly] = useState<{
    item: WeeklyItem;
    teamId: string;
  } | null>(null);
  const [importing, setImporting] = useState<{
    userId: string;
    weekStart: string;
  } | null>(null);
  useEffect(() => {
    if ((!deleted && !removedWeekly) || undoBlocked) return;
    const timer = setTimeout(() => {
      setDeleted(null);
      setRemovedWeekly(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [deleted, removedWeekly, undoBlocked]);
  useEffect(() => {
    setDeleted(null);
    setRemovedWeekly(null);
  }, [team.id, user.id]);
  useEffect(
    () => () => {
      if (deleted && isSecretEntry(deleted.entry)) {
        const entry = deleted.entry;
        void discardSecretDocument(entry.userId, entry.teamId, entry.id).catch(
          (error) => {
            if (alive.current) setError(error.message);
          },
        );
      }
    },
    [deleted],
  );
  function upsert({ placements = [], layout, ...saved }: CalendarEntryUpdate) {
    if (isSecretEntry(saved) || activeScope.current !== scope || !alive.current)
      return;
    const positions = new Map(placements.map((item) => [item.id, item.lane]));
    updateData((previous, query) =>
      query.userId !== saved.userId
        ? previous
        : {
            ...previous,
            layout: mergeCalendarLayout(previous.layout, layout || [saved]),
            entries: [
              ...previous.entries
                .filter((item) => item.id !== saved.id)
                .map((item) => {
                  const lane = positions.get(item.id);
                  return lane === undefined || lane === item.lane
                    ? item
                    : { ...item, lane };
                }),
              ...(saved.date <= query.to && saved.endDate >= query.from
                ? [saved]
                : []),
            ],
          },
    );
  }
  function changeTags(next: CalendarTag[]) {
    const available = new Set(next.map((tag) => tag.id));
    const checkable = new Set(
      next.filter((tag) => tag.kind === "check").map((tag) => tag.id),
    );
    setContext(
      (previous) =>
        previous && {
          ...previous,
          tags: [
            ...previous.tags.filter((tag) => tag.userId !== tagOwner),
            ...next,
          ],
        },
    );
    // Names and colors are resolved through the owner's catalog. Only removal
    // changes entry references; no calendar reload is needed for tag edits.
    updateData((previous, query) => {
      if (query.userId !== tagOwner) return previous;
      if (
        !previous.entries.some(
          (item) =>
            item.tagIds.some((id) => !available.has(id)) ||
            item.checkedTagIds.some((id) => !checkable.has(id)),
        )
      )
        return previous;
      return {
        ...previous,
        entries: previous.entries.map((item) =>
          item.tagIds.some((id) => !available.has(id)) ||
          item.checkedTagIds.some((id) => !checkable.has(id))
            ? {
                ...item,
                tagIds: item.tagIds.filter((id) => available.has(id)),
                checkedTagIds: item.checkedTagIds.filter((id) =>
                  checkable.has(id),
                ),
              }
            : item,
        ),
      };
    });
    setTagEntry((previous) =>
      previous && previous.userId === tagOwner && !isSecretEntry(previous)
        ? {
            ...previous,
            tagIds: previous.tagIds.filter((id) => available.has(id)),
            checkedTagIds: previous.checkedTagIds.filter((id) =>
              checkable.has(id),
            ),
          }
        : previous,
    );
    setCreating((previous) =>
      previous && previous.userId === tagOwner
        ? {
            ...previous,
            tagIds: previous.tagIds.filter((id) => available.has(id)),
            checkedTagIds: previous.checkedTagIds.filter((id) =>
              checkable.has(id),
            ),
          }
        : previous,
    );
  }
  function entryDeleted(
    removed: CalendarEntry,
    { deletionId, placements, layout }: CalendarEntryDeletion,
  ) {
    const positions = new Map(placements.map((item) => [item.id, item.lane]));
    updateData((previous, query) =>
      query.userId !== removed.userId
        ? previous
        : {
            ...previous,
            layout: mergeCalendarLayout(previous.layout, layout, removed.id),
            entries: previous.entries
              .filter((item) => item.id !== removed.id)
              .map((item) => {
                const lane = positions.get(item.id);
                return lane === undefined || lane === item.lane
                  ? item
                  : { ...item, lane };
              }),
          },
    );
    setDeleted({ entry: removed, deletionId });
    setRemovedWeekly(null);
    onNotify("");
    setEntry(null);
  }
  async function removeSecret(source: SecretCalendarEntry) {
    await markSecretDocumentDeleted(
      source.userId,
      source.teamId,
      source.id,
      true,
    );
    const removed = deleteSecretEntry(source);
    setDeleted({ entry: removed, deletionId: "" });
    setRemovedWeekly(null);
    onNotify("");
    setEntry(null);
  }
  async function duplicateEntry(source: CalendarEntry) {
    if (isSecretEntry(source)) {
      localAction(() => {
        copySecretEntry(
          source,
          schedules.get(source.userId)?.data?.layout || [],
        );
      });
      return;
    }
    if (!writable(source.userId)) return;
    if (copyRequest.current?.source.id !== source.id)
      copyRequest.current = { source, id: crypto.randomUUID() };
    const copy = copyRequest.current;
    await action(async () => {
      const saved = await send<CalendarEntry>(
        `/calendar/entries/${copy.source.id}/copy`,
        { id: copy.id },
      );
      upsert(saved);
      copyRequest.current = null;
    });
  }
  async function removeEntry(source: CalendarEntry) {
    if (isSecretEntry(source)) {
      localAction(() => removeSecret(source));
      return;
    }
    if (!writable(source.userId)) return;
    const deletionId =
      deleteRequests.current.get(source.id) || crypto.randomUUID();
    deleteRequests.current.set(source.id, deletionId);
    await action(async () => {
      const result = await deleteCalendarEntry(source, deletionId);
      if (!alive.current) return;
      entryDeleted(source, result);
      deleteRequests.current.delete(source.id);
    });
  }
  async function updateEntryTags(source: CalendarEntry, ids: string[]) {
    if (isSecretEntry(source)) {
      localAction(() => {
        setTagEntry(setSecretEntryTags(source, ids));
      });
      return;
    }
    await action(async () => {
      try {
        const saved = await saveCalendarEntryTags(source, ids);
        upsert(saved);
        setTagEntry(saved);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const latest = await api<CalendarEntry>(
            `/calendar/entries/${source.id}`,
          );
          upsert(latest);
          setTagEntry(latest);
        }
        throw error;
      }
    });
  }
  async function restoreEntry() {
    if (!deleted || undoBlocked || busy.current) return;
    const restoring = deleted;
    if (isSecretEntry(restoring.entry)) {
      localAction(async () => {
        await markSecretDocumentDeleted(
          user.id,
          restoring.entry.teamId,
          restoring.entry.id,
          false,
        );
        saveSecretEntry(user.id, restoring.entry, true);
        setDeleted(null);
        onNotify(`‘${restoring.entry.title}’ 일정을 되살렸습니다.`);
      });
      return;
    }
    await action(async () => {
      const saved = await send<CalendarEntryUpdate>(
        `/calendar/entries/${restoring.entry.id}/restore`,
        {
          deletionId: restoring.deletionId,
          previousRange: {
            date: restoring.entry.date,
            endDate: restoring.entry.endDate,
          },
        },
      );
      if (!alive.current || restoring.entry.teamId !== team.id) return;
      upsert(saved);
      setDeleted(null);
      onNotify(`‘${saved.title}’ 일정을 되살렸습니다.`);
    });
  }
  function updateWeekly(ownerId: string, start: string, weekly: WeeklyItem[]) {
    // A monthly view reads a member in several ranges; only the range holding
    // the week keeps its list.
    updateData((previous, query) =>
      query.userId !== ownerId || start < query.from || start > query.to
        ? previous
        : {
            ...previous,
            weekly: [
              ...previous.weekly.filter((item) => item.weekStart !== start),
              ...weekly,
            ],
          },
    );
  }
  async function importWeek(ownerId: string, start: string) {
    const requestScope = scope;
    await action(async () => {
      // The week's list shows the loader until the import settles.
      setImporting({ userId: ownerId, weekStart: start });
      const result = await send<WeeklyAddResult & { unassigned: number }>(
        "/calendar/import",
        {
          teamId: team.id,
          userId: ownerId,
          weekStart: start,
        },
      ).finally(() => {
        if (alive.current) setImporting(null);
      });
      if (!alive.current || activeScope.current !== requestScope) return;
      updateWeekly(ownerId, start, result.weekly);
      setDeleted(null);
      setRemovedWeekly(null);
      onNotify(
        `${members?.find((m) => m.id === ownerId)?.name} · ${weekLabel(start)}: ${result.added}개 가져옴, 기존 ${result.existing}개 유지${result.unassigned ? ` · 미지정 ${result.unassigned}개 제외` : ""}`,
      );
    });
  }
  async function removeWeekly(item: WeeklyItem) {
    if (!writable(item.userId)) return;
    const requestScope = scope;
    await action(async () => {
      const result = await send<WeeklyRemoveResult>(
        "/calendar/weekly",
        {
          teamId: team.id,
          userId: item.userId,
          weekStart: item.weekStart,
          taskId: item.taskId,
        },
        "DELETE",
      );
      if (!alive.current || activeScope.current !== requestScope) return;
      updateWeekly(item.userId, item.weekStart, result.weekly);
      setDeleted(null);
      setRemovedWeekly({ item, teamId: team.id });
      onNotify("");
    });
  }
  async function reorderWeekly(
    ownerId: string,
    start: string,
    items: WeeklyItem[],
    taskIds: string[],
  ) {
    if (!writable(ownerId) || busy.current) return;
    const requestScope = scope;
    const byId = new Map(items.map((item) => [item.taskId, item]));
    updateWeekly(
      ownerId,
      start,
      taskIds.map((id) => byId.get(id)!),
    );
    await action(async () => {
      try {
        const result = await send<{ weekly: WeeklyItem[] }>(
          "/calendar/weekly/reorder",
          { teamId: team.id, userId: ownerId, weekStart: start, taskIds },
        );
        if (!alive.current || activeScope.current !== requestScope) return;
        updateWeekly(ownerId, start, result.weekly);
      } catch (error) {
        if (alive.current && activeScope.current === requestScope)
          updateWeekly(ownerId, start, items);
        throw error;
      }
    });
  }
  async function restoreWeekly() {
    if (!removedWeekly || undoBlocked || busy.current) return;
    const restoring = removedWeekly;
    await action(async () => {
      const { item } = restoring;
      const result = await send<WeeklyRestoreResult>(
        "/calendar/weekly/restore",
        {
          teamId: restoring.teamId,
          userId: item.userId,
          weekStart: item.weekStart,
          taskId: item.taskId,
          importedAt: item.importedAt,
        },
      );
      if (!alive.current || restoring.teamId !== team.id) return;
      updateWeekly(item.userId, item.weekStart, result.weekly);
      setRemovedWeekly(null);
      onNotify(
        `‘${item.title || "제목 없는 업무"}’ 업무를 주간 할 일에 되살렸습니다.`,
      );
    });
  }
  async function saveRange(
    change: { entry: CalendarEntry; range: CalendarRange; lane?: number },
    expected?: CalendarRange & { lane?: number },
  ) {
    if (isSecretEntry(change.entry)) {
      if (busy.current) return;
      localAction(() =>
        moveSecretEntry(
          change.entry as SecretCalendarEntry,
          schedules.get(change.entry.userId)?.data?.layout || [],
          change.range,
          change.lane,
        ),
      );
      return;
    }
    const reordering = change.lane !== undefined;
    if (
      busy.current ||
      !writable(change.entry.userId) ||
      (reordering
        ? change.lane === change.entry.lane
        : change.entry.date === change.range.date &&
          change.entry.endDate === change.range.endDate)
    )
      return;
    if (reordering && expected)
      change = {
        ...change,
        entry: { ...change.entry, ...expected },
        range: { date: expected.date, endDate: expected.endDate },
      };
    setRangeChange(change);
    await action(async () => {
      try {
        const previous = expected || change.entry;
        const saved = await send<CalendarEntryUpdate>(
          `/calendar/entries/${change.entry.id}`,
          {
            ...(reordering
              ? {
                  lane: change.lane,
                  expectedLane: previous.lane ?? change.entry.lane,
                }
              : change.range),
            expectedDate: previous.date,
            expectedEndDate: previous.endDate,
          },
          "PATCH",
        );
        if (!alive.current || activeScope.current !== scope) return;
        upsert(saved);
        setRangeChange(null);
        setRangeConflict(null);
      } catch (e) {
        if (alive.current && e instanceof ApiError && e.details?.currentRange)
          setRangeConflict(e.details.currentRange as CalendarRange);
        throw e;
      }
    });
  }
  async function openTask(id: string) {
    const requestScope = scope;
    await action(async () => {
      const result = await api<{ task: Task }>(`/calendar/tasks/${id}`);
      if (alive.current && activeScope.current === requestScope)
        setTask(result.task);
    });
  }
  async function checkTag(
    item: CalendarEntry,
    tagId: string,
    checked: boolean,
  ) {
    if (isSecretEntry(item)) {
      localAction(() => {
        setSecretTagChecked(item, tagId, checked);
      });
      return;
    }
    if (locked || !writable(item.userId)) return;
    const requestScope = scope;
    const apply = (change: {
      tagId: string;
      checked: boolean;
      updatedAt: string;
    }) => {
      if (!alive.current || activeScope.current !== requestScope) return;
      updateData((previous, query) =>
        query.userId !== item.userId
          ? previous
          : {
              ...previous,
              entries: previous.entries.map((value) =>
                value.id === item.id
                  ? applyCalendarTagCheck(value, change)
                  : value,
              ),
            },
      );
    };
    await action(async () => {
      apply({ tagId, checked, updatedAt: item.updatedAt });
      try {
        apply(await saveCalendarTagCheck(item, tagId, checked));
      } catch (error) {
        apply({
          tagId,
          checked: item.checkedTagIds.includes(tagId),
          updatedAt: item.updatedAt,
        });
        throw error;
      }
    });
  }
  function checkEntryTag(
    tagEntry: CalendarEntry,
    tagId: string,
    checked: boolean,
  ) {
    if (isSecretEntry(tagEntry)) {
      const source = tagEntry;
      localAction(() => {
        setTagEntry(setSecretTagChecked(source, tagId, checked));
      });
      return;
    }
    void action(async () => {
      setTagEntry(
        applyCalendarTagCheck(tagEntry, {
          tagId,
          checked,
          updatedAt: tagEntry.updatedAt,
        }),
      );
      try {
        const change = await saveCalendarTagCheck(tagEntry, tagId, checked);
        const saved = applyCalendarTagCheck(tagEntry, change);
        upsert(saved);
        setTagEntry(saved);
      } catch (error) {
        setTagEntry(tagEntry);
        throw error;
      }
    });
  }
  return {
    deleted,
    removedWeekly,
    importing,
    removeSecret,
    checkEntryTag,
    upsert,
    changeTags,
    entryDeleted,
    duplicateEntry,
    removeEntry,
    updateEntryTags,
    restoreEntry,
    updateWeekly,
    importWeek,
    removeWeekly,
    reorderWeekly,
    restoreWeekly,
    saveRange,
    openTask,
    checkTag,
  };
}
