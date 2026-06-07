# 2. Provider config loader from KV with model resolution

## What to build

Load provider configurations from Cloudflare KV and build a unified model index. Provider configs are stored at `provider:{name}` and contain `apiKeys`, `baseUrl`, `models` (array of strings or `{name, providerName}` objects), and `activeKeyIndex`. The config module reads all provider entries from KV, parses the models array, and builds a lookup index mapping model names to their providers. Supports both prefixed (`openai@gpt-4o`) and generic (`gpt-4o`) resolution. First configured provider wins for duplicate generic names.

## Acceptance criteria

- [ ] Config loader reads all `provider:*` entries from KV
- [ ] Parses models array supporting both string and `{name, providerName}` object formats
- [ ] Builds a model index mapping generic names to provider configs
- [ ] Supports prefixed model resolution (strip `provider@` prefix, look up in specific provider)
- [ ] Supports generic model resolution (first configured provider wins)
- [ ] Returns clear error for model names not found in any provider
- [ ] Tests cover: mixed model formats, duplicate generic names, prefixed vs generic resolution, missing models

## Blocked by

None — can start immediately.
