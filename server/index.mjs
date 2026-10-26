import { createApp } from "./app.mjs";
const port = Number(process.env.PORT || 4310),
  host = process.env.HOST || "127.0.0.1";
const app = createApp();
if (
  app.locals.db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0 &&
  process.env.NODE_ENV === "production" &&
  host !== "127.0.0.1" &&
  !process.env.SETUP_TOKEN
) {
  console.error("외부 접속용 첫 설정에는 SETUP_TOKEN 환경 변수가 필요합니다.");
  process.exit(1);
}
const server = app.listen(port, host, () =>
  console.log(`GraeBoard: http://${host}:${server.address().port}`),
);
let stopping = false;
server.prependListener("request", (_request, response) => {
  response.once("finish", () => {
    // A request already in progress can become idle after close() reaped the
    // previous idle sockets. Reap again only after its response has finished.
    if (stopping) setImmediate(() => server.closeIdleConnections());
  });
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const configuredTimeout = Number(process.env.GRAEBOARD_SHUTDOWN_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) &&
    configuredTimeout >= 100 &&
    configuredTimeout <= 600000
      ? configuredTimeout
      : 30000;
  const deadline = setTimeout(() => {
    console.error(
      "서버 종료 대기 시간을 초과했습니다. 미전송 변경은 DB에 보존되며 종료 후 복구 점검이 필요합니다.",
    );
    server.closeAllConnections();
    process.exit(1);
  }, timeoutMs);
  deadline.unref();
  // Stop accepting connections before closing subscriptions. A multiplexed
  // request may still be awaiting its next channel, so hub shutdown is terminal.
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.cellEvents.shutdown();
  app.locals.documentEvents.shutdown();
  server.closeIdleConnections();
  await Promise.all([closed, app.locals.sync.close()]);
  clearTimeout(deadline);
  app.locals.db.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void shutdown().catch((error) => {
      console.error("서버 종료에 실패했습니다.", error.message);
      process.exit(1);
    });
  });
