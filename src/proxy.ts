import { type ModelIndex, type ProviderConfig, ModelNotFoundError } from "./config";

function openaiError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", code: null },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function buildUpstreamRequest(
  url: string,
  body: Record<string, unknown>,
  providerConfig: ProviderConfig,
  providerModelName: string,
): Request {
  const upstreamUrl = `${url.replace(/\/+$/, "")}/chat/completions`;
  const apiKey = providerConfig.apiKeys[providerConfig.activeKeyIndex];
  const upstreamBody = { ...body, model: providerModelName };

  return new Request(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });
}

async function tryProvider(
  upstreamRequest: Request,
  isStreaming: boolean,
): Promise<
  | { ok: true; response: Response }
  | { ok: false; error?: Response }
> {
  let response: Response;
  try {
    response = await fetch(upstreamRequest);
  } catch {
    // Connection error before any response — retryable
    return { ok: false };
  }

  if (!isStreaming) {
    // Buffer the full response to check for errors
    const body = await response.text();
    if (response.ok) {
      return {
        ok: true,
        response: new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      };
    }
    // Non-2xx — error before tokens sent, retryable
    // Return the error response so the caller can pass it through
    return {
      ok: false,
      error: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  // Streaming: 2xx means streaming has started — committed
  // Non-2xx means error before tokens — retryable
  if (response.ok) {
    return { ok: true, response };
  }
  return { ok: false, error: response };
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

  let resolutions;
  try {
    resolutions = modelIndex.resolveAll(model);
  } catch (e) {
    if (e instanceof ModelNotFoundError) {
      return openaiError(e.message, 404);
    }
    return openaiError("Internal error resolving model", 500);
  }

  const isStreaming = body.stream === true;

  for (let i = 0; i < resolutions.length; i++) {
    const resolution = resolutions[i];
    const upstreamRequest = buildUpstreamRequest(
      resolution.providerConfig.baseUrl,
      body,
      resolution.providerConfig,
      resolution.providerModelName,
    );

    const result = await tryProvider(upstreamRequest, isStreaming);
    if (result.ok) {
      return result.response;
    }

    // Last provider — return upstream error directly
    if (i === resolutions.length - 1) {
      return result.error ?? openaiError(
        `Provider '${resolution.provider}' connection failed`,
        502,
      );
    }
  }

  return openaiError("No providers available", 502);
}
