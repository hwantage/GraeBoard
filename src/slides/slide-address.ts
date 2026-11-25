// The slide address inside `/slides`: `file` opens a team file, `share` a
// temporary snapshot (with the `team` it belongs to).
export function readSlideAddress() {
  const params = new URLSearchParams(location.search);
  return {
    file: params.get("file"),
    share: params.get("share"),
    team: params.get("team"),
  };
}
export function writeSlideAddress(values: { file?: string } = {}) {
  const url = new URL(location.href);
  for (const key of ["file", "share", "team"]) url.searchParams.delete(key);
  if (values.file) url.searchParams.set("file", values.file);
  history.replaceState(history.state, "", url);
}
// The team of a share link in the address that is not `teamId`. Such a link
// stays in the address until the team changes, and is opened then.
export function slideShareOtherTeam(teamId: string) {
  const { team, share } = readSlideAddress();
  return team && team !== teamId && share ? team : null;
}
