import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { S3ImageStore } from "../server/storage/external-backup.mjs";

let attempts = 0;
const server = createServer((_req, res) => {
  attempts++;
  res.writeHead(503, { "content-type": "application/xml" });
  res.end(
    "<Error><Code>ServiceUnavailable</Code><Message>synthetic R2 outage</Message></Error>",
  );
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const pool = new Pool({
    host: "/tmp/graeboard-unavailable-" + randomUUID(),
    database: "unavailable",
    connectionTimeoutMillis: 1000,
  }),
  teamId = randomUUID();
const images = new S3ImageStore({
  endpoint: `http://127.0.0.1:${server.address().port}`,
  bucket: "synthetic",
  teamId,
  accessKeyId: "synthetic-not-a-real-key",
  secretAccessKey: "synthetic-not-a-real-secret",
});
try {
  let pgError, r2Error;
  await Promise.all([
    pool
      .query("SELECT 1")
      .catch((error) => (pgError = error.code || error.message)),
    images
      .read(`/api/document-images/${teamId}/${"0".repeat(64)}.webp`)
      .catch((error) => (r2Error = error.name)),
  ]);
  if (!pgError || !r2Error || !attempts)
    throw new Error("External dependency fault did not occur");
  console.log(
    JSON.stringify({
      pgUnavailable: true,
      pgError,
      r2Unavailable: true,
      r2Error,
      r2HttpAttempts: attempts,
      verified: true,
      fixture:
        "unavailable local PostgreSQL socket; real S3 HTTP client against loopback503 server",
    }),
  );
} finally {
  images.close();
  await pool.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
