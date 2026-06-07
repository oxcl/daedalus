import { type ModelIndex, ModelNotFoundError } from "./config";

function openaiError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", code: null },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export async function handleChatCompletions(
  request: Request,
  modelIndex: ModelIndex,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return openaiError("Invalid JSON in request body", 400);
  }

  const model = body.model;
  if (typeof model !== "string" || model.length === 0) {
    return openaiError("model field is required", 400);
  }

  let resolution;
  try {
    resolution = modelIndex.resolve(model);
  } catch (e) {
    if (e instanceof ModelNotFoundError) {
      return openaiError(e.message, 404);
    }
    return openaiError("Internal error resolving model", 500);
  }

  const { providerConfig, providerModelName } = resolution;
  const upstreamUrl = `${providerConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const apiKey = providerConfig.apiKeys[providerConfig.activeKeyIndex];

  const upstreamBody = { ...body, model: providerModelName };

  const upstreamRequest = new Request(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  return fetch(upstreamRequest);
}
