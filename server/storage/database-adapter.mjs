// Transaction callbacks are engine-specific: SQLite callbacks must finish
// synchronously; PostgreSQL callbacks may await only this transaction's DB work.
// Network, Git, image conversion and R2 operations belong outside either one.
// This contract currently covers synchronization state and transaction boundaries.
// Ordinary commands use the *BusinessService contracts and engine repositories
// in this directory; business-storage.mjs supplies a complete PG selection for
// createApp. Those repositories retain each engine's domain transaction model.
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
