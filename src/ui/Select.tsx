import type { ComponentPropsWithRef } from "react";

export default function Select({
  className = "",
  ...props
}: ComponentPropsWithRef<"select">) {
  return <select {...props} className={`select-control ${className}`.trim()} />;
}
