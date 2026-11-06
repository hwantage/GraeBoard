import {
  decodeLinkTitleHtml,
  extractLinkTitle,
} from "../shared/link-title.mjs";

// Deno's node:https adapter uses fetch internally and cannot keep the URL's
// certificate hostname when dialing a literal IP. Dial the inspected IP and
// upgrade that same socket with the original hostname and TLS verification.
export async function requestEdgeLinkTitle(
  url,
  address,
  signal,
  runtime = Deno,
) {
  signal.throwIfAborted();
  let connection;
  const close = () => {
    try {
      connection?.close();
    } catch {}
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    connection = await runtime.connect({
      hostname: address,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    });
    signal.throwIfAborted();
    if (url.protocol === "https:") {
      connection = await runtime.startTls(connection, {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        alpnProtocols: ["http/1.1"],
      });
      signal.throwIfAborted();
      await connection.handshake();
    }
    const outgoing = new TextEncoder().encode(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/html\r\nAccept-Encoding: identity\r\nUser-Agent: GraeBoard-LinkTitle/1.0\r\nConnection: close\r\n\r\n`,
    );
    let sent = 0;
    while (sent < outgoing.length)
      sent += await connection.write(outgoing.subarray(sent));
    let buffered = new Uint8Array();
    const fill = async () => {
      const bytes = new Uint8Array(16384);
      const count = await connection.read(bytes);
      if (count === null) return false;
      const joined = new Uint8Array(buffered.length + count);
      joined.set(buffered);
      joined.set(bytes.subarray(0, count), buffered.length);
      buffered = joined;
      return true;
    };
    const line = async (max = 16384) => {
      for (;;) {
        const end = buffered.findIndex(
          (byte, i) => byte === 13 && buffered[i + 1] === 10,
        );
        if (end >= 0) {
          if (end > max) throw new Error("Link title HTTP header too large");
          const value = new TextDecoder().decode(buffered.subarray(0, end));
          buffered = buffered.subarray(end + 2);
          return value;
        }
        if (buffered.length > max || !(await fill()))
          throw new Error("Invalid link title HTTP response");
      }
    };
    const statusLine = await line();
    if (!/^HTTP\/1\.[01] \d{3}\b/.test(statusLine))
      throw new Error("Invalid link title HTTP status");
    const status = Number(statusLine.split(" ")[1]);
    const headers = new Headers();
    let size = statusLine.length;
    for (;;) {
      const value = await line();
      if (!value) break;
      size += value.length + 2;
      if (size > 16384) throw new Error("Link title HTTP headers too large");
      const colon = value.indexOf(":");
      if (colon < 1) throw new Error("Invalid link title HTTP header");
      headers.append(value.slice(0, colon), value.slice(colon + 1).trim());
    }
    if ([301, 302, 303, 307, 308].includes(status))
      return { redirect: headers.get("location") };
    if (
      status < 200 ||
      status >= 300 ||
      !/^text\/html(?:\s*;|\s*$)/i.test(headers.get("content-type") || "") ||
      ![null, "identity"].includes(headers.get("content-encoding"))
    )
      return { title: null };
    const chunked = headers.get("transfer-encoding")?.toLowerCase();
    if (chunked && chunked !== "chunked") return { title: null };
    const chunks = [];
    const max = 256 * 1024;
    let total = 0;
    const take = async (length, eofAllowed = false) => {
      while (length > 0 && total < max) {
        if (!buffered.length && !(await fill())) {
          if (eofAllowed) return;
          throw new Error("Incomplete link title response");
        }
        const count = Math.min(buffered.length, length, max - total);
        chunks.push(buffered.subarray(0, count));
        total += count;
        length -= count;
        buffered = buffered.subarray(count);
      }
    };
    if (chunked) {
      while (total < max) {
        const value = await line(1024);
        if (!/^[\da-f]+(?:;[^\r\n]*)?$/i.test(value))
          throw new Error("Invalid link title HTTP chunk");
        const count = parseInt(value, 16);
        if (!count) break;
        await take(count);
        if (total < max && (await line(2)) !== "")
          throw new Error("Invalid link title HTTP chunk end");
      }
    } else {
      const length = headers.get("content-length");
      if (length !== null && !/^\d+$/.test(length))
        throw new Error("Invalid link title content length");
      await take(
        length === null ? max : Math.min(Number(length), max),
        length === null,
      );
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      title: extractLinkTitle(
        decodeLinkTitleHtml(bytes, headers.get("content-type")),
      ),
    };
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}
