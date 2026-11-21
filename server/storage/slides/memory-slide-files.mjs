// Process-memory slide file repository. It implements the same contract a
// durable repository must: content kept by revision, a save that only
// replaces the revision it was based on, and repeated request IDs returning
// the first result. Files do not survive a restart, which `durable` reports to
// the screen; no persistent format is defined here.
export class MemorySlideFileRepository {
  durable = false;
  #files = new Map();
  #requests = new Map();
  #shares = new Map();

  #meta(file) {
    const { bytes, ...meta } = file;
    return { ...meta };
  }
  #live(teamId, fileId) {
    const file = this.#files.get(fileId);
    return file && file.teamId === teamId && !file.deletedAt ? file : null;
  }
  list(teamId) {
    return [...this.#files.values()]
      .filter((file) => file.teamId === teamId && !file.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((file) => this.#meta(file));
  }
  get(teamId, fileId) {
    const file = this.#live(teamId, fileId);
    return file ? this.#meta(file) : null;
  }
  read(teamId, fileId) {
    const file = this.#live(teamId, fileId);
    return file ? { file: this.#meta(file), bytes: file.bytes } : null;
  }
  create({ id, teamId, title, bytes, contentHash, requestId, userId, at }) {
    const key = `create:${teamId}:${requestId}`;
    const earlier = this.#requests.get(key);
    if (earlier) return earlier;
    const file = {
      id,
      teamId,
      title,
      revision: 1,
      byteLength: bytes.byteLength,
      contentHash,
      createdBy: userId,
      createdAt: at,
      updatedBy: userId,
      updatedAt: at,
      bytes: Uint8Array.from(bytes),
    };
    this.#files.set(id, file);
    const meta = this.#meta(file);
    this.#requests.set(key, meta);
    return meta;
  }
  replace({
    teamId,
    fileId,
    baseRevision,
    bytes,
    contentHash,
    requestId,
    userId,
    at,
  }) {
    const file = this.#live(teamId, fileId);
    if (!file) return null;
    const key = `save:${fileId}:${requestId}`;
    const earlier = this.#requests.get(key);
    if (earlier) return { saved: true, file: earlier };
    if (file.revision !== baseRevision)
      return { saved: false, file: this.#meta(file) };
    Object.assign(file, {
      revision: file.revision + 1,
      byteLength: bytes.byteLength,
      contentHash,
      updatedBy: userId,
      updatedAt: at,
      bytes: Uint8Array.from(bytes),
    });
    const meta = this.#meta(file);
    this.#requests.set(key, meta);
    return { saved: true, file: meta };
  }
  rename({ teamId, fileId, title, userId, at }) {
    const file = this.#live(teamId, fileId);
    if (!file) return null;
    Object.assign(file, { title, updatedBy: userId, updatedAt: at });
    return this.#meta(file);
  }
  remove({ teamId, fileId, at }) {
    const file = this.#live(teamId, fileId);
    if (file) file.deletedAt = at;
  }
  removeTeam(teamId) {
    for (const [id, file] of this.#files)
      if (file.teamId === teamId) this.#files.delete(id);
    for (const [id, share] of this.#shares)
      if (share.teamId === teamId) this.#shares.delete(id);
  }
  createShare(share) {
    for (const [id, old] of this.#shares)
      if (old.expiresAt <= share.createdAt) this.#shares.delete(id);
    this.#shares.set(share.id, share);
  }
  readShare(teamId, id, now) {
    const share = this.#shares.get(id);
    return share && share.teamId === teamId && share.expiresAt > now
      ? share
      : null;
  }
}
