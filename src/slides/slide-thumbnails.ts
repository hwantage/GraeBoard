import { api } from "../platform/api";
import { readSlideFile, type SlideFile } from "./slide-file-api";

type PicturedFile = Pick<SlideFile, "teamId" | "id" | "contentHash">;

// Runs at most `limit` tasks at a time in arrival order. A task that ends,
// fails or finds its card gone hands its place to the next one.
function limiter(limit: number) {
  const waiting: (() => void)[] = [];
  let running = 0;
  return async <T>(task: () => Promise<T>) => {
    if (running < limit) running++;
    else await new Promise<void>((start) => waiting.push(start));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
// Both limits are the page's: work begun before the slides screen was left may
// still be running when it is shown again.
// A browser opens six connections to the internal HTTP/1.1 server. Four leave
// one for the event stream and one for what the person does next.
const asking = limiter(4);
// A missing picture costs a whole file (up to 25MB) and a main-thread render.
const making = limiter(1);

// The pictures one account has seen in this page, by team and content hash as
// on the server. They outlive the slides screen, so a list shown again asks the
// server only for cards it has no picture of. Signing out keeps the page on the
// internal site: another account starts with none of them, and a picture is
// only ever shown for a file the server has just listed for the account.
let held: { userId: string; images: Map<string, string> } | undefined;
function imagesOf(userId: string) {
  if (held?.userId !== userId) held = { userId, images: new Map() };
  return held.images;
}

// Owned by one visit of an account/team workspace. Only a visible card asks.
// The last save/import already supplied the bytes, so it need not download
// them; they are dropped with this visit at the latest.
export class SlideThumbnails {
  private turns = new Map<string, Promise<unknown>>();
  private images: Map<string, string>;
  private source?: { hash: string; bytes: Uint8Array<ArrayBuffer> };

  constructor(
    private editorPath: string,
    userId: string,
  ) {
    this.images = imagesOf(userId);
  }

  remember(file: SlideFile, bytes: Uint8Array<ArrayBuffer>) {
    this.source = { hash: file.contentHash, bytes };
  }

  // Cards with the same content take turns, so the first answer serves all.
  load(file: PicturedFile, canWrite: boolean, signal: AbortSignal) {
    const key = file.teamId + "/" + file.contentHash;
    const work = (this.turns.get(key) ?? Promise.resolve()).then(() =>
      this.read(file, key, canWrite, signal),
    );
    const turn: Promise<unknown> = work
      .catch(() => {})
      .finally(() => {
        if (this.turns.get(key) === turn) this.turns.delete(key);
      });
    this.turns.set(key, turn);
    return work;
  }

  private async read(
    file: PicturedFile,
    key: string,
    canWrite: boolean,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const hash = file.contentHash;
    let image = this.images.get(key);
    if (image === undefined) {
      const url = `/teams/${file.teamId}/slides/${file.id}/thumbnail`;
      const remote = await asking(() =>
        api<{ hash: string; image: string | null }>(url, { signal }),
      );
      if (remote.hash !== hash) return "";
      const made =
        remote.image ??
        (await making(() => this.draw(file, url, canWrite, signal)));
      if (made === null) return "";
      signal.throwIfAborted();
      image = made;
    }
    if (this.source?.hash === hash) this.source = undefined;
    // The picture used last is the last to go.
    this.images.delete(key);
    this.images.set(key, image);
    if (this.images.size > 96)
      this.images.delete(this.images.keys().next().value!);
    return image;
  }

  // Null when the file changed after the list was read.
  private async draw(
    file: PicturedFile,
    url: string,
    canWrite: boolean,
    signal: AbortSignal,
  ) {
    const hash = file.contentHash;
    const source =
      this.source?.hash === hash
        ? this.source
        : await readSlideFile(file.teamId, file.id, signal);
    if (source.hash !== hash) return null;
    const moduleUrl = this.editorPath + "thumbnail.js";
    const renderer: {
      renderThumbnail(bytes: Uint8Array): Promise<string | null>;
    } = await import(/* @vite-ignore */ moduleUrl);
    signal.throwIfAborted();
    const image = (await renderer.renderThumbnail(source.bytes)) ?? "";
    signal.throwIfAborted();
    if (canWrite)
      await api(url, {
        method: "PUT",
        body: JSON.stringify({ hash, image }),
        signal,
      }).catch(() => {});
    return image;
  }
}
