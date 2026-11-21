// Messages between the GraeBoard slides screen (parent) and the CanvaSlide
// editor frame. Both sides are GraeBoard code; the upstream editor never sees
// this channel. Runs in the browser only.
export const SLIDE_FRAME_CHANNEL = "graeboard.slides.frame.v1";

// Frame URL parameters set by the parent before the editor starts.
export const SLIDE_FRAME_SCOPE_PARAM = "gb-scope";
export const SLIDE_FRAME_SESSION_PARAM = "gb-session";

// Requests the frame sends to the parent.
export const SLIDE_HOST_ACTIONS = Object.freeze([
  "save",
  "create",
  "save-target",
  "share-create",
  "share-read",
]);

// Requests the parent sends to the frame.
export const SLIDE_FRAME_ACTIONS = Object.freeze([
  "open",
  "new",
  "save",
  "state",
  "discard",
]);

export function slideFrameMessage(session, kind, body = {}) {
  return { channel: SLIDE_FRAME_CHANNEL, session, kind, ...body };
}

// A message is accepted only from the expected window, the same origin, this
// channel and this editing session.
export function isSlideFrameMessage(event, { source, origin, session }) {
  const data = event.data;
  return (
    event.source === source &&
    event.origin === origin &&
    Boolean(data) &&
    typeof data === "object" &&
    data.channel === SLIDE_FRAME_CHANNEL &&
    data.session === session &&
    typeof data.kind === "string"
  );
}

// Recovery copies are kept per account and team, so the scope must be a short
// storage-safe token.
export function slideRecoveryScope(parts) {
  return parts
    .map((part) => String(part).replace(/[^A-Za-z0-9_-]/g, "_"))
    .join(".");
}
export function isSlideRecoveryScope(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(value);
}
