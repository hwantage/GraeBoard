export type ResourceProfile = {
  profileId: string;
  name?: string;
  teamId: string;
  repository?: string;
  database?: string | { provider?: string; binding?: string };
  images?: string | { provider?: string; binding?: string };
  ready?: boolean;
  replaces?: string;
};
export type ConnectionCheck = {
  ready: boolean;
  checks: {
    name: string;
    status: "ok" | "error" | "pending";
    message: string;
  }[];
};
