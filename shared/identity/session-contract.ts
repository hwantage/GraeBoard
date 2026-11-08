// Public setup/bootstrap response shapes shared by all browser entry points.
export type SiteIdentity = {
  site?: "internal" | "external";
  authMode?: "access" | "password";
  accountLinking?: boolean;
};

export type SetupStatus = SiteIdentity & {
  required: boolean;
  tokenRequired: boolean;
  email?: string;
  accounts?: {
    id: string;
    name: string;
    username: string;
    role: string;
    status: string;
  }[];
};

export type Bootstrap<User, Team> = SiteIdentity & {
  user: User;
  users: User[];
  teams: Team[];
  years: number[];
};
