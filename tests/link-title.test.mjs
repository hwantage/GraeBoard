import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLinkTitleService,
  allowedLinkTitleAddress,
  extractLinkTitle,
  requestLinkTitle,
} from "../shared/link-title.mjs";
import { createApp } from "../server/app.mjs";
import { openDatabase, now } from "../server/db.mjs";

// EUC-KR bytes for "한글 제목", independent of the decoder under test.
const koreanTitle = Buffer.from("c7d1b1db20c1a6b8f1", "hex");
const eucPage = (meta) =>
  Buffer.concat([
    Buffer.from(`<html><head>${meta}<title>`, "ascii"),
    koreanTitle,
    Buffer.from("</title></head></html>", "ascii"),
  ]);
const unicodePage = "<title>BOM 한글 제목</title>";
const linkTitleEncodingPages = {
  "/euc-meta": { type: "text/html", bytes: eucPage('<meta charset="euc-kr">') },
  "/euc-legacy": {
    type: "text/html",
    bytes: eucPage(
      "<META content='text/html; charset=EUC-KR' HTTP-EQUIV='Content-Type'>",
    ),
  },
  "/euc-comment": {
    type: "text/html",
    bytes: eucPage('<!-- <meta charset="utf-8"> --><meta charset="euc-kr">'),
  },
  "/euc-header": {
    type: "text/html; charset=EUC-KR",
    bytes: eucPage('<meta charset="utf-8">'),
  },
  "/euc-unknown-header": {
    type: "text/html; charset=unknown-label",
    bytes: eucPage('<meta charset="euc-kr">'),
  },
  "/bom-utf8": {
    type: "text/html; charset=EUC-KR",
    bytes: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(unicodePage),
    ]),
  },
  "/bom-utf16le": {
    type: "text/html; charset=utf-8",
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(unicodePage, "utf16le"),
    ]),
  },
  "/bom-utf16be": {
    type: "text/html; charset=utf-8",
    bytes: Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(unicodePage, "utf16le").swap16(),
    ]),
  },
  "/late-meta": {
    type: "text/html",
    bytes: Buffer.concat([
      Buffer.alloc(1024, 32),
      eucPage('<meta charset="euc-kr">'),
    ]),
  },
};

async function source(t) {
  const server = createServer((req, res) => {
    if (req.url === "/slow") return;
    if (req.url === "/private") {
      res.writeHead(302, { Location: "http://127.0.0.1/" });
      return res.end();
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/title" });
      return res.end();
    }
    if (req.url === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      return res.end();
    }
    const encodingPage = linkTitleEncodingPages[req.url];
    if (encodingPage) {
      res.setHeader("Content-Type", encodingPage.type);
      return res.end(encodingPage.bytes);
    }
    res.setHeader(
      "Content-Type",
      req.url === "/json" ? "application/json" : "text/html; charset=utf-8",
    );
    res.end(
      req.url === "/large"
        ? " ".repeat(256 * 1024) + "<title>뒤의 제목</title>"
        : "<title>  사이트 &amp; &#x1f600;\n제목 </title><meta property='og:title' content='보조 제목'>",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const calls = [];
  return {
    calls,
    options: {
      resolve: async () => [
        { address: "93.184.215.14" },
        { address: "2606:2800:220:1::1" },
      ],
      request: (url, address, signal) => {
        calls.push({ url: url.href, address });
        const local = new URL(url);
        local.protocol = "http:";
        local.port = String(server.address().port);
        return requestLinkTitle(local, "127.0.0.1", signal);
      },
    },
  };
}

test("HTML 제목은 엔티티·공백·제어 문자·200자와 og:title 우선순위를 처리한다", () => {
  assert.equal(
    extractLinkTitle("<title> A &amp; &copy; &#x1f600; \nB\u0001 </title>"),
    "A & © 😀 B",
  );
  assert.equal(
    extractLinkTitle(
      "<title> </title><meta content='A &quot;B&quot;' property='og:title'>",
    ),
    'A "B"',
  );
  assert.equal(
    extractLinkTitle("<title>" + "😀".repeat(220) + "</title>"),
    "😀".repeat(200),
  );
  assert.equal(
    extractLinkTitle(
      "<!-- <title>fake</title> --><script>'<title>fake</title>'</script>",
    ),
    null,
  );
  assert.equal(
    extractLinkTitle("<title>&lt;img src=x&gt;</title>"),
    "<img src=x>",
  );
});

test("로컬 HTTP 응답의 제목, 비HTML, 본문 제한, 리다이렉트와 시간 제한", async (t) => {
  const f = await source(t);
  const title = createLinkTitleService({ ...f.options, timeoutMs: 100 });
  assert.deepEqual(await title("user", "http://public.example/title"), {
    title: "사이트 & 😀 제목",
  });
  assert.equal(f.calls[0].address, "93.184.215.14");
  assert.deepEqual(await title("user", "http://public.example/json"), {
    title: null,
  });
  assert.deepEqual(await title("user", "http://public.example/large"), {
    title: null,
  });
  assert.deepEqual(await title("user", "http://public.example/redirect"), {
    title: "사이트 & 😀 제목",
  });
  await assert.rejects(title("user", "http://public.example/private"), {
    status: 400,
  });
  await assert.rejects(title("user", "http://public.example/loop"), {
    status: 400,
  });
  await assert.rejects(title("user", "http://public.example/slow"), {
    status: 504,
  });
});

test("Node HTTP는 BOM·헤더·앞 1KiB meta 순서로 한국어 제목을 디코딩한다", async (t) => {
  const f = await source(t);
  const title = createLinkTitleService(f.options);
  for (const path of Object.keys(linkTitleEncodingPages)) {
    const result = await title("encoding", "http://public.example" + path);
    if (path === "/late-meta") assert.notEqual(result.title, "한글 제목");
    else
      assert.equal(
        result.title,
        path.startsWith("/bom-") ? "BOM 한글 제목" : "한글 제목",
        path,
      );
  }
});

test("사설·루프백·링크로컬·CGNAT·메타데이터·IPv6 매핑·멀티캐스트를 차단한다", async () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.1.2",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "168.63.129.16",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:7f00::1",
  ]) {
    assert.equal(allowedLinkTitleAddress(ip), false, ip);
    await assert.rejects(
      createLinkTitleService()(
        "user",
        `http://${ip.includes(":") ? `[${ip}]` : ip}/`,
      ),
      { status: 400 },
    );
  }
  assert.equal(allowedLinkTitleAddress("8.8.8.8"), true);
  assert.equal(allowedLinkTitleAddress("2606:4700:4700::1111"), true);
});

test("DNS의 모든 주소를 검사하고 허용 접미사만 사설 IP를 허용하며 재바인딩을 막는다", async () => {
  let calls = 0;
  const options = {
    resolve: async () => [{ address: "8.8.8.8" }, { address: "10.0.0.1" }],
    request: async (_url, address) => {
      calls++;
      assert.equal(address, "8.8.8.8");
      return { title: "허용" };
    },
  };
  await assert.rejects(
    createLinkTitleService(options)("u", "https://portal.somansa.com/"),
    { status: 400 },
  );
  assert.equal(calls, 0);
  const title = createLinkTitleService({
    ...options,
    privateHosts: "somansa.com",
  });
  assert.deepEqual(await title("u", "https://portal.somansa.com/"), {
    title: "허용",
  });
  await assert.rejects(title("u", "https://somansa.com.evil.example/"), {
    status: 400,
  });
  await assert.rejects(title("u", "https://evilsomansa.com/"), { status: 400 });
  assert.equal(allowedLinkTitleAddress("127.0.0.1", true), false);
  assert.equal(allowedLinkTitleAddress("169.254.169.254", true), false);
  assert.equal(allowedLinkTitleAddress("fc00::1", true), true);
  for (const address of [
    "fd00:ec2::254",
    "fd00:0ec2:0:0:0:0:0:254",
    "fd20:ce::254",
  ]) {
    assert.equal(allowedLinkTitleAddress(address, true), false);
    await assert.rejects(
      createLinkTitleService({
        privateHosts: "somansa.com",
        resolve: async () => [{ address }],
        request: async () => assert.fail("Metadata must not be contacted"),
      })("u", "https://portal.somansa.com/"),
      { status: 400 },
    );
  }
  let lookups = 0;
  const pinned = createLinkTitleService({
    resolve: async () => {
      lookups++;
      return [{ address: lookups === 1 ? "8.8.8.8" : "127.0.0.1" }];
    },
    request: async (_url, address) => {
      assert.equal(address, "8.8.8.8");
      return { title: "고정 IP" };
    },
  });
  assert.deepEqual(await pinned("u", "https://public.example"), {
    title: "고정 IP",
  });
  assert.equal(lookups, 1);
});

test("인증 정보·프로토콜·포트를 거절하고 사용자별 요청 수와 DNS 시간도 제한한다", async () => {
  const f = createLinkTitleService({
    resolve: async () => [{ address: "8.8.8.8" }],
    request: async () => ({ title: "제목" }),
  });
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com",
    "https://user:pass@example.com",
    "http://example.com:8080",
    "https://example.com:8443",
    "invalid",
  ])
    await assert.rejects(f("u", url), { status: 400 });
  const limited = createLinkTitleService({
    resolve: async () => [{ address: "8.8.8.8" }],
    request: async () => ({ title: null }),
    requestsPerMinute: 1,
  });
  await limited("a", "https://example.com");
  await assert.rejects(limited("a", "https://example.com"), { status: 429 });
  await limited("b", "https://example.com");
  let contacted = false;
  const slow = createLinkTitleService({
    resolve: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return [{ address: "8.8.8.8" }];
    },
    request: async () => {
      contacted = true;
    },
    timeoutMs: 10,
  });
  await assert.rejects(slow("u", "https://example.com"), { status: 504 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(contacted, false);
});

test("Node API는 로그인과 기존 CSRF 헤더를 요구하고 같은 계약으로 응답한다", async (t) => {
  const f = await source(t);
  const dir = mkdtempSync(join(tmpdir(), "gb-link-title-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  const id = randomUUID(),
    token = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,?,?,?)",
  ).run(id, "test@example.com", "검사", "unused", now());
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    id,
    Date.now() + 3600000,
  );
  const app = createApp({
    db,
    rateLimits: false,
    linkTitleOptions: { ...f.options, requestsPerMinute: 1 },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await app.locals.sync.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/link-title?url=${encodeURIComponent("https://public.example/title")}`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = {
    Cookie: `weekly_session=${token}`,
    "X-Requested-With": "WeeklyPlan",
  };
  assert.equal(
    (await fetch(endpoint, { headers: { Cookie: headers.Cookie } })).status,
    403,
  );
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: "사이트 & 😀 제목" });
  assert.equal((await fetch(endpoint, { headers })).status, 429);
});

test("Edge 전송은 검사한 IP와 원래 TLS 호스트를 유지하고 HTML·chunked·본문 상한을 처리한다", async () => {
  const { requestEdgeLinkTitle } = await import("../edge/link-title.mjs");
  function runtime(response) {
    const bytes =
      typeof response === "string"
        ? new TextEncoder().encode(response)
        : response;
    let offset = 0,
      closed = false,
      written = "";
    const calls = [];
    const socket = {
      close: () => {
        closed = true;
      },
      handshake: async () => {},
      write: async (bytes) => {
        written += new TextDecoder().decode(bytes);
        return bytes.length;
      },
      read: async (target) => {
        if (offset >= bytes.length) return null;
        const count = Math.min(31, target.length, bytes.length - offset);
        target.set(bytes.subarray(offset, offset + count));
        offset += count;
        return count;
      },
    };
    return {
      connect: async (options) => {
        calls.push(options);
        return socket;
      },
      startTls: async (connection, options) => {
        assert.equal(connection, socket);
        calls.push(options);
        return socket;
      },
      check: () => {
        assert.equal(closed, true);
        assert.match(written, /Host: public.example\r\n/);
        return calls;
      },
    };
  }
  for (const [path, page] of Object.entries(linkTitleEncodingPages)) {
    const response = runtime(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 200 OK\r\nContent-Type: ${page.type}\r\n\r\n`,
          "ascii",
        ),
        page.bytes,
      ]),
    );
    const result = await requestEdgeLinkTitle(
      new URL("https://public.example" + path),
      "8.8.8.8",
      new AbortController().signal,
      response,
    );
    if (path === "/late-meta") assert.notEqual(result.title, "한글 제목");
    else
      assert.equal(
        result.title,
        path.startsWith("/bom-") ? "BOM 한글 제목" : "한글 제목",
        path,
      );
  }
  const normal = runtime(
    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<title>Edge &amp; 제목</title>",
  );
  assert.deepEqual(
    await requestEdgeLinkTitle(
      new URL("https://public.example"),
      "8.8.8.8",
      new AbortController().signal,
      normal,
    ),
    { title: "Edge & 제목" },
  );
  assert.deepEqual(normal.check(), [
    { hostname: "8.8.8.8", port: 443 },
    { hostname: "public.example", alpnProtocols: ["http/1.1"] },
  ]);
  const body = "<title>chunked</title>";
  const chunked = runtime(
    `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)};extension=value\r\n${body}\r\n0\r\n\r\n`,
  );
  assert.deepEqual(
    await requestEdgeLinkTitle(
      new URL("http://public.example"),
      "8.8.8.8",
      new AbortController().signal,
      chunked,
    ),
    { title: "chunked" },
  );
  const large = runtime(
    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n" +
      " ".repeat(256 * 1024) +
      "<title>too late</title>",
  );
  assert.deepEqual(
    await requestEdgeLinkTitle(
      new URL("http://public.example"),
      "8.8.8.8",
      new AbortController().signal,
      large,
    ),
    { title: null },
  );
  const redirect = runtime(
    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\n\r\n",
  );
  assert.deepEqual(
    await requestEdgeLinkTitle(
      new URL("http://public.example"),
      "8.8.8.8",
      new AbortController().signal,
      redirect,
    ),
    { redirect: "http://127.0.0.1/" },
  );
});
