import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { X, CircleHelp } from "lucide-react";
import { Button } from "./Button";

export function Modal({
  title,
  help,
  titleAction,
  titleContent,
  headerActions,
  children,
  onClose,
  onOutsideClick,
  wide = false,
  className = "",
  initialFocus,
}: {
  title: string;
  help?: string;
  titleAction?: ReactNode;
  titleContent?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onOutsideClick?: () => void;
  wide?: boolean;
  className?: string;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const titleId = useId();
  const hasHelp = !!help;
  const hasHeaderActions = !!headerActions || !!titleAction || !!titleContent;
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const target =
      initialFocus?.current ||
      (hasHelp || hasHeaderActions ? closeButton.current : null);
    // autofocus가 없으면 showModal()이 첫 입력칸(긴 제목 등)에 포커스해 글자
    // 끝으로 스크롤해 둔다. 처음부터 포커스할 대상에 포커스하게 한다.
    target?.setAttribute("autofocus", "");
    ref.current?.showModal();
    target?.removeAttribute("autofocus");
    target?.focus({
      preventScroll: true,
    });
    const el = ref.current;
    return () => {
      el?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus, hasHelp, hasHeaderActions]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && backdropPress.current)
          (onOutsideClick || onClose)();
        backdropPress.current = false;
      }}
      onPointerDownCapture={(e) => {
        backdropPress.current = e.target === ref.current && e.button === 0;
      }}
      onPointerUpCapture={(e) => {
        backdropPress.current =
          backdropPress.current && e.target === ref.current;
      }}
      onPointerCancel={() => {
        backdropPress.current = false;
      }}
    >
      <header>
        <div className="modal-heading">
          <h2 id={titleId} hidden={!!titleContent}>
            {title}
          </h2>
          {titleContent}
          {titleAction}
          {help && (
            <button
              type="button"
              className="modal-help"
              aria-label={`${title} 도움말`}
              data-tooltip={help}
            >
              <CircleHelp size={17} aria-hidden="true" />
            </button>
          )}
        </div>
        {headerActions}
        <Button ref={closeButton} title="닫기" onClick={onClose}>
          <X size={18} />
        </Button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
