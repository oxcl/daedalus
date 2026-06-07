# 6. SSE streaming passthrough

## What to build

Transparent SSE (Server-Sent Events) streaming for chat completions. When the client sends `stream: true`, the gateway forwards the request to the upstream provider and pipes the SSE stream directly to the client without buffering. Handles three scenarios: tokens forwarded in real time on success, connection error mid-stream fails immediately (no retry — client handles truncation), and error before any tokens are sent allows retry with the next provider.

## Acceptance criteria

- [ ] SSE tokens from upstream are forwarded to client in real time
- [ ] Response `Content-Type` is `text/event-stream`
- [ ] Connection error mid-stream fails immediately (no retry)
- [ ] Error before any tokens are sent allows retry with next provider
- [ ] Non-streaming responses still work correctly
- [ ] Tests cover: successful stream, mid-stream error, error before tokens, content-type header

## Blocked by

- #4 (chat completions proxy)
