import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, KeyRound, LogOut, UserRound } from "lucide-react";
import { Avatar, ErrorNote } from "./components";
import type { User } from "./types";

export default function AccountMenu({
  user,
  onProfile,
  onAccessTokens,
  onPassword,
  onLogout,
  logoutDisabled,
}: {
  user: User;
  onProfile: () => void;
  onAccessTokens: () => void;
  onPassword?: () => void;
  onLogout: () => Promise<void>;
  logoutDisabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  return (
    <div className="account-menu-anchor" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="button top-account"
        title="내 계정"
        aria-label="내 계정"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setError("");
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Avatar user={user} small />
        <span className="account-name">{user.name}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          className="account-menu"
          role="menu"
          aria-label="내 계정 메뉴"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === "Tab") close(true);
            else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const index = items.indexOf(event.target as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close(true);
              onProfile();
            }}
          >
            <UserRound size={16} aria-hidden="true" /> 프로필
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close(true);
              onAccessTokens();
            }}
          >
            <KeyRound size={16} aria-hidden="true" /> 접속 토큰
          </button>
          {onPassword && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close(true);
                onPassword();
              }}
            >
              <KeyRound size={16} aria-hidden="true" /> 비밀번호 변경
            </button>
          )}
          <div className="account-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={logoutDisabled || busy}
            title={
              logoutDisabled
                ? "저장 중이거나 실패한 입력을 처리한 뒤 로그아웃할 수 있습니다."
                : undefined
            }
            onClick={async () => {
              if (logoutDisabled || busy) return;
              setBusy(true);
              setError("");
              try {
                await onLogout();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <LogOut size={16} aria-hidden="true" />{" "}
            {busy ? "로그아웃 중…" : "로그아웃"}
          </button>
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}
