// Independent peer used only by the reproducible local performance harness.
// It creates a real immutable operation and Git commit against the fixed C head.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sqliteTeamStore } from "../server/storage/sqlite.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { reduce } from "../server/sync/reducer.mjs";
import { canonical, entityId, stateHash } from "../server/sync/protocol.mjs";
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
  for (let i = 0; i < documents; i++) {
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
  const operation = makeOperation({
      link: { ...link, writer_epoch: randomUUID() },
      actorRef,
      before,
      after,
    }),
    reduced = reduce(state, operation);
  if (reduced.receipt.result !== "applied")
    throw new Error("Peer benchmark operation was not applicable");
  const transport = new GitCliTransport({
      directory,
      repository: remote,
      allowLocal: true,
    }),
    head = await transport.readHead();
  if (head !== link.canonical_head)
    throw new Error("Peer benchmark canonical head changed");
  const event = {
    protocol: 1,
    kind: "operations",
    parent: head,
    operations: [operation],
    resultHash: stateHash(reduced.state),
  };
  const oid = await transport.createCandidate(head, {
    ["events/" + randomUUID() + ".json"]: canonical(event),
  });
  if (!(await transport.publish(oid, head)))
    throw new Error("Peer benchmark publication raced");
  parentPort.postMessage({
    oid,
    operationId: operation.opId,
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
