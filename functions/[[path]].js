// Keep the public Pages URL on every request. The private Worker validates
// Access JWTs, account sessions and team permissions before serving anything.
export async function onRequest({ request, env }) {
  try {
    if (typeof env.GRAEBOARD_BACKEND?.fetch === "function")
      return await env.GRAEBOARD_BACKEND.fetch(request);
  } catch {
    // Do not expose binding errors or fall back to public static HTML for APIs.
  }
  return Response.json(
    { error: "외부 서버에 연결할 수 없습니다." },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
