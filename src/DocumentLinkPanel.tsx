import { useId, useRef, useState, type CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import { api, ApiError, send } from "./api";
import { Button } from "./components";
import { RowPanel, StandaloneRowPanel } from "./Panels";
import CalendarEntryPanel from "./CalendarEntryPanel";
import CalendarTagManager from "./CalendarTags";
import DocumentEditor, { type DocumentHandle } from "./DocumentEditor";
import { DocumentPage } from "./DocumentPanel";
import DocumentLoading from "./DocumentLoading";
import { canContribute, canManageTeam } from "../shared/domain.js";
import { documentLinkPath } from "../shared/document-links.js";
import {
  UNAVAILABLE_LINK_MESSAGE,
  useOpenDocumentLink,
  type DocumentLinkTarget,
} from "./document-links";
import type { CalendarContext, CalendarEntry } from "./calendar-types";
import type { Report, Settings, Task, TaskDocument, User } from "./types";

type MemoLink = Extract<DocumentLinkTarget, { kind: "memo" | "report-memo" }>;
type CopyTaskLink = Extract<DocumentLinkTarget, { kind: "report-task" }>;
export type OpenedDocumentLink =
  | { kind: "task"; task: Task; context: CalendarContext }
  | { kind: "calendar"; entry: CalendarEntry; context: CalendarContext }
  | { kind: "memo"; target: MemoLink; teamId: string; title: string }
  | {
      kind: "report-task";
      target: CopyTaskLink;
      report: Report;
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
// targets share one message.
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
    if (target.kind === "calendar") {
      const entry = await api<CalendarEntry>(`/calendar/entries/${target.id}`);
      const context = await api<CalendarContext>(
        `/calendar/teams/${entry.teamId}`,
      );
      return { kind: "calendar", entry, context };
    }
    const { teamId, title } = await findDocumentLink(target);
    if (target.kind !== "report-task")
      return { kind: "memo", target, teamId, title };
    const report = await api<Report>(`/reports/${target.reportId}`);
    const task = report.tasks.find((item) => item.id === target.id);
    if (!task) throw new Error(UNAVAILABLE_LINK_MESSAGE);
    const settings =
      report.settings ||
      (await api<CalendarContext>(`/calendar/teams/${teamId}`)).settings;
    return { kind: "report-task", target, report, task, settings };
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
  calendarTheme,
  onClose,
  onDeleted,
  onOpenCopy,
}: {
  link: OpenedDocumentLink;
  user: User;
  readOnly: boolean;
  fullPage?: boolean;
  calendarTheme: { theme: string; palette: string; style?: CSSProperties };
  onClose: () => void;
  onDeleted: (entry: CalendarEntry) => void;
  onOpenCopy: (target: CopyTaskLink) => void;
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
      users={link.report.users}
      readOnly={readOnly}
      propertiesReadOnly
      reportMode
      documentReport={{ id: link.report.id, isNew: false }}
      initialFullPage={fullPage}
      headerAction={
        <div
          className="task-detail-actions"
          role="group"
          aria-label="업무 동작"
        >
          <Button
            tooltip="사본에서 열기"
            onClick={() => onOpenCopy(link.target)}
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

// One memo in the full page of the tail memo cards, with the card's editor,
// draft and document route. Closing saves first.
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
  const id = useId();
  const editor = useRef<DocumentHandle>(null);
  const [loading, setLoading] = useState(true);
  const collection =
    target.kind === "memo"
      ? `/teams/${target.teamId}/years/${target.year}/memos`
      : `/reports/${target.reportId}/memos`;
  const path = `${collection}/${target.id}`;
  // AnnualMemoPanel's key, so a draft is shared with the memo card.
  const draftKey = `weekly-plan:memo:${user.id}:${teamId}:${target.kind === "memo" ? target.year : target.reportId}:${target.id}`;
  const close = async () => {
    if (editor.current && !(await editor.current.flush())) return false;
    onClose();
    return true;
  };
  useOpenDocumentLink(target, close);
  // The memo cards' full-page rules are scoped to `.annual-memos`.
  return (
    <div className="annual-memos" style={{ display: "contents" }}>
      <DocumentPage
        pageId={`${id}-page`}
        tabId={`${id}-tab`}
        documentId={target.id}
        title={title}
        widthKey={`${draftKey}:width`}
        link={target}
        onNewTab={() => editor.current?.flush() ?? Promise.resolve(true)}
        inline
        selected
        loading={loading}
        controlsTarget={null}
        onSelect={() => {}}
        onClose={() => void close()}
      >
        {(controls) => (
          <>
            {loading && <DocumentLoading />}
            <DocumentEditor
              ref={editor}
              path={path}
              draftKey={draftKey}
              label="연간 업무 메모"
              readOnly={readOnly}
              controlsTarget={controls}
              saveDocument={(input) => send<TaskDocument>(path, input, "PUT")}
              onLoadingChange={setLoading}
            />
          </>
        )}
      </DocumentPage>
    </div>
  );
}
