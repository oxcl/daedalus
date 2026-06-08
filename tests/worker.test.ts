import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchHandler } from "../src/index";
import { Storage } from "../src/storage";
import { ProviderConfig } from "../src/config";

function mockStorage(
  providerConfigs?: Record<string, ProviderConfig>
): Storage {
  const configs = new Map<string, ProviderConfig>(
    providerConfigs ? Object.entries(providerConfigs) : []
  );

  return {
    async listConfigs() {
      return new Map(configs);
    },
    async getConfig(provider: string) {
      return configs.get(provider) || null;
    },
    async putConfig(provider: string, config: ProviderConfig) {
      configs.set(provider, config);
    },
    async getKeys() {
      return null;
    },
    async putKeys() {},
  };
}

const providerConfigs: Record<string, ProviderConfig> = {
  "openai": {
    apiKeys: ["sk-openai-1"],
    baseUrls: ["https://api.openai.com/v1"],
    models: [
      { name: "gpt-4o", providerName: "gpt-4o" },
      { name: "o1", providerName: "o1-2024-12-17" },
    ],
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
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Worker", () => {
  it("returns 200 with status ok for GET /health", async () => {
    const storage = mockStorage();
    const req = new Request("http://localhost/health");
    const res = await fetchHandler(req, storage);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 with OpenAI-compatible error for unknown paths", async () => {
    const storage = mockStorage();
    const req = new Request("http://localhost/unknown");
    const res = await fetchHandler(req, storage);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("type");
  });

  it("returns correct Content-Type header", async () => {
    const storage = mockStorage();
    const req = new Request("http://localhost/health");
    const res = await fetchHandler(req, storage);

    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("Model List", () => {
  it("returns all models with dual naming from a single provider", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/models");
    const res = await fetchHandler(req, storage);
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
    const storage = mockStorage({
      "openai": providerConfigs["openai"],
      "deepseek": {
        apiKeys: ["sk-ds-1"],
        baseUrls: ["https://api.deepseek.com/v1"],
        models: [
          { name: "deepseek-chat", providerName: "deepseek-chat" },
          { name: "o1", providerName: "deepseek-o1" },
        ],
        activeKeyIndex: 0,
      },
    });
    const req = new Request("http://localhost/v1/models");
    const res = await fetchHandler(req, storage);
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
    const storage = mockStorage();
    const req = new Request("http://localhost/v1/models");
    const res = await fetchHandler(req, storage);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("returns models regardless of rate limit state", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/models");
    const res = await fetchHandler(req, storage);
    const body = await res.json();

    expect(body.data.length).toBeGreaterThan(0);
  });
});

describe("Chat Completions Proxy", () => {
  it("returns 404 for unknown model", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nonexistent",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await fetchHandler(req, storage);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 when model field is missing", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await fetchHandler(req, storage);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("model field is required");
  });

  it("proxies request to upstream and returns response", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const res = await fetchHandler(req, storage);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.id).toBe("chatcmpl-123");
  });

  it("injects provider API key upstream", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    await fetchHandler(req, storage);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.headers.get("Authorization")).toBe("Bearer sk-openai-1");
  });

  it("resolves prefixed model name", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai@o1",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    await fetchHandler(req, storage);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody.model).toBe("o1-2024-12-17");
  });

  it("rejects GET requests to /v1/chat/completions", async () => {
    const storage = mockStorage(providerConfigs);
    const req = new Request("http://localhost/v1/chat/completions");
    const res = await fetchHandler(req, storage);

    expect(res.status).toBe(404);
  });
});
