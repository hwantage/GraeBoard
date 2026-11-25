import { useSite } from "../platform/site-context";
import { useRef, useState } from "react";
import { api } from "../platform/api";
import AvatarEditor from "./AvatarEditor";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import { Modal } from "../ui/Modal";
import type { User } from "../types";

export default function ProfilePanel({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: (user: User) => void;
}) {
  const site = useSite();
  // A team site takes the name and avatar from the intranet account.
  const linked = site.accountLinking;
  const [profile, setProfile] = useState({
    name: user.name,
    color: user.color,
    avatarInitials: user.avatarInitials || "",
    avatarImage: user.avatarImage || "",
  });
  const [saving, setSaving] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  return (
    <Modal
      title="프로필"
      onClose={() => {
        if (!saving) onClose();
      }}
      initialFocus={nameInput}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (linked || saving || loadingImage) return;
          setSaving(true);
          setError("");
          try {
            const result = await api<{ user: User }>("/auth/profile", {
              method: "PATCH",
              body: JSON.stringify(profile),
            });
            onSaved(result.user);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <fieldset className="profile-fields" disabled={saving}>
          <label>
            이름
            <input
              ref={nameInput}
              value={profile.name}
              readOnly={linked}
              required
              maxLength={50}
              autoComplete="name"
              onChange={(event) =>
                setProfile((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label>
            아이디(이메일)
            <input value={user.username} readOnly autoComplete="username" />
          </label>
          {linked ? (
            <fieldset className="avatar-editor">
              <legend>프로필 아바타</legend>
              <div className="avatar-preview" aria-label="아바타 미리보기">
                <Avatar user={user} />
              </div>
            </fieldset>
          ) : (
            <AvatarEditor
              user={profile}
              onChange={(patch) =>
                setProfile((current) => ({ ...current, ...patch }))
              }
              onLoading={setLoadingImage}
            />
          )}
        </fieldset>
        {linked && (
          <p className="field-help">
            이름과 아바타는 사내 계정에서 변경합니다. 사내에서 바꾸면 1~2분 뒤
            이곳에도 반영됩니다.
          </p>
        )}
        <ErrorNote error={error} />
        <footer className="form-actions">
          {linked ? (
            <Button onClick={onClose}>닫기</Button>
          ) : (
            <>
              <Button onClick={onClose} disabled={saving}>
                취소
              </Button>
              <Button
                type="submit"
                className="primary"
                disabled={saving || loadingImage}
              >
                {saving
                  ? "저장 중…"
                  : loadingImage
                    ? "이미지 준비 중…"
                    : "프로필 저장"}
              </Button>
            </>
          )}
        </footer>
      </form>
    </Modal>
  );
}
