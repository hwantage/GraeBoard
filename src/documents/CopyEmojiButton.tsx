import { useState } from "react";
import EmojiPicker from "../ui/EmojiPicker";
import Toast, { useToast } from "../ui/Toast";
import { copyToClipboard } from "./document-links";

// The emoji button just left of the close button in task and calendar entry
// details. A picked emoji is copied for pasting into the title or document.
export default function CopyEmojiButton() {
  const [message, setMessage] = useToast();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <EmojiPicker
        label="이모지 복사"
        className="emoji-copy"
        onPick={(emoji) => {
          copyToClipboard(emoji).then(
            () => {
              setFailed(false);
              setMessage(`${emoji} 이모지를 복사했습니다.`);
            },
            () => {
              setFailed(true);
              setMessage("이모지를 복사하지 못했습니다. 다시 시도해 주세요.");
            },
          );
        }}
      />
      <Toast message={message} failed={failed} />
    </>
  );
}
