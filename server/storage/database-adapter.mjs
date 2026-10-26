// Transaction callbacks are engine-specific: SQLite callbacks must finish
// synchronously; PostgreSQL callbacks may await only this transaction's DB work.
// Network, Git, image conversion and R2 operations belong outside either one.
export class DatabaseAdapter {
  withTeamTransaction() {
    throw new Error("DatabaseAdapter.withTeamTransaction must be implemented");
  }
  readSnapshot() {
    throw new Error("DatabaseAdapter.readSnapshot must be implemented");
  }
  health() {
    throw new Error("DatabaseAdapter.health must be implemented");
  }
}

export class StorageRouter {
  constructor(controlStore, resolveProfile) {
    this.controlStore = controlStore;
    this.resolveProfile = resolveProfile;
  }
  async team(teamId, user) {
    const access = await this.controlStore.teamAccess(user, teamId);
    if (!access)
      throw Object.assign(new Error("Team access denied"), { status: 403 });
    const profile = await this.controlStore.profileForTeam(teamId);
    if (!profile || profile.teamId !== teamId)
      throw new Error("Team profile is unavailable");
    const adapter = await this.resolveProfile(profile);
    return { adapter, profile, access };
  }
}
