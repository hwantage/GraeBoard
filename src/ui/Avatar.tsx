import type { User } from "../types";
import { inkFor } from "./color";

export function Avatar({
  user,
  small = false,
}: {
  user?: Partial<User>;
  small?: boolean;
}) {
  const backgroundColor = user?.color || "#65818f";
  const initials = user?.avatarInitials || user?.name?.slice(0, 1) || "?";
  const color = inkFor(backgroundColor);
  return (
    <span
      className={`avatar ${small ? "small" : ""} ${initials.length === 3 ? "long-initials" : ""}`}
      style={{ backgroundColor, color }}
    >
      {user?.avatarImage ? <img src={user.avatarImage} alt="" /> : initials}
    </span>
  );
}
