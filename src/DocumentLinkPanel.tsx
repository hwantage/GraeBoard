import { useState } from "react";
import { api, ApiError } from "./api";
import { StandaloneRowPanel } from "./Panels";
import CalendarEntryPanel from "./CalendarEntryPanel";
import CalendarTagManager from "./CalendarTags";
import { canContribute, canManageTeam } from "../shared/domain.js";
import {
  UNAVAILABLE_LINK_MESSAGE,
  type DocumentLinkTarget,
} from "./document-links";
import type { CalendarContext, CalendarEntry } from "./calendar-types";
import type { Task, User } from "./types";

export type OpenedDocumentLink =
  | { kind: "task"; task: Task; context: CalendarContext }
  | { kind: "calendar"; entry: CalendarEntry; context: CalendarContext };

// The same reads the calendar uses to open a task of any year or an entry,
// with the target team's settings and members. Missing or forbidden targets
// share one message.
export async function loadDocumentLink(
  target: DocumentLinkTarget,
): Promise<OpenedDocumentLink> {
  try {
    if (target.kind === "task") {
      const { task } = await api<{ task: Task }>(
        `/calendar/tasks/${target.id}`,
      );
      if (task.deletedAt) throw new Error(UNAVAILABLE_LINK_MESSAGE);
      const context = await api<CalendarContext>(
        `/calendar/teams/${task.teamId}`,
      );
      return { kind: "task", task, context };
    }
    const entry = await api<CalendarEntry>(`/calendar/entries/${target.id}`);
    const context = await api<CalendarContext>(
      `/calendar/teams/${entry.teamId}`,
    );
    return { kind: "calendar", entry, context };
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status))
      throw new Error(UNAVAILABLE_LINK_MESSAGE);
    throw error;
  }
}

// A linked task or calendar entry opens over the current screen with the
// detail window of its own screen, so the linking document stays open below.
export default function DocumentLinkPanel({
  link,
  user,
  readOnly,
  onClose,
  onDeleted,
}: {
  link: OpenedDocumentLink;
  user: User;
  readOnly: boolean;
  onClose: () => void;
  onDeleted: (entry: CalendarEntry) => void;
}) {
  const [tags, setTags] = useState(link.context.tags);
  const [managingTags, setManagingTags] = useState(false);
  if (link.kind === "task")
    return (
      <StandaloneRowPanel
        task={link.task}
        settings={link.context.settings}
        user={user}
        users={link.context.members}
        readOnly={readOnly}
        onClose={onClose}
      />
    );
  const { entry } = link,
    owner = entry.userId,
    // Calendar.tsx: shared entries for every member, personal entries for
    // their owner and the team lead.
    writable =
      canManageTeam(user, entry.teamId) ||
      (owner === null
        ? user.teamIds.includes(entry.teamId)
        : owner === user.id && canContribute(user, entry.teamId)),
    ownTags = tags.filter((tag) => tag.userId === owner);
  return (
    <>
      <CalendarEntryPanel
        entry={entry}
        tags={ownTags}
        onManageTags={() => setManagingTags(true)}
        userId={user.id}
        readOnly={readOnly || !writable}
        onSaved={() => {}}
        onClose={onClose}
        onDeleted={(removed) => onDeleted(removed)}
      />
      {managingTags && (
        <CalendarTagManager
          teamId={entry.teamId}
          userId={owner}
          ownerName={
            link.context.members.find((member) => member.id === owner)?.name ||
            "개인"
          }
          tags={ownTags}
          readOnly={readOnly || !writable}
          onChanged={(next) =>
            setTags((previous) => [
              ...previous.filter((tag) => tag.userId !== owner),
              ...next,
            ])
          }
          onClose={() => setManagingTags(false)}
        />
      )}
    </>
  );
}
