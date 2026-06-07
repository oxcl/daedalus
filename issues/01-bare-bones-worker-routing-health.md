# 1. Bare-bones Worker with routing and health check

## What to build

Set up the foundational Cloudflare Worker with URL path matching and a `/health` endpoint. The worker should route requests to `/health`, `/v1/*` paths, and return 404 for unknown paths. The `/health` endpoint returns `{"status":"ok"}` with 200 status. This establishes the project structure: `Env` interface with KV namespace binding, wrangler.toml configuration, and the router pattern that all subsequent slices build on.

## Acceptance criteria

- [ ] Worker responds to `GET /health` with 200 and `{"status":"ok"}`
- [ ] Unknown paths return 404 with OpenAI-compatible error format
- [ ] `/v1/*` paths are recognized (handler placeholder is fine)
- [ ] `Env` interface includes KV namespace binding type
- [ ] `wrangler.toml` configures the KV namespace binding
- [ ] Tests verify health endpoint, 404 for unknown paths, and correct status codes

## Blocked by

None — can start immediately.
