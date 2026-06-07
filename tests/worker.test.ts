import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

const env = { KV: {} as KVNamespace } as Env;

describe("Worker", () => {
  it("returns 200 with status ok for GET /health", async () => {
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 with OpenAI-compatible error for unknown paths", async () => {
    const req = new Request("http://localhost/unknown");
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("type");
  });

  it("returns 404 for /v1 paths (placeholder)", async () => {
    const req = new Request("http://localhost/v1/chat/completions");
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns correct Content-Type header", async () => {
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, env, {} as ExecutionContext);

    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
