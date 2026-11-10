import type { ReactNode } from "react";
import { Grae } from "./Brand";

export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Grae className="empty-grae" />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
