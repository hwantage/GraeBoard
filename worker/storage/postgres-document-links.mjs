import { DEFAULT_DOCUMENT_TITLE } from "../../shared/documents/task-documents.js";
import { parseDocumentLinkPath } from "../../shared/documents/document-links.js";
import { excludedYears } from "../task-view.mjs";

// Titles of stored documents by key, read in SQL so their bodies are not
// loaded.
async function documentTitles(s, keys) {
  if (!keys.length) return [];
  const titles = new Map(
    (
      await s.tx.query(
        "SELECT entity_key,payload::jsonb->>'title' AS title FROM site_entities WHERE team_id=$1 AND entity='document' AND deleted=0 AND entity_key=ANY($2::text[])",
        [s.teamId, keys.map((key) => JSON.stringify(key))],
      )
    ).rows.map((row) => [row.entity_key, row.title || DEFAULT_DOCUMENT_TITLE]),
  );
  return keys.map((key) => titles.get(JSON.stringify(key)) ?? null);
}

// Same targets as SQLite's resolveSqliteDocumentLinks, as the external
// routes open them. Each readable team is read once for all links; copy rows
// are read in SQL, without decoding whole copies in this runtime.
export async function resolvePostgresDocumentLinks(ctx, paths) {
  const wanted = paths.map((path) => ({
    path,
    link: parseDocumentLinkPath(path),
  }));
  const links = [];
  if (!wanted.length) return { links };
  const of = (...kinds) =>
    wanted.filter(({ link }) => kinds.includes(link.kind));
  for (const team of await ctx.teams()) {
    if (team.status !== "active") continue;
    const found = await ctx.data(team.id, async (s) => {
      const result = [],
        add = (path, title) => result.push({ path, teamId: team.id, title }),
        live = (row) => row && !row.deleted && !row.payload.deletedAt,
        tasks = of("task"),
        entries = of("calendar"),
        memos = of("memo").filter(({ link }) => link.teamId === team.id),
        copies = of("sheet-clone-task", "sheet-clone-memo"),
        excluded =
          tasks.length || memos.length ? await excludedYears(s) : new Set();
      if (tasks.length) {
        const rows = await s.getMany(
            "task",
            tasks.map(({ link }) => [link.id]),
          ),
          titles = await s.getMany(
            "cell",
            tasks.map(({ link }) => [link.id, "title"]),
          );
        rows.forEach((row, index) => {
          const years = row?.payload.years || [];
          if (
            live(row) &&
            !(years.length && years.every((year) => excluded.has(year)))
          )
            add(
              tasks[index].path,
              String(
                (!titles[index]?.deleted && titles[index]?.payload.value) || "",
              ),
            );
        });
      }
      if (entries.length) {
        const rows = await s.getMany(
            "calendar",
            entries.map(({ link }) => [link.id]),
          ),
          owners = [
            ...new Set(
              rows
                .filter(live)
                .map((row) => row.payload.userId)
                .filter(Boolean),
            ),
          ],
          active = new Set(
            owners.length
              ? (
                  await ctx.controlStore.members(team.id, { activeOnly: true })
                ).map((user) => user.id)
              : [],
          ),
          people = new Set(
            (
              await s.getMany(
                "person",
                owners.filter((id) => !active.has(id)).map((id) => [id]),
              )
            )
              .filter(Boolean)
              .map((row) => row.key[0]),
          );
        rows.forEach((row, index) => {
          if (
            live(row) &&
            (row.payload.userId === null ||
              active.has(row.payload.userId) ||
              people.has(row.payload.userId))
          )
            add(entries[index].path, row.payload.title);
        });
      }
      const visibleMemos = memos.filter(({ link }) => !excluded.has(link.year));
      (
        await documentTitles(
          s,
          visibleMemos.map(({ link }) => [
            "annual",
            String(link.year),
            link.id,
          ]),
        )
      ).forEach((title, index) => {
        if (title !== null) add(visibleMemos[index].path, title);
      });
      if (copies.length) {
        const present = new Set(
          (
            await s.tx.query(
              "SELECT entity_key FROM site_entities WHERE team_id=$1 AND entity='sheetClone' AND deleted=0 AND entity_key=ANY($2::text[])",
              [
                s.teamId,
                [...new Set(copies.map(({ link }) => link.sheetCloneId))].map(
                  (id) => JSON.stringify([id]),
                ),
              ],
            )
          ).rows.map((row) => JSON.parse(row.entity_key)[0]),
        );
        const rows = copies.filter(
            ({ link }) =>
              link.kind === "sheet-clone-task" &&
              present.has(link.sheetCloneId),
          ),
          copyMemos = copies.filter(
            ({ link }) =>
              link.kind === "sheet-clone-memo" &&
              present.has(link.sheetCloneId),
          );
        if (rows.length) {
          // A copy's data is stored plain or as the shared dictionary form
          // whose `$data` keeps the rows and their cell values.
          const titles = new Map(
            (
              await s.tx.query(
                `SELECT r.entity_key::jsonb->>0 AS sheet_clone_id,t->>'id' AS id,t->'cells'->'title'->>'value' AS title
                FROM site_entities r
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload::jsonb#>'{data,$data,tasks}',r.payload::jsonb#>'{data,tasks}')) t
                WHERE r.team_id=$1 AND r.entity='sheetClone' AND r.deleted=0 AND r.entity_key=ANY($2::text[]) AND t->>'id'=ANY($3::text[])`,
                [
                  s.teamId,
                  [...new Set(rows.map(({ link }) => link.sheetCloneId))].map(
                    (id) => JSON.stringify([id]),
                  ),
                  [...new Set(rows.map(({ link }) => link.id))],
                ],
              )
            ).rows.map((row) => [
              `${row.sheet_clone_id}/${row.id}`,
              row.title ?? "",
            ]),
          );
          for (const { path, link } of rows) {
            const title = titles.get(`${link.sheetCloneId}/${link.id}`);
            if (title !== undefined) add(path, title);
          }
        }
        (
          await documentTitles(
            s,
            copyMemos.map(({ link }) => [
              "sheetCloneMemo",
              link.sheetCloneId,
              link.id,
            ]),
          )
        ).forEach((title, index) => {
          if (title !== null) add(copyMemos[index].path, title);
        });
      }
      return result;
    });
    links.push(...found);
  }
  return { links };
}
