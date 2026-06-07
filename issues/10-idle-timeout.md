# 10. Idle timeout (10s no bytes)

## What to build

Enforce a 10-second idle timeout on upstream requests: if no bytes are received from the upstream provider for 10 seconds, abort the request and retry with the next available provider. This prevents hung providers from blocking requests indefinitely. The timeout resets each time bytes are received, so long-running streams are not affected. No hard cap on total streaming duration (Cloudflare Worker limits apply).

## Acceptance criteria

- [ ] Aborts upstream request if no bytes received for 10 seconds
- [ ] Timeout resets on each chunk received (streaming not affected)
- [ ] On timeout, retries with next available provider
- [ ] If no more providers, returns 504 or last error in OpenAI format
- [ ] Non-streaming requests also subject to idle timeout
- [ ] Tests cover: timeout triggers retry, streaming resets timeout, all providers timeout

## Blocked by

- #4 (chat completions proxy)
