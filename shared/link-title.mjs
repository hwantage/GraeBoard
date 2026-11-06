import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { decodeHTML } from "entities";
import { HttpError, requireThat } from "./http-error.js";

const limit = 256 * 1024;
const rejected = () => new HttpError(400, "링크 주소를 확인하세요.");

export function linkTitleUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw rejected();
  }
  requireThat(
    typeof value === "string" &&
      value.length <= 8192 &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port,
    400,
    "링크 주소를 확인하세요.",
  );
  return url;
}

export function allowedLinkTitleAddress(address, privateHost = false) {
  if (isIP(address) === 4) {
    const [a, b, c, d] = address.split(".").map(Number);
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
      return privateHost;
    return !(
      a === 0 ||
      a === 127 ||
      a >= 224 ||
      (a === 168 && b === 63 && c === 129 && d === 16) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 192 && (b === 0 || (b === 88 && c === 99))) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const first = parseInt(address.split(":")[0] || "0", 16);
  const second = parseInt(address.split(":")[1] || "0", 16);
  // Cloud metadata stays blocked even when a trusted host may use ULA.
  if (
    (first === 0xfd00 && second === 0xec2) ||
    (first === 0xfd20 && second === 0xce)
  )
    return false;
  if ((first & 0xfe00) === 0xfc00) return privateHost;
  // Only global unicast; mapped, compatible, NAT64, local and multicast
  // addresses are excluded even for explicitly permitted private hosts.
  if ((first & 0xe000) !== 0x2000) return false;
  return !(
    first === 0x2002 ||
    (first === 0x2001 && (second < 0x200 || second === 0xdb8))
  );
}

function permitsPrivate(host, setting) {
  return String(setting || "")
    .split(",")
    .some((item) => {
      const suffix = item
        .trim()
        .toLowerCase()
        .replace(/^\./, "")
        .replace(/\.$/, "");
      return (
        /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(suffix) &&
        !isIP(suffix) &&
        (host === suffix || host.endsWith("." + suffix))
      );
    });
}

function htmlAttributes(tag) {
  const attrs = Object.create(null);
  for (const match of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    const name = match[1].toLowerCase();
    if (!Object.hasOwn(attrs, name))
      attrs[name] = match[2] ?? match[3] ?? match[4];
  }
  return attrs;
}

function declaredCharset(value) {
  const match =
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/i.exec(
      value || "",
    );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

// HTML's byte-level order: BOM, supported transport charset, then a complete
// meta declaration within the first 1024 bytes. Keep UTF-8 as the fallback.
export function decodeLinkTitleHtml(bytes, contentType = "") {
  const decoder = (label, meta = false) => {
    if (!label) return null;
    try {
      const value = new TextDecoder(label);
      return meta && value.encoding.startsWith("utf-16")
        ? new TextDecoder()
        : value;
    } catch {
      return null;
    }
  };
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : null;
  const certain = decoder(bom) || decoder(declaredCharset(contentType));
  if (certain) return certain.decode(bytes);
  const prefix = Array.from(bytes.subarray(0, 1024), (byte) =>
    String.fromCharCode(byte),
  )
    .join("")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const match of prefix.matchAll(
    /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
  )) {
    const attrs = htmlAttributes(match[0]);
    const label =
      attrs.charset ||
      (attrs["http-equiv"]?.trim().toLowerCase() === "content-type"
        ? declaredCharset(attrs.content)
        : null);
    const value = decoder(label, true);
    if (value) return value.decode(bytes);
  }
  return new TextDecoder().decode(bytes);
}

export function extractLinkTitle(html) {
  const clean = (text) =>
    Array.from(
      decodeHTML(text)
        .replace(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
          "",
        )
        .replace(/\s+/g, " ")
        .trim(),
    )
      .slice(0, 200)
      .join("");
  // Comments and raw script/style text cannot supply metadata.
  const head = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    "",
  );
  const title = clean(
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] || "",
  );
  if (title) return title;
  for (const match of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    if ((attrs.property || attrs.name || "").toLowerCase() === "og:title")
      return clean(attrs.content || "");
  }
  return null;
}

// The transport accepts a previously checked literal IP, never a hostname.
// Host and TLS servername retain virtual-host routing and certificate checks.
export function requestLinkTitle(url, address, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: address,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        servername: isIP(hostname) ? undefined : hostname,
        path: url.pathname + url.search,
        method: "GET",
        agent: false,
        signal,
        maxHeaderSize: 16384,
        headers: {
          Host: url.host,
          Accept: "text/html",
          "Accept-Encoding": "identity",
          "User-Agent": "GraeBoard-LinkTitle/1.0",
        },
      },
      (response) => {
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          return resolve({ redirect: response.headers.location });
        }
        if (
          status < 200 ||
          status >= 300 ||
          !/^text\/html(?:\s*;|\s*$)/i.test(
            response.headers["content-type"] || "",
          ) ||
          ![undefined, "identity"].includes(
            response.headers["content-encoding"],
          )
        ) {
          response.destroy();
          return resolve({ title: null });
        }
        const chunks = [];
        let size = 0,
          complete = false;
        const finish = () => {
          if (complete) return;
          complete = true;
          const bytes = Buffer.concat(chunks);
          resolve({
            title: extractLinkTitle(
              decodeLinkTitleHtml(bytes, response.headers["content-type"]),
            ),
          });
          response.destroy();
        };
        response.on("data", (chunk) => {
          const part = Buffer.from(chunk).subarray(0, limit - size);
          chunks.push(part);
          size += part.length;
          if (size >= limit) finish();
        });
        response.on("end", finish);
        response.on("error", reject);
        response.on("aborted", () => {
          if (!complete) reject(new Error("Incomplete HTML response"));
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export function createLinkTitleService({
  resolve = (host) => lookup(host, { all: true, verbatim: true }),
  request = requestLinkTitle,
  timeoutMs = 5000,
  privateHosts = "",
  requestsPerMinute = 20,
} = {}) {
  const users = new Map();
  return async (userId, value) => {
    const now = Date.now();
    for (const [key, entry] of users) if (entry.until <= now) users.delete(key);
    const entry = users.get(userId) || { until: now + 60000, count: 0 };
    requireThat(
      ++entry.count <= requestsPerMinute,
      429,
      "링크 제목 조회가 많습니다. 잠시 후 다시 시도하세요.",
    );
    users.set(userId, entry);
    let url = linkTitleUrl(value);
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new HttpError(504, "링크 제목 조회 시간이 초과되었습니다."));
          }, timeoutMs);
        }),
        (async () => {
          for (let redirects = 0; redirects <= 3; redirects++) {
            const host = url.hostname
              .replace(/^\[|\]$/g, "")
              .toLowerCase()
              .replace(/\.$/, "");
            const addresses = isIP(host)
              ? [{ address: host }]
              : await resolve(host);
            controller.signal.throwIfAborted();
            requireThat(
              addresses.length &&
                addresses.every(({ address }) =>
                  allowedLinkTitleAddress(
                    address,
                    permitsPrivate(host, privateHosts),
                  ),
                ),
              400,
              "허용되지 않는 링크 주소입니다.",
            );
            const result = await request(
              url,
              addresses[0].address,
              controller.signal,
            );
            controller.signal.throwIfAborted();
            if (!Object.hasOwn(result, "redirect"))
              return { title: result.title };
            requireThat(
              result.redirect && redirects < 3,
              400,
              "링크 이동 횟수를 확인하세요.",
            );
            url = linkTitleUrl(new URL(result.redirect, url).href);
          }
        })(),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
