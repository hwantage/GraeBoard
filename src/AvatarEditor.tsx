import { useEffect, useRef, useState } from "react";
import type { User } from "./types";
import { Avatar } from "./components";

export default function AvatarEditor({
  user,
  onChange,
  onLoading,
}: {
  user: Partial<User>;
  onChange: (patch: Partial<User>) => void;
  onLoading: (loading: boolean) => void;
}) {
  const [mode, setMode] = useState(
    user.avatarImage ? "image" : user.avatarInitials ? "initials" : "name",
  );
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      onLoading(false);
    },
    [],
  );
  async function upload(file?: File) {
    if (!file) return;
    const current = ++request.current;
    setError("");
    onLoading(true);
    let bitmap: ImageBitmap | undefined;
    try {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error("5MB 이하의 PNG, JPEG, WebP 이미지를 선택하세요.");
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 160;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("이미지를 불러오지 못했습니다.");
      const size = Math.min(bitmap.width, bitmap.height);
      context.drawImage(
        bitmap,
        (bitmap.width - size) / 2,
        (bitmap.height - size) / 2,
        size,
        size,
        0,
        0,
        160,
        160,
      );
      const avatarImage = canvas.toDataURL("image/png");
      if (avatarImage.length > 150000)
        throw new Error("이미지가 너무 큽니다. 다른 이미지를 선택하세요.");
      if (request.current === current)
        onChange({ avatarImage, avatarInitials: "" });
    } catch (e) {
      if (request.current === current) setError((e as Error).message);
    } finally {
      bitmap?.close();
      if (request.current === current) onLoading(false);
    }
  }
  return (
    <fieldset className="avatar-editor">
      <legend>프로필 아바타</legend>
      <div className="avatar-editor-layout">
        <div className="avatar-preview" aria-label="아바타 미리보기">
          <Avatar user={user} />
        </div>
        <div className="avatar-controls">
          <div
            className="avatar-modes"
            role="radiogroup"
            aria-label="아바타 표시 방식"
          >
            {[
              ["name", "이름 첫 글자"],
              ["initials", "직접 입력"],
              ["image", "이미지"],
            ].map(([value, label]) => (
              <label className="checkbox" key={value}>
                <input
                  type="radio"
                  name="avatarMode"
                  value={value}
                  checked={mode === value}
                  onChange={() => {
                    request.current++;
                    onLoading(false);
                    setMode(value);
                    setError("");
                    onChange({ avatarImage: "", avatarInitials: "" });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {mode === "initials" && (
            <label>
              아바타 글자
              <input
                aria-label="아바타 글자"
                value={user.avatarInitials || ""}
                maxLength={3}
                required
                pattern="[a-zA-Z]{1,3}|[가-힣]{1,2}"
                placeholder="예: HJK 또는 민수"
                onChange={(e) =>
                  onChange({ avatarInitials: e.target.value, avatarImage: "" })
                }
              />
              <small className="field-help">영문 1~3자 또는 한글 1~2자</small>
            </label>
          )}
          {mode === "image" && (
            <label>
              아바타 이미지
              <input
                type="file"
                aria-label="아바타 이미지"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  void upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <small className="field-help">
                5MB 이하 · 이미지 중앙을 정사각형으로 맞춥니다.
              </small>
            </label>
          )}
          <label className="avatar-color">
            아바타 배경색
            <input
              type="color"
              aria-label="아바타 배경색"
              value={user.color || "#177b70"}
              onChange={(e) => onChange({ color: e.target.value })}
            />
          </label>
          {error && (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </fieldset>
  );
}
