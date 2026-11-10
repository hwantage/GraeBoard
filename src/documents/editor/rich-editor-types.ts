import type { ReactNode } from "react";
import type { DocumentImages } from "../document-storage";
export type RichEditorProps = {
  label?: string;
  images?: DocumentImages;
  documentLinks?: boolean;
  linkTitles?: boolean;
  initialMarkdown: string;
  remoteMarkdown?: { markdown: string; sequence: number };
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
