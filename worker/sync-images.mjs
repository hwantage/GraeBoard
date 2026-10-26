import { digest } from "../server/sync/protocol.mjs";
import { project } from "../server/sync/reducer.mjs";
import { installImageReferences } from "../server/sync/retention.mjs";
import { imageReferences, stillImage } from "./images.mjs";
import { assert } from "./access.mjs";
export function imageSync(database, profile, r2) {
  return {
    async *publish(state, { parent = null, transport } = {}) {
      const inherited = new Set(
        parent
          ? (await transport.readCommit(parent)).files.map((file) => file.path)
          : [],
      );
      for (const url of imageReferences(state, profile.teamId)) {
        const key = r2.key(url);
        if (inherited.has(key)) continue;
        const bytes = await r2.read(url);
        assert(bytes, 502, "게시할 문서 이미지가 없습니다.");
        yield [key, bytes];
      }
    },
    async receive(state, head, transport, { verifiedImages = new Map() } = {}) {
      const snapshot = await database.withTeamTransaction(
        profile.teamId,
        async (tx) => {
          const connection = await tx.sync.readLink();
          return {
            connection,
            pending: await tx.sync.readPending(),
            exclusions: await tx.sync.readExclusions(
              connection?.installation_id,
            ),
          };
        },
        { readOnly: true },
      );
      const projection = project(state, snapshot.pending),
        active = installImageReferences(
          state,
          snapshot.pending,
          snapshot.exclusions,
          projection.entities,
          profile.teamId,
        );
      // The shared service verifies newly introduced immutable files once.
      // Existing R2 content-addressed objects need no repeated Git download.
      for (const url of active) {
        if (await r2.has(url)) continue;
        const key = r2.key(url),
          bytes =
            verifiedImages.get(key) || (await transport.readFile(head, key));
        assert(
          bytes &&
            digest(bytes) === key.split("/").at(-1).slice(0, -5) &&
            stillImage(bytes) === "image/webp",
          502,
          "활성 문서 이미지가 없거나 손상되었습니다.",
        );
        await r2.install(url, bytes);
      }
    },
  };
}
