import {
  isSlideFrameMessage,
  slideFrameMessage,
} from "../../shared/slides/slide-frame-protocol.js";

export type SlideBinding = {
  teamId: string;
  fileId: string | null;
  revision: number;
  title: string;
};
export type SlideEditorState = {
  dirty: boolean;
  binding: SlideBinding | null;
  name: string;
  documentSession: number;
};
type Handler = (payload: any) => unknown;

// An error the screen already showed; the editor must not show it again.
export class SlideShownError extends Error {}

// The parent's side of the editor frame channel: only messages from this
// frame's window, this origin and this editing session are accepted.
export class SlideFrameBridge {
  #pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  #sequence = 0;
  #disposed = false;
  constructor(
    private frame: () => Window | null,
    private session: string,
    private handlers: Record<string, Handler>,
    private events: {
      ready: (state: SlideEditorState) => void;
      state: (state: SlideEditorState) => void;
    },
  ) {
    window.addEventListener("message", this.#receive);
  }
  dispose() {
    this.#disposed = true;
    window.removeEventListener("message", this.#receive);
    for (const waiting of this.#pending.values())
      waiting.reject(new Error("편집기를 닫았습니다."));
    this.#pending.clear();
  }
  request<T>(action: string, payload: object = {}, timeoutMs = 0): Promise<T> {
    const target = this.frame();
    if (!target || this.#disposed)
      return Promise.reject(new Error("편집기가 준비되지 않았습니다."));
    const id = `host-${++this.#sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error("편집기가 응답하지 않습니다."));
          }, timeoutMs)
        : null;
      this.#pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      target.postMessage(
        slideFrameMessage(this.session, "request", { id, action, payload }),
        location.origin,
      );
    });
  }
  #post(body: object) {
    this.frame()?.postMessage(
      slideFrameMessage(this.session, "response", body),
      location.origin,
    );
  }
  #receive = (event: MessageEvent) => {
    if (
      this.#disposed ||
      !isSlideFrameMessage(event, {
        source: this.frame(),
        origin: location.origin,
        session: this.session,
      })
    )
      return;
    const data = event.data;
    if (data.kind === "ready") this.events.ready(data);
    else if (data.kind === "state") this.events.state(data);
    else if (data.kind === "response") {
      const waiting = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if (data.ok) waiting?.resolve(data.result);
      else
        waiting?.reject(new Error(data.error || "편집기 요청에 실패했습니다."));
    } else if (data.kind === "request") {
      const handler = this.handlers[data.action];
      void Promise.resolve()
        .then(() => {
          if (!handler) throw new Error("unavailable");
          return handler(data.payload ?? {});
        })
        .then(
          (result) => this.#post({ id: data.id, ok: true, result }),
          (error: unknown) =>
            this.#post({
              id: data.id,
              ok: false,
              error: (error as Error).message,
              shown: error instanceof SlideShownError,
            }),
        );
    }
  };
}
