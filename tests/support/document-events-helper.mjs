import assert from "node:assert/strict";

export async function documentStream(
  t,
  baseURL,
  path,
  token,
  query = "",
  body,
) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${baseURL}${path}/events${query}`, {
    signal: controller.signal,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: {
      Cookie: `weekly_session=${token}`,
      "Accept-Encoding": "gzip",
      ...(body
        ? {
            "Content-Type": "application/json",
            "X-Requested-With": "WeeklyPlan",
          }
        : {}),
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    close: () => controller.abort(),
    async next() {
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1];
            if (event)
              return {
                event,
                data: JSON.parse(frame.match(/^data: (.+)$/m)[1]),
              };
          } else {
            const chunk = await reader.read();
            assert.ok(!chunk.done, "stream ended before event");
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
