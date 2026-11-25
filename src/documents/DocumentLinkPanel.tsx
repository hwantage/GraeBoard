import { useRef, useState, type CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import { api, ApiError, send } from "../platform/api";
import { Button } from "../ui/Button";
import { RowPanel, StandaloneRowPanel } from "../Panels";
import CalendarEntryPanel from "../calendar/CalendarEntryPanel";
import CalendarTagManager from "../calendar/CalendarTags";
import DocumentEditor, { type DocumentHandle } from "./DocumentEditor";
import type { DocumentPanelHandle } from "./DocumentPanel";
import AnnualMemoPanel from "./AnnualMemoPanel";
import { canContribute, canManageTeam } from "../../shared/domain.js";
import { documentLinkPath } from "../../shared/documents/document-links.js";
import {
  UNAVAILABLE_LINK_MESSAGE,
  useOpenDocumentLink,
  type DocumentLinkTarget,
} from "./document-links";
import type {
  CalendarContext,
  CalendarEntry,
} from "../calendar/calendar-types";
import type { SheetClone, Settings, Task, TaskDocument, User } from "../types";

type MemoLink = Extract<
  DocumentLinkTarget,
  { kind: "memo" | "sheet-clone-memo" }
>;
type SheetCloneTaskLink = Extract<
  DocumentLinkTarget,
  { kind: "sheet-clone-task" }
>;
export type OpenedDocumentLink =
  | { kind: "task"; task: Task; context: CalendarContext }
  | { kind: "calendar"; entry: CalendarEntry; context: CalendarContext }
  | { kind: "memo"; target: MemoLink; teamId: string; title: string }
  | {
      kind: "sheet-clone-task";
      target: SheetCloneTaskLink;
      sheetClone: SheetClone;
      task: Task;
      settings: Settings;
    };

// The target's team and current title, from the title lookup.
async function findDocumentLink(target: DocumentLinkTarget) {
  const path = documentLinkPath(target);
  const { links } = await api<{
    links: { path: string; teamId: string; title: string }[];
  }>(`/document-links?${new URLSearchParams({ links: path })}`);
  const found = links.find((link) => link.path === path);
  if (!found) throw new Error(UNAVAILABLE_LINK_MESSAGE);
  return found;
}

// Reads what a link opens with the routes its own screen uses: the calendar's
// task and entry reads with the team's settings and members, a memo through
// its document route, a copy's task from the copy. Missing or forbidden
// targets share one message. A slide opens in the slides screen instead of a
// window (App.tsx).
export async function loadDocumentLink(
  target: Exclude<DocumentLinkTarget, { kind: "slide" }>,
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
    if (target.kind === "calendar") {
      const entry = await api<CalendarEntry>(`/calendar/entries/${target.id}`);
      const context = await api<CalendarContext>(
        `/calendar/teams/${entry.teamId}`,
      );
      return { kind: "calendar", entry, context };
    }
    const { teamId, title } = await findDocumentLink(target);
    if (target.kind !== "sheet-clone-task")
      return { kind: "memo", target, teamId, title };
    const sheetClone = await api<SheetClone>(
      `/sheet-clones/${target.sheetCloneId}`,
    );
    const task = sheetClone.tasks.find((item) => item.id === target.id);
    if (!task) throw new Error(UNAVAILABLE_LINK_MESSAGE);
    const settings =
      sheetClone.settings ||
      (await api<CalendarContext>(`/calendar/teams/${teamId}`)).settings;
    return { kind: "sheet-clone-task", target, sheetClone, task, settings };
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status))
      throw new Error(UNAVAILABLE_LINK_MESSAGE);
    throw error;
  }
}

// A linked target opens over the current screen with the window of its own
// screen, so the linking document stays open below; closing returns to it.
// `fullPage` opens a detail in full page, as a full-page button's new tab
// asks; a memo always opens in full page.
export default function DocumentLinkPanel({
  link,
  user,
  readOnly,
  fullPage,
  documentId,
  calendarTheme,
  onClose,
  onDeleted,
  onOpenSheetClone,
}: {
  link: OpenedDocumentLink;
  user: User;
  readOnly: boolean;
  fullPage?: boolean;
  documentId?: string;
  calendarTheme: { theme: string; palette: string; style?: CSSProperties };
  onClose: () => void;
  onDeleted: (entry: CalendarEntry) => void;
  onOpenSheetClone: (target: SheetCloneTaskLink) => void;
}) {
  if (link.kind === "task")
    return (
      <StandaloneRowPanel
        task={link.task}
        settings={link.context.settings}
        user={user}
        users={link.context.members}
        readOnly={readOnly}
        initialFullPage={fullPage}
        initialDocumentId={documentId}
        onClose={onClose}
      />
    );
  if (link.kind === "calendar")
    return (
      <CalendarLinkPanel
        entry={link.entry}
        context={link.context}
        user={user}
        readOnly={readOnly}
        fullPage={fullPage}
        calendarTheme={calendarTheme}
        onClose={onClose}
        onDeleted={onDeleted}
      />
    );
  if (link.kind === "memo")
    return (
      <MemoLinkPanel
        target={link.target}
        teamId={link.teamId}
        title={link.title}
        user={user}
        readOnly={readOnly || !canContribute(user, link.teamId)}
        onClose={onClose}
      />
    );
  // A copy's cells are edited in its open sheet, against its draft and
  // revision; here they are shown only. Its documents save on their own.
  return (
    <RowPanel
      task={link.task}
      settings={link.settings}
      user={user}
      users={link.sheetClone.users}
      readOnly={readOnly}
      propertiesReadOnly
      sheetCloneMode
      documentSheetClone={{ id: link.sheetClone.id, isNew: false }}
      initialFullPage={fullPage}
      initialDocumentId={documentId}
      headerAction={
        <div
          className="task-detail-actions"
          role="group"
          aria-label="업무 동작"
        >
          <Button
            tooltip="사본에서 열기"
            onClick={() => onOpenSheetClone(link.target)}
          >
            <ExternalLink size={16} aria-hidden="true" />
            <span className="task-detail-action-label">사본에서 열기</span>
          </Button>
        </div>
      }
      onClose={onClose}
      onDocumentSaved={() => {}}
      onSaveProperty={() =>
        Promise.reject(new Error("사본의 속성은 사본에서 수정하세요."))
      }
    />
  );
}

function CalendarLinkPanel({
  entry,
  context,
  user,
  readOnly,
  fullPage,
  calendarTheme,
  onClose,
  onDeleted,
}: {
  entry: CalendarEntry;
  context: CalendarContext;
  user: User;
  readOnly: boolean;
  fullPage?: boolean;
  calendarTheme: { theme: string; palette: string; style?: CSSProperties };
  onClose: () => void;
  onDeleted: (entry: CalendarEntry) => void;
}) {
  const [tags, setTags] = useState(context.tags);
  const [managingTags, setManagingTags] = useState(false);
  const owner = entry.userId,
    // Calendar.tsx: shared entries for every member, personal entries for
    // their owner and the team lead.
    writable =
      canManageTeam(user, entry.teamId) ||
      (owner === null
        ? user.teamIds.includes(entry.teamId)
        : owner === user.id && canContribute(user, entry.teamId)),
    ownTags = tags.filter((tag) => tag.userId === owner);
  // The entry window needs the calendar screen's scope and theme, as when it
  // opens there: `.workspace[data-screen=calendar]` sets the palette and
  // `.calendar-workspace` the window's own rules. The scope adds no box.
  return (
    <div
      className="workspace calendar-workspace"
      data-screen="calendar"
      data-calendar-theme={calendarTheme.theme}
      data-calendar-palette={calendarTheme.palette}
      style={{ ...calendarTheme.style, display: "contents" }}
    >
      <CalendarEntryPanel
        entry={entry}
        tags={ownTags}
        onManageTags={() => setManagingTags(true)}
        userId={user.id}
        readOnly={readOnly || !writable}
        initialFullPage={fullPage}
        onSaved={() => {}}
        onClose={onClose}
        onDeleted={(removed) => onDeleted(removed)}
      />
      {managingTags && (
        <CalendarTagManager
          teamId={entry.teamId}
          userId={owner}
          ownerName={
            context.members.find((member) => member.id === owner)?.name ||
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
    </div>
  );
}

// The linked memo's list shares tab selection, drafts and the save path.
// DocumentPanel alone reports the selected document's browser title.
function MemoLinkPanel({
  target,
  teamId,
  title,
  user,
  readOnly,
  onClose,
}: {
  target: MemoLink;
  teamId: string;
  title: string;
  user: User;
  readOnly: boolean;
  onClose: () => void;
}) {
  const panel = useRef<DocumentPanelHandle>(null);
  const [selected, setSelected] = useState(target.id);
  const close = async () => {
    if (panel.current && !(await panel.current.flush())) return false;
    onClose();
    return true;
  };
  useOpenDocumentLink({ ...target, id: selected }, close, {
    accepts: (next) =>
      target.kind === "memo"
        ? next.kind === "memo" &&
          next.teamId === target.teamId &&
          next.year === target.year
        : next.kind === "sheet-clone-memo" &&
          next.sheetCloneId === target.sheetCloneId,
    select: (next) =>
      panel.current?.selectDocument(next.id) ?? Promise.resolve(false),
  });
  return (
    <AnnualMemoPanel
      ref={panel}
      teamId={teamId}
      year={target.kind === "memo" ? target.year : 0}
      sheetCloneId={
        target.kind === "sheet-clone-memo" ? target.sheetCloneId : undefined
      }
      userId={user.id}
      readOnly={readOnly}
      initialDocumentId={target.id}
      onDocumentSelected={setSelected}
      browserTitleFallback={title}
      onClose={onClose}
    />
  );
}
