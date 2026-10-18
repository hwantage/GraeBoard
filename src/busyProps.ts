// Temporary locks keep the control's normal appearance. Permanent disabled
// states remain visibly disabled; both use the native interaction guard.
export function busyProps(busy: boolean, disabled = false) {
  return {
    disabled: disabled || busy,
    "data-busy": (busy && !disabled) || undefined,
  };
}
