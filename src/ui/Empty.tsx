import type { ReactNode } from "react";
import { Grae } from "./Brand";

export function Empty({
  title,
  description,
  action,
  illustration = <Grae />,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  illustration?: ReactNode;
}) {
  return (
    <div className="empty">
      {illustration}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
