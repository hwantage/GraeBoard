import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function upgradeArguments(args) {
  const options = {};
  const values = new Set([
    "url",
    "team",
    "cookie-file",
    "expected-head",
    "expected-hash",
  ]);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--")) throw new Error("옵션 이름을 확인하세요.");
    if (["execute", "peers-stopped"].includes(name)) options[name] = true;
    else if (values.has(name) && args[i + 1] && !args[i + 1].startsWith("--"))
      options[name] = args[++i];
    else throw new Error("알 수 없거나 값이 없는 옵션: " + args[i]);
  }
  const url = new URL(options.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("--url에 서버의 HTTP(S) origin만 지정하세요.");
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(options.team || "")
  )
    throw new Error("--team에 팀 UUID를 지정하세요.");
  if (
    options.execute &&
    (!options["peers-stopped"] ||
      !/^[a-f0-9]{40}$/.test(options["expected-head"] || "") ||
      !/^[a-f0-9]{64}$/.test(options["expected-hash"] || ""))
  )
    throw new Error(
      "실행에는 --peers-stopped, --expected-head(40hex), --expected-hash(64hex)가 모두 필요합니다.",
    );
  return { ...options, url: url.origin };
}

export async function runUpgrade(
  options,
  {
    fetchImpl = fetch,
    cookie = process.env.GRAEBOARD_SYNC_API_COOKIE || "",
  } = {},
) {
  if (options["cookie-file"])
    cookie = readFileSync(options["cookie-file"], "utf8").trim();
  if (!cookie)
    throw new Error(
      "관리자 인증 쿠키를 --cookie-file 또는 GRAEBOARD_SYNC_API_COOKIE로 지정하세요.",
    );
  const base = `${options.url}/api/teams/${options.team}/sync`;
  const response = await fetchImpl(base + (options.execute ? "/upgrade" : ""), {
    method: options.execute ? "POST" : "GET",
    headers: {
      Cookie: cookie,
      "X-Requested-With": "WeeklyPlan",
      ...(options.execute ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.execute
      ? {
          body: JSON.stringify({
            expectedHead: options["expected-head"],
            expectedHash: options["expected-hash"],
            peersStopped: true,
          }),
        }
      : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return options.execute
    ? result
    : {
        execute: false,
        mode: result.mode,
        protocol: result.protocol,
        expectedHead: result.canonicalHead,
        expectedHash: result.canonicalHash,
        pending: result.pending,
        conflicts: result.conflicts,
      };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      JSON.stringify(
        await runUpgrade(upgradeArguments(process.argv.slice(2))),
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
