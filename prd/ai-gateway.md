# Daedalus AI Gateway — PRD

## Problem Statement

AI coding agents like OpenCode and Pi need to interact with multiple LLM providers (OpenAI, DeepSeek, Groq, etc.), each with its own API keys, rate limits, and model naming conventions. Managing provider keys, handling rate limit rotations, and providing a unified model catalog across providers is a burden that falls on each agent or user individually. There is no single proxy that aggregates OpenAI-compatible providers, rotates API keys on rate limit failures, and presents a unified `/v1/models` and `/v1/chat/completions` interface.

## Solution

Deploy a Cloudflare Worker that acts as an OpenAI-compatible AI gateway. The gateway:

- Exposes `/v1/models` (aggregated model list) and `/v1/chat/completions` (proxied completion) endpoints, plus a `/health` check
- Stores provider configurations (base URLs, multiple API keys, model mappings) in Cloudflare KV
- Authenticates clients via a single gateway API key
- Routes requests to the appropriate provider, injecting the provider's API key upstream
- Uses sticky key selection per provider (same key until it fails, then rotates)
- On 429 rate limit responses, respects `Retry-After` header, rotates to next key in same provider, then falls back to other providers that serve the same model
- On non-429 errors, retries across providers before returning an error
- Returns all errors in OpenAI-compatible error format
- Supports full SSE streaming for chat completions
- Presents models in dual naming: both prefixed (`openai@gpt-4o`) and generic (`gpt-4o`) in the model list

## User Stories

1. As an AI coding agent operator, I want to configure multiple LLM providers with multiple API keys in a single KV store, so that I can manage all provider credentials in one place without redeploying the gateway
2. As an AI coding agent operator, I want the gateway to present a unified `/v1/models` endpoint that aggregates models from all configured providers, so that agents can discover available models without knowing provider details
3. As an AI coding agent operator, I want the gateway to present models in both prefixed (`openai@gpt-4o`) and generic (`gpt-4o`) form, so that I can be explicit about provider selection or let the gateway choose
4. As an AI coding agent operator, I want the first configured provider to win when two providers offer the same generic model name, so that routing behavior is predictable
5. As an AI coding agent operator, I want the gateway to authenticate clients with a single gateway API key via `Authorization: Bearer` header, so that only authorized clients can use the proxy
6. As an AI coding agent, I want to send `model: "openai@o1"` and have the gateway strip the prefix and resolve the model name via the provider's model map, so that I can target a specific provider or let the gateway pick
7. As an AI coding agent, I want to send `model: "gpt-4o"` (generic) and have the gateway route to the first configured provider that offers it, so that I don't need to know provider details
8. As an AI coding agent, I want the gateway to forward my chat completion request body as-is (except for model name resolution), so that all parameters like temperature, messages, tools, and stream options are preserved
9. As an AI coding agent, I want the gateway to stream SSE responses transparently from the upstream provider, so that I receive tokens in real time without buffering
10. As an AI coding agent, I want the gateway to use a sticky API key per provider (same key until it fails), so that requests are consistent and I don't unnecessarily cycle through keys
11. As an AI coding agent, I want the gateway to rotate to the next API key in the same provider when a key returns 429, so that I can continue working without manual intervention
12. As an AI coding agent, I want the gateway to respect the `Retry-After` header from the upstream provider when rotating keys, so that cooldown periods are provider-appropriate
13. As an AI coding agent, I want the gateway to fall back to other providers that serve the same model when all keys for the primary provider are rate-limited, so that I can continue working even if one provider is exhausted
14. As an AI coding agent, I want the gateway to return a 429 error in OpenAI format only when all providers and all keys for a model are rate-limited, so that I can handle the error appropriately
15. As an AI coding agent, I want the gateway to retry non-429 errors (400, 500, etc.) across providers, so that transient failures on one provider don't block my request
16. As an AI coding agent, I want the gateway to return all errors in OpenAI-compatible error format (`{"error": {"message": "...", "type": "...", "code": "..."}}`), so that my error handling code works consistently regardless of provider
17. As an AI coding agent, I want the gateway to return a 404 error when I request a model that doesn't exist in any configured provider, so that I know the model name is wrong
18. As an AI coding agent, I want the gateway to fail immediately on streaming errors (connection drops mid-stream), so that I can handle the truncation without waiting for a timeout
19. As an AI coding agent, I want the gateway to retry with another provider before any tokens are streamed if the first provider fails, so that I get a complete response when possible
20. As an AI coding agent, I want the gateway to timeout after 10 seconds of receiving no response bytes from the upstream, so that hung providers don't block my request indefinitely
21. As a gateway operator, I want to configure provider models as a mix of strings and `{name, providerName}` objects in KV, so that I can map gateway-facing names to provider-specific model identifiers
22. As a gateway operator, I want the `/v1/models` endpoint to always return all configured models regardless of rate limit state, so that the model catalog is stable and predictable
23. As a gateway operator, I want basic console.log output of routing decisions (which provider/key was selected, errors encountered), so that I can debug issues using `wrangler tail`
24. As a gateway operator, I want a `/health` endpoint that returns `{"status":"ok"}`, so that I can monitor the gateway's availability
25. As a gateway operator, I want zero external dependencies in the gateway code, so that the deployment is simple and there are no supply chain risks
26. As a gateway operator, I want to manage provider configurations via `wrangler kv:key put` commands, so that I can add, remove, or update providers without redeploying the worker
27. As an AI coding agent, I want the gateway to handle the `model` field validation before forwarding to any provider, so that obviously invalid requests fail fast with a clear error
28. As an AI coding agent, I want the gateway to pass through all other request body fields (temperature, max_tokens, tools, stream_options, etc.) unchanged, so that provider-specific features are not blocked by the proxy
29. As an AI coding agent, I want the gateway to handle both streaming (`stream: true`) and non-streaming (`stream: false`) requests, so that I can use the mode appropriate for my use case
30. As a gateway operator, I want the active key index to be stored in the same KV entry as the provider config, so that there is a single source of truth and only one KV read is needed per request

## Implementation Decisions

### Architecture

- The gateway is a single Cloudflare Worker with zero external npm dependencies
- Uses native `fetch()` for proxying upstream requests
- Uses Cloudflare KV for provider configuration storage
- Uses Cloudflare Workers module syntax (ESM)

### Modules

The implementation is divided into these modules:

- **Router**: URL path matching and request dispatch. Routes `/health`, `/v1/models`, `/v1/chat/completions`. Returns 404 for unknown paths.
- **Config**: Loads provider configurations from KV. Parses the `models` array supporting both string and `{name, providerName}` object formats.
- **Providers**: Provider selection logic, sticky key management, key rotation on failure, cross-provider fallback.
- **OpenAI Client**: Upstream HTTP client for OpenAI-compatible providers. Handles request forwarding, response streaming (SSE), error extraction, and timeout enforcement.
- **Rate Limit**: Detects 429 responses, parses `Retry-After` header, stores cooldown state, manages key rotation triggers.
- **Handlers**: Request handlers for `/v1/models` (aggregation) and `/v1/chat/completions` (proxy with retry loop).

### KV Schema

Provider config stored at `provider:{name}`:

```json
{
  "apiKeys": ["sk-key1", "sk-key2"],
  "baseUrl": "https://api.openai.com/v1",
  "models": [
    "gpt-4o",
    { "name": "o1", "providerName": "o1-2024-12-17" }
  ],
  "activeKeyIndex": 0
}
```

- `apiKeys` — array of API keys for this provider
- `baseUrl` — upstream OpenAI-compatible API base URL
- `models` — either strings (name = providerName) or `{name, providerName}` objects
- `activeKeyIndex` — tracks the currently active key, updated on failures

### Model Resolution Chain

1. Client sends `model: "openai@o1"`
2. Gateway validates model field is present (404 if model not found in any provider)
3. Strip `provider@` prefix → `o1`
4. Look up `o1` in the identified provider's model map → resolves to `providerName: "o1-2024-12-17"`
5. Send `model: "o1-2024-12-17"` to the upstream provider

For generic names (e.g. `model: "gpt-4o"`):
1. Gateway scans all providers for a model with `name: "gpt-4o"`
2. First configured provider wins
3. Resolves via that provider's model map
4. Sends to that provider

### Routing and Retry Logic

**Non-streaming requests:**
1. Select provider by model name resolution
2. Use sticky key (`activeKeyIndex`)
3. Forward request
4. On 429: respect `Retry-After` header (default 60s if absent), rotate to next key in same provider, if all keys exhausted try other providers with same model, if all fail return 429 in OpenAI format
5. On other errors: try other providers with same model, if all fail return last error in OpenAI format

**Streaming requests:**
1. Forward request and begin streaming response
2. On connection error mid-stream: fail immediately (no retry)
3. Before any tokens are sent: can retry with next provider

### Authentication

- Gateway requires `Authorization: Bearer {GATEWAY_API_KEY}` header
- `GATEWAY_API_KEY` is set as an environment variable in `.dev.vars` (local) and Cloudflare dashboard (production)
- Gateway strips the client's auth header and injects the provider's API key when forwarding upstream

### Timeout

- 10-second idle timeout (no bytes received from upstream)
- No hard cap on streaming duration (Cloudflare Worker limits apply)

### Model List Behavior

- `/v1/models` always returns all configured models regardless of rate limit state
- Includes both prefixed and generic names for each model
- First configured provider wins for duplicate generic names

### Error Format

All errors returned in OpenAI format:

```json
{
  "error": {
    "message": "Model 'xyz' not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### Logging

- Basic `console.log` for routing decisions: provider selected, key index, errors encountered
- Viewable via `wrangler tail`

### Admin

- No admin API
- Provider management via `wrangler kv:key put` CLI commands
- KV namespace binding configured in `wrangler.toml`

## Testing Decisions

### Test Philosophy

Tests should verify external behavior (request routing, response format, error handling) rather than implementation details (internal state, KV read counts). The gateway is tested as a black box: send HTTP requests, assert on HTTP responses.

### Testing Approach

- Use Vitest with Cloudflare Workers test utilities (`@cloudflare/vitest-pool-workers`)
- Mock KV responses to simulate provider configurations
- Mock upstream provider responses to simulate success, 429, 500, and streaming scenarios
- Test the full request lifecycle through the worker's `fetch` handler

### Key Test Scenarios

1. **`/health` endpoint** — returns `{"status":"ok"}` with 200 status
2. **`/v1/models` with multiple providers** — aggregated list includes both prefixed and generic names
3. **`/v1/models` with duplicate generic names** — first configured provider wins
4. **`/v1/chat/completions` successful non-streaming** — request forwarded, response proxied
5. **`/v1/chat/completions` successful streaming** — SSE tokens forwarded correctly
6. **`/v1/chat/completions` with prefixed model** — prefix stripped, model map resolved
7. **`/v1/chat/completions` with generic model** — first configured provider selected
8. **`/v1/chat/completions` unknown model** — 404 returned in OpenAI format
9. **`/v1/chat/completions` 429 with Retry-After** — key rotated, Retry-After respected
10. **`/v1/chat/completions` 429 all keys exhausted** — falls back to other providers
11. **`/v1/chat/completions` 429 all providers exhausted** — returns 429 in OpenAI format
12. **`/v1/chat/completions` non-429 error** — retries across providers
13. **`/v1/chat/completions` all providers fail** — returns last error in OpenAI format
14. **`/v1/chat/completions` streaming error mid-stream** — fails immediately
15. **`/v1/chat/completions` streaming error before tokens** — retries with next provider
16. **`/v1/chat/completions` idle timeout** — 10s timeout triggers retry
17. **Authentication missing** — 401 returned
18. **Authentication wrong key** — 401 returned
19. **Unknown path** — 404 returned
20. **Sticky key behavior** — same key used across requests until failure
21. **Key rotation on failure** — activeKeyIndex incremented in KV

### Prior Art

- Cloudflare Workers testing follows the pattern established by `@cloudflare/vitest-pool-workers`
- No existing tests in the codebase (greenfield project)

## Out of Scope

- Admin API for managing providers via HTTP endpoints
- CORS headers (not needed for CLI agent use cases)
- Legacy `/v1/completions` endpoint
- `/v1/embeddings` endpoint
- Dynamic model discovery from provider `/v1/models` endpoints
- Proactive rate limit tracking (only reactive 429 detection)
- Request logging to external systems (only console.log)
- Authentication via provider-specific headers (only `Authorization: Bearer`)
- Rate limiting on the gateway side (per-client quotas)
- Request body transformation beyond model name resolution
- Support for non-OpenAI-compatible providers (e.g. Anthropic native API, Google native API)

## Further Notes

- The gateway is designed for AI coding agents (OpenCode, Pi) as the primary consumers
- Provider configuration is manual via `wrangler kv:key put` — no dynamic config
- The `provider@model` syntax uses `@` (not `/`) to avoid conflicts with provider namespacing conventions
- Zero external npm dependencies — only native Cloudflare Workers APIs
- The project is greenfield (empty Cloudflare Workers scaffold) so no migration or backward compatibility concerns
