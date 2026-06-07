import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";

const API_KEY = "test-key";
const ctx = {} as any;

function mockKV(entries: Record<string, unknown>) {
  const keys = Object.keys(entries).map((name) => ({ name, list: undefined as never }));
  return {
    list: async ({ prefix }: { prefix: string }) => ({
      keys: keys.filter((k) => k.name.startsWith(prefix)),
      list_complete: true,
      cacheStatus: null,
    }),
    get: async (key: string, type?: string) => {
      if (!(key in entries)) return null;
      const val = entries[key];
      if (type === "json") return val;
      return JSON.stringify(val);
    },
  } as unknown as KVNamespace;
}

const providerConfigs = {
  "provider:openai": {
    apiKeys: ["sk-openai-1"],
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", { name: "o1", providerName: "o1-2024-12-17" }],
    activeKeyIndex: 0,
  },
};

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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(upstreamResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Worker", () => {
  it("returns 200 with status ok for GET /health", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 with OpenAI-compatible error for unknown paths", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/unknown", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("type");
  });

  it("returns correct Content-Type header", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, ctx);

    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("Authentication", () => {
  it("returns 401 for request without Authorization header", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions");
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toEqual({
      message: "Missing Authorization header",
      type: "invalid_request_error",
      code: null,
    });
  });

  it("returns 401 for request with wrong key", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toEqual({
      message: "Invalid API key",
      type: "invalid_request_error",
      code: null,
    });
  });

  it("does not require auth for /health", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
  });
});

describe("Model List", () => {
  it("returns all models with dual naming from a single provider", async () => {
    const kv = mockKV({
      "provider:openai": providerConfigs["provider:openai"],
    });
    const env = { KV: kv, GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data).toEqual([
      { id: "openai@gpt-4o", object: "model", owned_by: "openai" },
      { id: "gpt-4o", object: "model", owned_by: "openai" },
      { id: "openai@o1", object: "model", owned_by: "openai" },
      { id: "o1", object: "model", owned_by: "openai" },
    ]);
  });

  it("deduplicates generic names with first provider winning", async () => {
    const kv = mockKV({
      "provider:openai": providerConfigs["provider:openai"],
      "provider:deepseek": {
        apiKeys: ["sk-ds-1"],
        baseUrl: "https://api.deepseek.com/v1",
        models: ["deepseek-chat", { name: "o1", providerName: "deepseek-o1" }],
        activeKeyIndex: 0,
      },
    });
    const env = { KV: kv, GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      { id: "openai@gpt-4o", object: "model", owned_by: "openai" },
      { id: "gpt-4o", object: "model", owned_by: "openai" },
      { id: "openai@o1", object: "model", owned_by: "openai" },
      { id: "o1", object: "model", owned_by: "openai" },
      { id: "deepseek@deepseek-chat", object: "model", owned_by: "deepseek" },
      { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
      { id: "deepseek@o1", object: "model", owned_by: "deepseek" },
    ]);
  });

  it("returns empty list when no providers configured", async () => {
    const env = { KV: mockKV({}), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("returns models regardless of rate limit state", async () => {
    const kv = mockKV({
      "provider:openai": providerConfigs["provider:openai"],
    });
    const env = { KV: kv, GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();

    expect(body.data.length).toBeGreaterThan(0);
  });
});

describe("Chat Completions Proxy", () => {
  it("returns 404 for unknown model", async () => {
    const env = { KV: mockKV(providerConfigs), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "nonexistent",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 when model field is missing", async () => {
    const env = { KV: mockKV(providerConfigs), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("model field is required");
  });

  it("proxies request to upstream and returns response", async () => {
    const env = { KV: mockKV(providerConfigs), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.id).toBe("chatcmpl-123");
  });

  it("injects provider API key upstream", async () => {
    const env = { KV: mockKV(providerConfigs), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    await worker.fetch(req, env, ctx);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.headers.get("Authorization")).toBe("Bearer sk-openai-1");
  });

  it("resolves prefixed model name", async () => {
    const env = { KV: mockKV(providerConfigs), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai@o1",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    await worker.fetch(req, env, ctx);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody.model).toBe("o1-2024-12-17");
  });

  it("rejects GET requests to /v1/chat/completions", async () => {
    const env = { KV: mockKV(providerConfigs), GATEWAY_API_KEY: API_KEY } as any;
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(404);
  });
});
