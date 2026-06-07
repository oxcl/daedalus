# 4. Chat completions proxy with single-provider forwarding

## What to build

The core chat completions proxy: accept requests at `/v1/chat/completions`, resolve the model name, forward the request to the appropriate upstream provider, and proxy the response back. Handles model resolution (prefixed `openai@o1` → strip prefix → resolve via model map; generic `gpt-4o` → first provider wins), injects the provider's API key, forwards the full request body (temperature, messages, tools, stream options, etc.) unchanged, and returns the upstream response. Returns 404 in OpenAI format for unknown models. Supports both streaming and non-streaming modes.

## Acceptance criteria

- [ ] Forwards non-streaming chat completion request to upstream provider
- [ ] Proxies full request body (all fields preserved except model name resolution)
- [ ] Resolves prefixed model names (`openai@o1` → strips prefix, looks up in provider's model map)
- [ ] Resolves generic model names (first configured provider wins)
- [ ] Injects provider's API key in upstream request Authorization header
- [ ] Returns 404 in OpenAI error format for unknown model names
- [ ] Validates model field is present before forwarding
- [ ] Tests cover: successful proxy, model resolution both modes, unknown model, request body passthrough

## Blocked by

- #2 (provider config and model resolution)
- #3 (authentication)
