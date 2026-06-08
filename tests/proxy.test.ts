import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildModelIndex, ProviderConfig } from "../src/config";
import { handleChatCompletions, setDelayFn, resetDelayFn, setTimerFn, resetTimerFn, IDLE_TIMEOUT_MS } from "../src/proxy";
import { Storage } from "../src/storage";

function mockStorage(
  entries?: Record<string, ProviderConfig>
): Storage {
  const configs = new Map<string, ProviderConfig>(
    entries ? Object.entries(entries) : []
  );
  const keysMap = new Map<string, { apiKeys: string[]; activeKeyIndex: number }>();

  return {
    async listConfigs() {
      return new Map(configs);
    },
    async getConfig(provider: string) {
      return configs.get(provider) || null;
    },
    async putConfig(provider: string, config: ProviderConfig) {
      configs.set(provider, config);
      if (!keysMap.has(provider)) {
        keysMap.set(provider, { apiKeys: config.apiKeys, activeKeyIndex: config.activeKeyIndex });
      }
    },
    async getKeys(provider: string) {
      return keysMap.get(provider) || null;
    },
    async putKeys(provider: string, apiKeys: string[], activeKeyIndex: number) {
      keysMap.set(provider, { apiKeys, activeKeyIndex });
    },
  };
}

const openaiConfig: ProviderConfig = {
  apiKeys: ["sk-openai-1", "sk-openai-2"],
  baseUrl: "https://api.openai.com/v1",
  models: [
    { name: "gpt-4o", providerName: "gpt-4o" },
    { name: "o1", providerName: "o1-2024-12-17" },
  ],
  activeKeyIndex: 0,
};

const deepseekConfig: ProviderConfig = {
  apiKeys: ["sk-ds-1"],
  baseUrl: "https://api.deepseek.com/v1",
  models: [
    { name: "deepseek-chat", providerName: "deepseek-chat" },
    { name: "o1", providerName: "deepseek-o1" },
  ],
  activeKeyIndex: 0,
};

const configs = new Map([
  ["openai", openaiConfig],
  ["deepseek", deepseekConfig],
]);
const modelIndex = buildModelIndex(configs);

const upstreamResponse = {
  id: "chatcmpl-123",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;
let delaySpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(upstreamResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

  delaySpy = vi.fn().mockResolvedValue(undefined);
  setDelayFn(delaySpy as unknown as (ms: number) => Promise<void>);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDelayFn();
  resetTimerFn();
  vi.restoreAllMocks();
});

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeStorage() {
  return mockStorage({
    openai: { ...openaiConfig },
    deepseek: { ...deepseekConfig },
  });
}

describe("handleChatCompletions", () => {
  it("forwards non-streaming request to upstream provider", async () => {
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body).toEqual(upstreamResponse);
  });

  it("injects provider API key in upstream Authorization header", async () => {
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex, makeStorage());

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.headers.get("Authorization")).toBe("Bearer sk-openai-1");
  });

  it("forwards to correct upstream URL", async () => {
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex, makeStorage());

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("resolves prefixed model name (openai@o1)", async () => {
    const req = makeRequest({
      model: "openai@o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex, makeStorage());

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody.model).toBe("o1-2024-12-17");
  });

  it("resolves generic model name (first provider wins)", async () => {
    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex, makeStorage());

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody.model).toBe("o1-2024-12-17");
  });

  it("returns 404 in OpenAI error format for unknown model", async () => {
    const req = makeRequest({
      model: "nonexistent-model",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("nonexistent-model");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown provider prefix", async () => {
    const req = makeRequest({
      model: "unknown@gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when model field is missing", async () => {
    const req = makeRequest({
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("model field is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when model field is empty string", async () => {
    const req = makeRequest({
      model: "",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid JSON in request body");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves all request body fields except model", async () => {
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
      max_tokens: 100,
      tools: [{ type: "function", function: { name: "test" } }],
      stream: true,
    });
    await handleChatCompletions(req, modelIndex, makeStorage());

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
      max_tokens: 100,
      tools: [{ type: "function", function: { name: "test" } }],
      stream: true,
    });
  });

  it("passes through upstream response unchanged", async () => {
    const customResponse = {
      id: "chatcmpl-custom",
      choices: [{ index: 0, message: { role: "assistant", content: "Custom" }, finish_reason: "stop" }],
    };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(customResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(customResponse);
  });

  it("passes through upstream error status codes", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });
});

describe("SSE streaming passthrough", () => {
  const sseBody = [
    "data: {\"id\":\"chatcmpl-stream\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}",
    "",
    "data: {\"id\":\"chatcmpl-stream\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"finish_reason\":null}]}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  it("forwards SSE stream with correct Content-Type", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sseBody);
  });

  it("pipes SSE stream directly without buffering", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: token1\n\n"));
        controller.enqueue(new TextEncoder().encode("data: token2\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks).toEqual([
      "data: token1\n\n",
      "data: token2\n\n",
      "data: [DONE]\n\n",
    ]);
  });

  it("fails immediately on mid-stream connection error (no retry)", async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: token1\n\n"));
            controller.error(new Error("connection lost"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("should not reach", { status: 200 });
    });

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    await expect(reader.read()).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("retries with next provider on error before tokens", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Overloaded", type: "server_error" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstReq = fetchSpy.mock.calls[0][0] as Request;
    expect(firstReq.url).toBe("https://api.openai.com/v1/chat/completions");
    const secondReq = fetchSpy.mock.calls[1][0] as Request;
    expect(secondReq.url).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("retries on connection error before any response", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns error when all providers fail for streaming request", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Overloaded", type: "server_error" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Overloaded", type: "server_error" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.type).toBe("server_error");
  });

  it("non-streaming responses still work correctly", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual(upstreamResponse);
  });

  it("retries on error before tokens for non-streaming requests", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Overloaded", type: "server_error" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body).toEqual(upstreamResponse);
  });
});

describe("Sticky key selection", () => {
  it("uses activeKeyIndex from config to select API key", async () => {
    const kvConfigs = new Map([
      ["openai", { ...openaiConfig, activeKeyIndex: 1 }],
      ["deepseek", { ...deepseekConfig }],
    ]);
    const kvModelIndex = buildModelIndex(kvConfigs);
    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 1 },
    });
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, kvModelIndex, storage);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.headers.get("Authorization")).toBe("Bearer sk-openai-2");
  });

  it("uses same key across multiple requests until failure", async () => {
    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(upstreamResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );

    const req1 = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const req2 = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const req3 = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });

    await handleChatCompletions(req1, modelIndex, storage);
    await handleChatCompletions(req2, modelIndex, storage);
    await handleChatCompletions(req3, modelIndex, storage);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const call of fetchSpy.mock.calls) {
      const upstreamReq = call[0] as Request;
      expect(upstreamReq.headers.get("Authorization")).toBe("Bearer sk-openai-1");
    }
  });
});

describe("429 key rotation", () => {
  it("rotates to next key on 429 and retries", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstReq = fetchSpy.mock.calls[0][0] as Request;
    expect(firstReq.headers.get("Authorization")).toBe("Bearer sk-openai-1");

    const secondReq = fetchSpy.mock.calls[1][0] as Request;
    expect(secondReq.headers.get("Authorization")).toBe("Bearer sk-openai-2");
  });

  it("rotates immediately on 429 without delay", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "30",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex, storage);

    expect(delaySpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("updates activeKeyIndex in storage after rotation", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex, storage);

    const storedKeys = await storage.getKeys("openai");
    expect(storedKeys?.activeKeyIndex).toBe(1);
  });

  it("returns 429 in OpenAI error format when all keys exhausted", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "45",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "30",
            },
          },
        ),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(delaySpy).not.toHaveBeenCalled();
  });

  it("returns 429 when all keys exhausted for single-key provider", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const storage = mockStorage({
      deepseek: { ...deepseekConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("returns 429 with all-providers message when all providers exhausted", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "45",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "30",
            },
          },
        ),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
      deepseek: { ...deepseekConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("All providers rate-limited");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("falls through to next provider after all keys exhausted", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
      deepseek: { ...deepseekConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const thirdReq = fetchSpy.mock.calls[2][0] as Request;
    expect(thirdReq.url).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("streams on 429 from upstream before tokens are sent", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          "data: {\"id\":\"chatcmpl-stream\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n",
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("Non-429 error retry across providers", () => {
  it("retries with next provider on 500 error and succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Internal server error", type: "server_error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body).toEqual(upstreamResponse);
  });

  it("retries with next provider on 502 error and succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Bad gateway", type: "server_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries with next provider on 400 error and succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Bad request", type: "invalid_request_error" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns last error when all providers fail with non-429 errors", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "OpenAI overloaded", type: "server_error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "DeepSeek overloaded", type: "server_error" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toBe("DeepSeek overloaded");
    expect(body.error.type).toBe("server_error");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves error status code and message from last provider", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "First provider error", type: "server_error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Second provider error", type: "server_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toBe("Second provider error");
  });

  it("does not retry on 429 - follows separate rotation logic", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const storage = mockStorage({
      openai: { ...openaiConfig, activeKeyIndex: 0 },
    });

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, storage);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondReq = fetchSpy.mock.calls[1][0] as Request;
    expect(secondReq.headers.get("Authorization")).toBe("Bearer sk-openai-2");
  });

  it("retries on connection error with next provider", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(upstreamResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns error when single provider fails with non-429 error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Bad request", type: "invalid_request_error" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = makeRequest({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Bad request");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips providers already attempted", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Server error", type: "server_error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Server error", type: "server_error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());

    expect(res.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstReq = fetchSpy.mock.calls[0][0] as Request;
    const secondReq = fetchSpy.mock.calls[1][0] as Request;
    expect(firstReq.url).not.toBe(secondReq.url);
  });
});

describe("Idle timeout", () => {
  let timers: Map<number, () => void>;
  let nextTimerId: number;
  let timerFnSpy: ReturnType<typeof vi.fn>;
  let clearFnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    timers = new Map();
    nextTimerId = 1;

    timerFnSpy = vi.fn((fn: () => void) => {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    });

    clearFnSpy = vi.fn((id: unknown) => {
      timers.delete(id as number);
    });

    setTimerFn(
      timerFnSpy as unknown as (callback: () => void, ms: number) => ReturnType<typeof setTimeout>,
      clearFnSpy as unknown as (id: ReturnType<typeof setTimeout>) => void,
    );
  });

  afterEach(() => {
    resetTimerFn();
    timers.clear();
    vi.restoreAllMocks();
  });

  function fireAllTimers(): void {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  }

  it("aborts non-streaming request after idle timeout and retries next provider", async () => {
    const signals: AbortSignal[] = [];
    let callCount = 0;
    fetchSpy.mockImplementation(async (_req: Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      callCount++;
      if (callCount === 1) {
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      return new Response(JSON.stringify(upstreamResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });

    const promise = handleChatCompletions(req, modelIndex, makeStorage());
    await new Promise((r) => setTimeout(r, 0));

    fireAllTimers();
    await new Promise((r) => setTimeout(r, 0));

    expect(signals[0]?.aborted).toBe(true);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const secondReq = fetchSpy.mock.calls[1][0] as Request;
    expect(secondReq.url).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("streaming: fires idle timeout when no chunks arrive", async () => {
    const hangingStream = new ReadableStream({
      start() {
        // never enqueue — simulates hung provider
      },
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(hangingStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const readPromise = reader.read();
    await new Promise((r) => setTimeout(r, 0));

    fireAllTimers();
    await expect(readPromise).rejects.toThrow();
  });

  it("streaming: resets timeout on each chunk received", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: token1\n\n"));
        controller.enqueue(new TextEncoder().encode("data: token2\n\n"));
        controller.enqueue(new TextEncoder().encode("data: token3\n\n"));
        controller.close();
      },
    });

    fetchSpy.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const res = await handleChatCompletions(req, modelIndex, makeStorage());
    const reader = res.body!.getReader();

    const chunk1 = await reader.read();
    expect(chunk1.done).toBe(false);
    expect(new TextDecoder().decode(chunk1.value)).toBe("data: token1\n\n");

    const chunk2 = await reader.read();
    expect(chunk2.done).toBe(false);

    const chunk3 = await reader.read();
    expect(chunk3.done).toBe(false);

    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it("returns last error when all providers timeout (non-streaming)", async () => {
    fetchSpy.mockImplementation(async (_req: Request, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });

    const promise = handleChatCompletions(req, modelIndex, makeStorage());
    await new Promise((r) => setTimeout(r, 0));

    fireAllTimers();
    await new Promise((r) => setTimeout(r, 0));
    fireAllTimers();
    await new Promise((r) => setTimeout(r, 0));

    const res = await promise;

    expect(res.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns 502 in OpenAI error format when single provider times out", async () => {
    fetchSpy.mockImplementation(async (_req: Request, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const req = makeRequest({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "Hi" }],
    });

    const promise = handleChatCompletions(req, modelIndex, makeStorage());
    await new Promise((r) => setTimeout(r, 0));

    fireAllTimers();
    await new Promise((r) => setTimeout(r, 0));

    const res = await promise;

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
