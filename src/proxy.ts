import { type ModelIndex, type ProviderConfig, ModelNotFoundError, updateActiveKeyIndex } from "./config";
import { type Storage } from "./storage";

export const IDLE_TIMEOUT_MS = 10_000;

let _setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = (cb, ms) => globalThis.setTimeout(cb, ms);
let _clearTimeout: (id: ReturnType<typeof setTimeout>) => void = (id) => globalThis.clearTimeout(id);

export function setTimerFn(
  setTimeoutFn: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void,
): void {
  _setTimeout = setTimeoutFn;
  _clearTimeout = clearTimeoutFn;
}

export function resetTimerFn(): void {
  _setTimeout = (cb, ms) => globalThis.setTimeout(cb, ms);
  _clearTimeout = (id) => globalThis.clearTimeout(id);
}

function openaiError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", code: null },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function openaiRateLimitError(message: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfter !== undefined) {
    headers["Retry-After"] = String(retryAfter);
  }
  return new Response(
    JSON.stringify({
      error: { message, type: "rate_limit_error", code: null },
    }),
    { status: 429, headers },
  );
}

export function buildUpstreamRequest(
  url: string,
  body: Record<string, unknown>,
  providerConfig: ProviderConfig,
  providerModelName: string,
): Request {
  const upstreamUrl = `${url.replace(/\/+$/, "")}/chat/completions`;
  const apiKey = providerConfig.apiKeys[providerConfig.activeKeyIndex];
  const { store, ...rest } = body;
  const upstreamBody = { ...rest, model: providerModelName };

  return new Request(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });
}

export function parseRetryAfter(header: string | null): number {
  if (!header) {
    return 60;
  }
  const seconds = parseInt(header, 10);
  if (isNaN(seconds) || seconds < 0) {
    return 60;
  }
  return seconds;
}

let _delayFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setDelayFn(fn: (ms: number) => Promise<void>): void {
  _delayFn = fn;
}

export function resetDelayFn(): void {
  _delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function resetTimer(
    controller: ReadableStreamDefaultController<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): void {
    if (timer !== null) _clearTimeout(timer);
    timer = _setTimeout(() => {
      reader.cancel().catch(() => {});
      controller.error(new Error("Idle timeout: no bytes received for 10 seconds"));
    }, timeoutMs);
  }

  return new ReadableStream({
    start(controller) {
      const reader = body.getReader();
      resetTimer(controller, reader);

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (timer !== null) _clearTimeout(timer);
              controller.close();
              break;
            }
            resetTimer(controller, reader);
            controller.enqueue(value);
          }
        } catch (err) {
          if (timer !== null) _clearTimeout(timer);
          controller.error(err);
        }
      })();
    },
    cancel() {
      if (timer !== null) _clearTimeout(timer);
    },
  });
}

async function tryProvider(
  upstreamRequest: Request,
  isStreaming: boolean,
): Promise<
  | { ok: true; response: Response }
  | { ok: false; error?: Response; retryAfter?: number }
> {
  const controller = new AbortController();
  const timeout = _setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(upstreamRequest, { signal: controller.signal });
  } catch {
    _clearTimeout(timeout);
    return { ok: false, error: openaiError("Upstream connection failed", 502) };
  }
  _clearTimeout(timeout);

  const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));

  if (!isStreaming) {
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
    if (response.status === 429) {
      return { ok: false, error: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), retryAfter };
    }
    return {
      ok: false,
      error: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  if (response.ok) {
    const wrappedBody = wrapWithIdleTimeout(response.body!, IDLE_TIMEOUT_MS);
    return {
      ok: true,
      response: new Response(wrappedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }
  if (response.status === 429) {
    return { ok: false, error: response, retryAfter };
  }
  return { ok: false, error: response };
}

async function tryProviderWithKeyRotation(
  baseUrl: string,
  body: Record<string, unknown>,
  providerConfig: ProviderConfig,
  providerModelName: string,
  isStreaming: boolean,
): Promise<Response> {
  const numKeys = providerConfig.apiKeys.length;
  let currentKeyIndex = providerConfig.activeKeyIndex;
  let lastRetryAfter: number | undefined;

  for (let attempt = 0; attempt < numKeys; attempt++) {
    providerConfig.activeKeyIndex = currentKeyIndex;
    const upstreamRequest = buildUpstreamRequest(baseUrl, body, providerConfig, providerModelName);
    const result = await tryProvider(upstreamRequest, isStreaming);

    if (result.ok) {
      return result.response;
    }

    if (result.retryAfter !== undefined) {
      lastRetryAfter = result.retryAfter;
      currentKeyIndex = (currentKeyIndex + 1) % numKeys;
      continue;
    }

    return result.error!;
  }

  return openaiRateLimitError("All API keys for provider exhausted", lastRetryAfter);
}

export async function handleChatCompletions(
  request: Request,
  modelIndex: ModelIndex,
  storage: Storage,
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

  let lastError: Response | undefined;
  let lastRetryAfter: number | undefined;

  for (let i = 0; i < resolutions.length; i++) {
    const resolution = resolutions[i];
    const providerConfig = { ...resolution.providerConfig };

    const response = await tryProviderWithKeyRotation(
      resolution.providerConfig.baseUrl,
      body,
      providerConfig,
      resolution.providerModelName,
      isStreaming,
    );

    if (response.status < 400) {
      if (providerConfig.activeKeyIndex !== resolution.providerConfig.activeKeyIndex) {
        await updateActiveKeyIndex(storage, resolution.provider, providerConfig.activeKeyIndex);
      }
      return response;
    }

    if (providerConfig.activeKeyIndex !== resolution.providerConfig.activeKeyIndex) {
      await updateActiveKeyIndex(storage, resolution.provider, providerConfig.activeKeyIndex);
    }

    lastError = response;
    if (response.status === 429) {
      lastRetryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    }

    if (response.status !== 429) {
      continue;
    }
  }

  if (lastError?.status === 429) {
    return openaiRateLimitError("All providers rate-limited", lastRetryAfter);
  }
  return lastError ?? openaiError("No providers available", 502);
}
