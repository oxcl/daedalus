export interface Env {
  KV: KVNamespace;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function handleHealth(): Response {
  return jsonResponse({ status: "ok" });
}

function handleNotFound(): Response {
  return jsonResponse(
    { error: { message: "Not found", type: "invalid_request_error", code: null } },
    404,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return handleHealth();
    }

    if (path.startsWith("/v1/")) {
      return handleNotFound();
    }

    return handleNotFound();
  },
};
