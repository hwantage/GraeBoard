import type { ReactNode, RefObject } from "react";
import type { DocumentImages } from "../document-storage";
export type RemoteMarkdown = { markdown: string; sequence: number };
export type RichEditorProps = {
  label?: string;
  images?: DocumentImages;
  documentLinks?: boolean;
  linkTitles?: boolean;
  initialMarkdown: string;
  remoteMarkdown?: RemoteMarkdown;
  // Filled by the ready editor so the host shows a merged remote version at
  // once, before a key typed while React renders could be merged away.
  remoteApply?: RefObject<((remote: RemoteMarkdown) => void) | null>;
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
