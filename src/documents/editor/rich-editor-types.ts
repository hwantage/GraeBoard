import type { ReactNode } from "react";
import type { DocumentImages } from "../document-storage";
export type RemoteMarkdown = { markdown: string; sequence: number };
// Lets the host show a merged remote version at once, before a key typed while
// React renders could be merged away. Before the editor is ready the
// remoteMarkdown prop applies it instead.
export type RichEditorHandle = {
  applyRemote: (remote: RemoteMarkdown) => void;
  // Where the caret and the text on screen are, for the Markdown source.
  place: (markdown: string) => DocumentPlace | null;
};
// A place in the document as Markdown offsets: the selection, and the text
// kept at the same viewport height (`top`, px) when the mode switches.
export type DocumentPlace = {
  anchor: number;
  head: number;
  view: { offset: number; top: number };
};
export type RichEditorProps = {
  label?: string;
  images?: DocumentImages;
  documentLinks?: boolean;
  linkTitles?: boolean;
  initialMarkdown: string;
  // Read once when the editor opens, as initialMarkdown.
  initialPlace?: DocumentPlace | null;
  remoteMarkdown?: RemoteMarkdown;
  readOnly: boolean;
  saveStatus?: ReactNode;
  modeControl?: ReactNode;
  // The table of contents beside the text; its button is the host's.
  toc?: boolean;
  onTocClose?: () => void;
  onChange: (markdown: string) => void;
  onUnsupported: (message: string) => void;
  onReady: () => void;
  onUpload?: (file: File, signal: AbortSignal) => Promise<string>;
  onUploading?: (count: number) => void;
};
