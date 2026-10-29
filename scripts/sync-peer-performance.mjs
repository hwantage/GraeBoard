// Independent peer used only by the reproducible local performance harness.
// It creates a real immutable operation and Git commit against the fixed C head.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sqliteTeamStore } from "../server/storage/sqlite.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { operationBatch } from "../server/sync/service.mjs";
import { reduce } from "../server/sync/reducer.mjs";
import {
  canonical,
  entityId,
  stateHash,
  protocolVersion,
} from "../server/sync/protocol.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

try {
  const {
    databasePath,
    teamId,
    taskId,
    documentTaskId,
    documentId,
    documents = 1000,
    remote,
    directory,
  } = workerData;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("BEGIN");
  const store = sqliteTeamStore(db, teamId),
    state = store.readState(),
    link = store.readLink(),
    actorRef = db.prepare("SELECT id FROM users LIMIT 1").get().id;
  db.exec("COMMIT");
  db.close();
  const before = {},
    after = {},
    cellValue = "independent peer " + randomUUID(),
    documentValue = "Peer document marker " + randomUUID();
  const cellKey = entityId("cell", [taskId, "title"]);
  before[cellKey] = state.entities[cellKey];
  after[cellKey] = {
    ...before[cellKey],
    payload: { ...before[cellKey].payload, value: cellValue },
  };
  const documentKey = entityId("document", [
    "task",
    documentTaskId,
    documentId,
  ]);
  before[documentKey] = state.entities[documentKey];
  after[documentKey] = {
    ...before[documentKey],
    payload: { ...before[documentKey].payload, markdown: documentValue },
  };
  const changes = [[before, after]];
  for (let i = 0; i < documents; i++) {
    if (i % 50 === 0) changes.push([{}, {}]);
    const [before, after] = changes.at(-1);
    const key = ["task", documentTaskId, randomUUID()],
      id = entityId("document", key);
    before[id] = null;
    after[id] = {
      entity: "document",
      key,
      payload: {
        title: "Peer imported document " + i,
        position: i + 1,
        markdown: "대량 수신 문서 " + i + "\n" + "content ".repeat(2048),
      },
      deleted: false,
    };
  }
  const transport = new GitCliTransport({
    directory,
    repository: remote,
    allowLocal: true,
  });
  let head = await transport.readHead(),
    current = state,
    operationId;
  if (head !== link.canonical_head)
    throw new Error("Peer benchmark canonical head changed");
  // Each group of 50 documents is one immutable command. Bounded batches use the same
  // production envelope selector as regular synchronization publication.
  const operations = changes.map(([before, after]) =>
    makeOperation({
      link: { ...link, writer_epoch: randomUUID() },
      actorRef,
      before,
      after,
    }),
  );
  while (operations.length) {
    const batch = operationBatch(operations);
    for (const operation of batch) {
      const reduced = reduce(current, operation);
      if (reduced.receipt.result !== "applied")
        throw new Error("Peer benchmark operation was not applicable");
      current = reduced.state;
      operationId ||= operation.opId;
    }
    const event = {
      protocol: protocolVersion(current),
      kind: "operations",
      parent: head,
      operations: batch,
      resultHash: stateHash(current),
    };
    const oid = await transport.createCandidate(head, {
      ["events/" + randomUUID() + ".json"]: canonical(event),
    });
    if (!(await transport.publish(oid, head)))
      throw new Error("Peer benchmark publication raced");
    head = oid;
    operations.splice(0, batch.length);
  }
  parentPort.postMessage({
    oid: head,
    operationId,
    cellTaskId: taskId,
    cellValue,
    documentTaskId,
    documentId,
    documentValue,
    documents,
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
