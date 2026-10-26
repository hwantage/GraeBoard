import type { TeamRole } from "./types";

// 시스템 권한과 팀 내 권한의 표시 이름. 설정 화면 여러 곳에서 함께 쓴다.
export const systemRoleNames = {
  admin: "시스템 관리자",
  user: "일반 사용자",
} as const;
export const teamRoleNames: Record<TeamRole, string> = {
  lead: "팀장",
  member: "팀원",
  viewer: "열람자",
};
export const teamRoleOrder: TeamRole[] = ["lead", "member", "viewer"];
export const teamRoleHelp: Record<TeamRole, string> = {
  lead: "팀 설정·구성원 관리, 모든 업무 편집",
  member: "모든 업무·문서·꼬리 메모 편집",
  viewer: "조회·내보내기만 가능",
};
