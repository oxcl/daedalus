import { describe, it, expect } from "vitest";
import { authenticateRequest } from "../src/auth";

const API_KEY = "test-key-abc123";

describe("authenticateRequest", () => {
  it("returns 401 Response when Authorization header is missing", () => {
    const req = new Request("http://localhost/v1/chat/completions");
    const result = authenticateRequest(req, API_KEY);

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
  });

  it("returns OpenAI-compatible error format for missing header", async () => {
    const req = new Request("http://localhost/v1/chat/completions");
    const res = authenticateRequest(req, API_KEY) as Response;
    const body = await res.json();

    expect(body).toEqual({
      error: {
        message: "Missing Authorization header",
        type: "invalid_request_error",
        code: null,
      },
    });
  });

  it("returns 401 Response when key is wrong", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const result = authenticateRequest(req, API_KEY);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("returns OpenAI-compatible error format for wrong key", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const res = authenticateRequest(req, API_KEY) as Response;
    const body = await res.json();

    expect(body).toEqual({
      error: {
        message: "Invalid API key",
        type: "invalid_request_error",
        code: null,
      },
    });
  });

  it("returns stripped Request when key is valid", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const result = authenticateRequest(req, API_KEY);

    expect(result).toBeInstanceOf(Request);
    const stripped = result as Request;
    expect(stripped.headers.get("Authorization")).toBeNull();
  });

  it("preserves other headers on valid authentication", () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "X-Custom": "value",
      },
    });
    const stripped = authenticateRequest(req, API_KEY) as Request;

    expect(stripped.headers.get("Content-Type")).toBe("application/json");
    expect(stripped.headers.get("X-Custom")).toBe("value");
    expect(stripped.headers.get("Authorization")).toBeNull();
  });
});
