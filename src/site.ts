import type { SiteIdentity } from "../shared/session-contract";

export type Site = Readonly<{
  name: "internal" | "external";
  external: boolean;
  accountLinking: boolean;
}>;

const internal: Site = Object.freeze({
  name: "internal",
  external: false,
  accountLinking: false,
});
const external: Site = Object.freeze({
  name: "external",
  external: true,
  accountLinking: false,
});
const team: Site = Object.freeze({ ...external, accountLinking: true });

export function siteFor(data: SiteIdentity | null | undefined): Site {
  // The host role wins over authentication compatibility fields.
  if (
    data?.site === "external" ||
    (data?.site !== "internal" && data?.authMode === "access")
  )
    return data.accountLinking ? team : external;
  return internal;
}
