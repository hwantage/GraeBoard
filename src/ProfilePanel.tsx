import { useRef, useState } from "react";
import { api, isTeamSite } from "./api";
import AvatarEditor from "./AvatarEditor";
import { Button, ErrorNote, Modal } from "./components";
import type { User } from "./types";

export default function ProfilePanel({
  user,
  onClose,
  onSaved,
}: {
  user: User;
  onClose: () => void;
  onSaved: (user: User) => void;
}) {
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
          if (saving || loadingImage) return;
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
              readOnly={isTeamSite()}
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
          <AvatarEditor
            user={profile}
            onChange={(patch) =>
              setProfile((current) => ({ ...current, ...patch }))
            }
            onLoading={setLoadingImage}
          />
        </fieldset>
        <ErrorNote error={error} />
        <footer className="form-actions">
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
        </footer>
      </form>
    </Modal>
  );
}
