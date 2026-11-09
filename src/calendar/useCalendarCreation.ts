import { useState } from "react";

import { send } from "../platform/api";

import { saveSecretEntry } from "./secret-calendar";

import { useCalendarData } from "./useCalendarData";

import type { Team, User } from "../types";
import type {
  CalendarEntry,
  CalendarEntryUpdate,
  CalendarTag,
} from "./calendar-types";
import type useCalendarMutation from "./useCalendarMutation";
export default function useCalendarCreation({
  user,
  team,
  tagMap,
  schedules,
  mutation,
  writable,
  locked,
  composingTitle,
  upsert,
  setError,
}: {
  user: User;
  team: Team;
  tagMap: Map<string, CalendarTag>;
  schedules: ReturnType<typeof useCalendarData>["schedules"];
  mutation: ReturnType<typeof useCalendarMutation>;
  writable: (ownerId: string | null) => boolean;
  locked: boolean;
  composingTitle: React.RefObject<boolean>;
  upsert: (entry: CalendarEntryUpdate) => void;
  setError: (message: string) => void;
}) {
  const { action, localAction, alive, pending } = mutation;
  const [creating, setCreating] = useState<{
    secret: boolean;
    id: string;
    date: string;
    userId: string | null;
    title: string;
    tagIds: string[];
    checkedTagIds: string[];
  } | null>(null);
  const draftKey = creating
    ? `weekly-plan:calendar-create:${user.id}:${team.id}:${creating.userId}:${creating.date}`
    : "";
  function newEntry(date: string, ownerId: string | null) {
    const key = `weekly-plan:calendar-create:${user.id}:${team.id}:${ownerId}:${date}`;
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      /* optional draft */
    }
    const tagIds: string[] = Array.isArray(saved?.tagIds)
      ? saved.tagIds.filter((id: string) => tagMap.get(id)?.userId === ownerId)
      : [];
    setCreating({
      secret:
        ownerId === user.id && (saved?.secret === true || !writable(ownerId)),
      id: typeof saved?.id === "string" ? saved.id : crypto.randomUUID(),
      date,
      userId: ownerId,
      title: typeof saved?.title === "string" ? saved.title : "",
      tagIds,
      checkedTagIds: Array.isArray(saved?.checkedTagIds)
        ? saved.checkedTagIds.filter(
            (id: string) =>
              tagIds.includes(id) && tagMap.get(id)?.kind === "check",
          )
        : [],
    });
  }
  function changeCreating(next: NonNullable<typeof creating>) {
    setCreating(next);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError("새 일정을 임시 보관할 수 없습니다. 저장 후 닫아 주세요.");
    }
  }
  function saveCreating() {
    if (!creating || locked || !creating.title.trim() || composingTitle.current)
      return;
    if (creating.secret) {
      if (creating.userId !== user.id) return;
      localAction(() => {
        saveSecretEntry(
          user.id,
          {
            id: `secret:${creating.id}`,
            teamId: team.id,
            title: creating.title,
            date: creating.date,
            endDate: creating.date,
            lane: 0,
            tagIds: creating.tagIds,
            checkedTagIds: creating.checkedTagIds,
          },
          true,
          schedules.get(user.id)?.data?.layout || [],
        );
        try {
          sessionStorage.removeItem(draftKey);
        } catch {
          /* Saved locally. */
        }
        setCreating(null);
      });
      return;
    }
    if (!writable(creating.userId)) return;
    void action(async () => {
      const { secret: _secret, ...input } = creating;
      const saved = await send<CalendarEntry>("/calendar/entries", {
        ...input,
        teamId: team.id,
      });
      if (!alive.current) return;
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        /* The server save succeeded. */
      }
      upsert(saved);
      setCreating(null);
    });
  }
  function closeCreating() {
    if (pending || !creating) return;
    if (creating.title || creating.tagIds.length) {
      try {
        sessionStorage.setItem(draftKey, JSON.stringify(creating));
      } catch {
        setError(
          "제목을 임시 보관할 수 없습니다. 제목을 복사하거나 저장 후 닫아 주세요.",
        );
        return;
      }
    }
    setCreating(null);
  }
  return {
    creating,
    setCreating,
    newEntry,
    changeCreating,
    saveCreating,
    closeCreating,
  };
}
