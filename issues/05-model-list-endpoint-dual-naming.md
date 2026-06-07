# 5. Model list endpoint with dual naming

## What to build

The `/v1/models` endpoint that aggregates models from all configured providers and returns them in OpenAI-compatible format. Each model appears twice: once with a prefixed name (`openai@gpt-4o`) and once with a generic name (`gpt-4o`). When two providers offer the same generic model name, the first configured provider wins and only its entry appears under the generic name. The endpoint always returns all configured models regardless of rate limit state.

## Acceptance criteria

- [ ] Returns all configured models from all providers
- [ ] Each model appears with both prefixed and generic names
- [ ] Duplicate generic names resolved by first configured provider
- [ ] Response format matches OpenAI `/v1/models` schema
- [ ] Models returned regardless of any rate limit state
- [ ] Tests cover: single provider, multiple providers, duplicate generic names, response format

## Blocked by

- #2 (provider config and model resolution)
