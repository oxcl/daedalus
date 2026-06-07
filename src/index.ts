import { loadConfigs, buildModelIndex } from "./config";
import { handleChatCompletions } from "./proxy";
import { Storage } from "./storage";

export async function fetchHandler(
  request: Request,
  storage: Storage,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") {
    return handleHealth();
  }

  if (path === "/v1/models" && request.method === "GET") {
    const configs = await loadConfigs(storage);
    const data: { id: string; object: string; owned_by: string }[] = [];
    const seenGeneric = new Set<string>();
    for (const [provider, config] of configs) {
      for (const model of config.models) {
        data.push({ id: `${provider}@${model.name}`, object: "model", owned_by: provider });
        if (!seenGeneric.has(model.name)) {
          seenGeneric.add(model.name);
          data.push({ id: model.name, object: "model", owned_by: provider });
        }
      }
    }
    return jsonResponse({ object: "list", data });
  }

  if (path === "/v1/chat/completions" && request.method === "POST") {
    const configs = await loadConfigs(storage);
    const modelIndex = buildModelIndex(configs);
    return handleChatCompletions(request, modelIndex, storage);
  }

  return handleNotFound();
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