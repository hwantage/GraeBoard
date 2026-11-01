import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 설정 화면에 표시할 버전: 빌드한 커밋과 그 날짜. Git이 없는 사본에서는
// package.json의 버전을 쓴다.
function appVersion() {
  try {
    const [sha, date] = execFileSync("git", ["log", "-1", "--format=%h%n%cs"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n");
    if (sha && date) return `${sha} · ${date}`;
  } catch {
    // Not a Git checkout.
  }
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4310", changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 700 },
});
