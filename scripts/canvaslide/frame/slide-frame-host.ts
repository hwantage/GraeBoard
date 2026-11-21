/**
 * The frame's side of the GraeBoard channel: who the parent is, which editing
 * session this frame belongs to, and request/response over postMessage.
 *
 * Opened on its own (no parent, or no session parameter) the editor is the
 * unmodified upstream web editor: every adapter falls back to upstream.
 */
import {
  isSlideFrameMessage,
  isSlideRecoveryScope,
  SLIDE_FRAME_SCOPE_PARAM,
  SLIDE_FRAME_SESSION_PARAM,
  slideFrameMessage,
} from "@graeboard/shared/slides/slide-frame-protocol.js";

const params = new URLSearchParams(window.location.search);
const session = params.get(SLIDE_FRAME_SESSION_PARAM);
const scope = params.get(SLIDE_FRAME_SCOPE_PARAM);
const parent = window.parent !== window ? window.parent : null;

export const hosted = parent !== null && session !== null && session !== "";

/** Suffix that keeps recovery copies of one account and team apart from every other. */
export const recoveryScopeSuffix = isSlideRecoveryScope(scope)
  ? `.${scope}`
  : ".standalone";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
const pending = new Map<string, Pending>();
type Handler = (payload: Record<string, unknown>) => unknown;
const handlers = new Map<string, Handler>();
let sequence = 0;

/** An error the parent already showed the author; the editor must not show it again. */
export class HostShownError extends Error {}

function post(
  kind: string,
  body: Record<string, unknown>,
  transfer: Transferable[] = [],
): void {
  parent?.postMessage(
    slideFrameMessage(session, kind, body),
    window.location.origin,
    transfer,
  );
}

/** Asks the parent to do something only it can: call the GraeBoard API or ask the author. */
export function requestHost<T>(
  action: string,
  payload: Record<string, unknown> = {},
  transfer: Transferable[] = [],
): Promise<T> {
  if (!hosted) {
    return Promise.reject(new Error("GraeBoard host is not available"));
  }
  const id = `${Date.now().toString(36)}-${++sequence}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    post("request", { id, action, payload }, transfer);
  });
}

export function handleHost(action: string, handler: Handler): void {
  handlers.set(action, handler);
}

export function notifyHost(
  kind: string,
  body: Record<string, unknown> = {},
): void {
  if (hosted) {
    post(kind, body);
  }
}

if (hosted) {
  window.addEventListener("message", (event) => {
    if (
      !isSlideFrameMessage(event, {
        source: parent,
        origin: window.location.origin,
        session,
      })
    ) {
      return;
    }
    const data = event.data as {
      kind: string;
      id?: string;
      action?: string;
      ok?: boolean;
      result?: unknown;
      error?: string;
      shown?: boolean;
      payload?: Record<string, unknown>;
    };
    if (data.kind === "response" && data.id) {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) {
        waiting?.resolve(data.result);
      } else {
        const message = data.error ?? "GraeBoard request failed";
        waiting?.reject(
          data.shown ? new HostShownError(message) : new Error(message),
        );
      }
      return;
    }
    if (data.kind === "request" && data.id && data.action) {
      const id = data.id;
      const handler = handlers.get(data.action);
      void Promise.resolve()
        .then(() => {
          if (!handler) {
            throw new Error(`Unknown frame action: ${data.action}`);
          }
          return handler(data.payload ?? {});
        })
        .then(
          (result) => post("response", { id, ok: true, result }),
          (error: unknown) =>
            post("response", {
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
    }
  });
}
