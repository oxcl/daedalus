import { describe, it, expect } from "vitest";
import worker from "../src/index";

const API_KEY = "test-key";
const env = { KV: {}, GATEWAY_API_KEY: API_KEY } as any;
const ctx = {} as any;

describe("Worker", () => {
  it("returns 200 with status ok for GET /health", async () => {
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 with OpenAI-compatible error for unknown paths", async () => {
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

  it("returns 404 for /v1 paths (placeholder)", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns correct Content-Type header", async () => {
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, ctx);

    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("Authentication", () => {
  it("returns 401 for request without Authorization header", async () => {
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

  it("passes through to handler with valid key", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("does not require auth for /health", async () => {
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
  });
});
