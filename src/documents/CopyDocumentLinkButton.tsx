import { useState } from "react";
import { Link } from "lucide-react";
import { Button } from "../ui/Button";
import Toast, { useToast } from "../ui/Toast";
import { copyDocumentLink, type DocumentLinkTarget } from "./document-links";

// Copies a link to this detail or memo for other documents
// (document-links.ts). It sits left of the full-page button.
export default function CopyDocumentLinkButton({
  target,
  title,
}: {
  target: DocumentLinkTarget;
  title: string;
}) {
  const [message, setMessage] = useToast();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        tooltip="링크 복사"
        className="document-link-copy"
        onClick={async () => {
          try {
            await copyDocumentLink(target, title.trim() || "제목 없음");
            setFailed(false);
            setMessage("링크를 복사했습니다.");
          } catch {
            setFailed(true);
            setMessage("링크를 복사하지 못했습니다. 다시 시도해 주세요.");
          }
        }}
      >
        <Link size={16} aria-hidden="true" />
      </Button>
      <Toast message={message} failed={failed} />
    </>
  );
}
