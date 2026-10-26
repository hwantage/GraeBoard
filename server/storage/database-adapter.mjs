// Transaction callbacks are engine-specific: SQLite callbacks must finish
// synchronously; PostgreSQL callbacks may await only this transaction's DB work.
// Network, Git, image conversion and R2 operations belong outside either one.
// This contract currently covers synchronization state and transaction boundaries.
// Ordinary Node domain storage remains SQLite-specific; Worker domain storage
// uses PostgreSQL site_entities. This is not a swappable business-store contract.
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
