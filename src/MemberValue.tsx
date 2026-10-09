import type { Cell, Property, User } from "./types";
import { Avatar } from "./components";

export default function MemberValue({
  property,
  value,
  users,
}: {
  property: Property;
  value: Cell["value"];
  users: User[];
}) {
  const ids = Array.isArray(value) ? value : value ? [String(value)] : [];
  return (
    <span className="member-values">
      {ids.map((id, i) => {
        const user = users.find((u) => u.id === id);
        return (
          <span className="person-cell" key={id}>
            {property.display === "avatar" && user && (
              <Avatar user={user} small />
            )}
            {i > 0 && property.display === "text" ? ", " : ""}
            {user?.name || id}
          </span>
        );
      })}
    </span>
  );
}
