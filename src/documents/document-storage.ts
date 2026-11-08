import type { TaskDocument } from "../types";
import type { DocumentWrite } from "./DocumentEditor";

export type DocumentImages = {
  accepts: (url: string) => boolean;
  source: (url: string) => string | Promise<string>;
  width: (url: string) => number | null;
  withWidth: (url: string, width: number | null) => string;
};
export type DocumentStorage = {
  load: () => Promise<TaskDocument>;
  save: (input: DocumentWrite) => Promise<TaskDocument>;
  subscribe: (
    receive: (document: TaskDocument) => void,
    onError: (error: Error) => void,
  ) => () => void;
  uploadImage: (file: File, signal: AbortSignal) => Promise<string>;
  images: DocumentImages;
};
export class DocumentStorageConflict extends Error {
  constructor(public current: TaskDocument) {
    super("다른 탭에서 문서가 변경되었습니다. 입력은 보존됩니다.");
  }
}
