import { authenticateRequest } from "./auth";
import { loadConfigs, buildModelIndex } from "./config";
import { handleChatCompletions } from "./proxy";

export interface Env {
  KV: KVNamespace;
  GATEWAY_API_KEY: string;
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

    const authenticated = authenticateRequest(request, env.GATEWAY_API_KEY);
    if (authenticated instanceof Response) {
      return authenticated;
    }

    if (path === "/v1/models" && request.method === "GET") {
      const configs = await loadConfigs(env.KV);
      const data: { id: string; object: string; owned_by: string }[] = [];
      for (const [provider, config] of configs) {
        for (const model of config.models) {
          data.push({ id: model.name, object: "model", owned_by: provider });
          if (model.name !== model.providerName) {
            data.push({ id: `${provider}@${model.name}`, object: "model", owned_by: provider });
          }
        }
      }
      return jsonResponse({ object: "list", data });
    }

    if (path === "/v1/chat/completions" && request.method === "POST") {
      const configs = await loadConfigs(env.KV);
      const modelIndex = buildModelIndex(configs);
      return handleChatCompletions(authenticated, modelIndex);
    }

    return handleNotFound();
  },
};
