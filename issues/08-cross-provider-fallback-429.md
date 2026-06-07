# 8. Cross-provider fallback on 429 exhaustion

## What to build

When all API keys for the primary provider are rate-limited (429), automatically fall back to other configured providers that serve the same model. The gateway tries each fallback provider's keys in order. Returns 429 in OpenAI-compatible error format only when all providers and all keys for the requested model are exhausted. This builds on the sticky key rotation from #7.

## Acceptance criteria

- [ ] Falls back to other providers when primary provider's keys are all rate-limited
- [ ] Tries fallback providers in configuration order
- [ ] Uses sticky key selection within each fallback provider
- [ ] Returns 429 in OpenAI error format only when all providers and keys exhausted
- [ ] Error message indicates all providers are rate-limited
- [ ] Tests cover: primary exhausted + fallback succeeds, all providers exhausted, fallback ordering

## Blocked by

- #7 (sticky key selection and rotation)
