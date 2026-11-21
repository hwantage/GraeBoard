// The upstream modules GraeBoard replaces stay reachable under these names, so
// an adapter can delegate to the original implementation.
declare module "graeboard-upstream:document-file-access" {
  export * from "@/platform/document-file-access";
}
declare module "graeboard-upstream:cloud-share" {
  export * from "@/platform/cloud-share";
}
declare module "@graeboard/shared/slides/slide-frame-protocol.js" {
  export const SLIDE_FRAME_CHANNEL: string;
  export const SLIDE_FRAME_SCOPE_PARAM: string;
  export const SLIDE_FRAME_SESSION_PARAM: string;
  export function slideFrameMessage(
    session: string | null,
    kind: string,
    body?: Record<string, unknown>,
  ): Record<string, unknown>;
  export function isSlideFrameMessage(
    event: MessageEvent,
    expected: { source: unknown; origin: string; session: string | null },
  ): boolean;
  export function isSlideRecoveryScope(value: unknown): value is string;
}
