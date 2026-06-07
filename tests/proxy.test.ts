import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildModelIndex, ProviderConfig } from "../src/config";
import { handleChatCompletions } from "../src/proxy";

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

function makeRequest(
  body: Record<string, unknown>,
): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleChatCompletions", () => {
  it("forwards non-streaming request to upstream provider", async () => {
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex);

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
    await handleChatCompletions(req, modelIndex);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.headers.get("Authorization")).toBe("Bearer sk-openai-1");
  });

  it("forwards to correct upstream URL", async () => {
    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    expect(upstreamReq.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("resolves prefixed model name (openai@o1)", async () => {
    const req = makeRequest({
      model: "openai@o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody.model).toBe("o1-2024-12-17");
  });

  it("resolves generic model name (first provider wins)", async () => {
    const req = makeRequest({
      model: "o1",
      messages: [{ role: "user", content: "Hi" }],
    });
    await handleChatCompletions(req, modelIndex);

    const upstreamReq = fetchSpy.mock.calls[0][0] as Request;
    const upstreamBody = await upstreamReq.json();
    expect(upstreamBody.model).toBe("o1-2024-12-17");
  });

  it("returns 404 in OpenAI error format for unknown model", async () => {
    const req = makeRequest({
      model: "nonexistent-model",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex);

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
    const res = await handleChatCompletions(req, modelIndex);

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 when model field is missing", async () => {
    const req = makeRequest({
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex);

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
    const res = await handleChatCompletions(req, modelIndex);

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    const res = await handleChatCompletions(req, modelIndex);

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
    await handleChatCompletions(req, modelIndex);

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
    const res = await handleChatCompletions(req, modelIndex);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(customResponse);
  });

  it("passes through upstream error status codes", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const req = makeRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });
    const res = await handleChatCompletions(req, modelIndex);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });
});
