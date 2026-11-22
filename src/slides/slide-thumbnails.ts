import { api } from "../platform/api";
import { readSlideFile, type SlideFile } from "./slide-file-api";

// Owned by one account/team workspace. Only a visible card joins the queue.
// The last save/import already supplied the bytes, so it need not download them.
export class SlideThumbnails {
  private queue: Promise<unknown> = Promise.resolve();
  private images = new Map<string, string>();
  private source?: { hash: string; bytes: Uint8Array<ArrayBuffer> };

  constructor(private editorPath: string) {}

  remember(file: SlideFile, bytes: Uint8Array<ArrayBuffer>) {
    this.source = { hash: file.contentHash, bytes };
  }

  load(file: SlideFile, canWrite: boolean, signal: AbortSignal) {
    const work = this.queue.then(() => this.read(file, canWrite, signal));
    this.queue = work.catch(() => {});
    return work;
  }

  private async read(file: SlideFile, canWrite: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    const hash = file.contentHash;
    const cached = this.images.get(hash);
    if (cached !== undefined) return cached;
    const url = `/teams/${file.teamId}/slides/${file.id}/thumbnail`;
    const remote = await api<{ hash: string; image: string | null }>(url, {
      signal,
    });
    if (remote.hash !== hash) return "";
    let image = remote.image;
    if (image === null) {
      const source =
        this.source?.hash === hash
          ? this.source
          : await readSlideFile(file.teamId, file.id, signal);
      if (source.hash !== hash) return "";
      const moduleUrl = this.editorPath + "thumbnail.js";
      const renderer: {
        renderThumbnail(bytes: Uint8Array): Promise<string | null>;
      } = await import(/* @vite-ignore */ moduleUrl);
      signal.throwIfAborted();
      image = (await renderer.renderThumbnail(source.bytes)) ?? "";
      signal.throwIfAborted();
      if (canWrite)
        await api(url, {
          method: "PUT",
          body: JSON.stringify({ hash, image }),
          signal,
        }).catch(() => {});
    }
    signal.throwIfAborted();
    if (this.source?.hash === hash) this.source = undefined;
    this.images.set(hash, image);
    if (this.images.size > 96)
      this.images.delete(this.images.keys().next().value!);
    return image;
  }
}
