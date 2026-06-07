# 3. Gateway authentication via Bearer token

## What to build

Authentication middleware that validates the `Authorization: Bearer {GATEWAY_API_KEY}` header on all requests. The gateway API key is provided via environment variable (`GATEWAY_API_KEY`), set in `.dev.vars` for local development and Cloudflare dashboard for production. Requests missing the header or with an invalid key receive a 401 response in OpenAI-compatible error format. On success, the auth header is stripped before forwarding upstream.

## Acceptance criteria

- [ ] Request without `Authorization` header returns 401 with OpenAI error format
- [ ] Request with wrong key returns 401 with OpenAI error format
- [ ] Request with valid key passes through to handler
- [ ] Auth header is not forwarded to upstream providers
- [ ] `GATEWAY_API_KEY` read from environment variable
- [ ] Tests cover: missing header, wrong key, valid key, header stripping

## Blocked by

None — can start immediately.
