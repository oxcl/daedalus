# 7. Sticky key selection and rotation on 429

## What to build

Key management per provider: use `activeKeyIndex` from the KV config entry to select the API key (sticky — same key across requests until failure). On a 429 response from upstream, respect the `Retry-After` header (default 60s if absent), rotate `activeKeyIndex` to the next key in the same provider, and retry with the new key. Return 429 in OpenAI error format only when all keys for the provider are exhausted. The `activeKeyIndex` is stored in the same KV entry as the provider config so only one KV read is needed per request.

## Acceptance criteria

- [ ] Same API key used across requests until a failure occurs
- [ ] On 429, respects `Retry-After` header (default 60s if absent)
- [ ] On 429, rotates to next API key in same provider
- [ ] Updates `activeKeyIndex` in KV after rotation
- [ ] Returns 429 in OpenAI error format when all keys exhausted
- [ ] Only one KV read per request (config + activeKeyIndex in same entry)
- [ ] Tests cover: sticky key behavior, rotation on 429, Retry-After parsing, all keys exhausted, KV update

## Blocked by

- #4 (chat completions proxy)
