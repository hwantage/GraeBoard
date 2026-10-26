import { digest } from "../server/sync/protocol.mjs";
import { project } from "../server/sync/reducer.mjs";
import { isExcluded as excluded } from "../server/sync/retention.mjs";
import { imageReferences, stillImage } from "./images.mjs";
import { assert } from "./access.mjs";
export function imageSync(database, profile, r2) {
  return {
    async publish(state) {
      const result = {};
      for (const url of imageReferences(state, profile.teamId)) {
        const bytes = await r2.read(url);
        if (bytes) result[r2.key(url)] = bytes;
      }
      return result;
    },
    async receive(state, head, transport) {
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
        active = new Set();
      for (const e of Object.values(projection.entities))
        if (
          !e.deleted &&
          !excluded(e, projection.entities, snapshot.exclusions)
        )
          for (const url of imageReferences(e.payload, profile.teamId))
            active.add(url);
      for (const url of imageReferences(
        {
          pending: snapshot.pending,
          conflicts: Object.values(state.conflicts).filter(
            (c) => !c.resolution,
          ),
        },
        profile.teamId,
      ))
        active.add(url);
      for (const url of imageReferences(state, profile.teamId)) {
        const bytes = await transport.readFile(head, r2.key(url));
        assert(
          bytes &&
            digest(bytes) === r2.key(url).split("/").at(-1).slice(0, -5) &&
            stillImage(bytes) === "image/webp",
          502,
          "Git 이미지가 누락되었거나 손상되었습니다.",
        );
        if (active.has(url) && !(await r2.has(url)))
          await r2.install(url, bytes);
      }
      for (const url of active)
        if (!(await r2.has(url))) {
          const bytes = await transport.readFile(head, r2.key(url));
          assert(bytes, 502, "활성 문서 이미지가 없습니다.");
          await r2.install(url, bytes);
        }
    },
  };
}
