import { useRef, useState } from "react";
import {
  MAX_SLIDE_TITLE_LENGTH,
  slideTitleProblem,
} from "../../shared/slides/slide-file-rules.js";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export default function SlideTitleDialog({
  heading,
  action,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  heading: string;
  action: string;
  initial: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [title, setTitle] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const problem = slideTitleProblem(title);
  return (
    <Modal title={heading} onClose={onClose} initialFocus={input}>
      <form
        className="slide-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem && !busy) onSubmit(title.trim());
        }}
      >
        <label>
          <span>자료 이름</span>
          <input
            ref={input}
            value={title}
            maxLength={MAX_SLIDE_TITLE_LENGTH}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <Button onClick={onClose}>취소</Button>
          <Button
            className="primary"
            type="submit"
            disabled={!!problem || busy}
          >
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
