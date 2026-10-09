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
  console.log(`GraeBoard: http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      app.locals.db.close();
      process.exit(0);
    }),
  );
