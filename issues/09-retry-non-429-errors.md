# 9. Retry across providers for non-429 errors

## What to build

On non-429 upstream errors (400, 500, 502, etc.), retry the request with the next available provider that serves the same model. If all providers fail, return the last error received in OpenAI-compatible error format. This ensures transient failures on one provider don't block the request when alternatives are available.

## Acceptance criteria

- [ ] On non-429 error, retries with next provider serving the same model
- [ ] Skips providers already attempted in the current request
- [ ] Returns last error in OpenAI error format when all providers fail
- [ ] Error preserves the original status code and message from upstream
- [ ] Does not interfere with 429 handling (429 follows its own rotation logic)
- [ ] Tests cover: first provider fails + second succeeds, all fail, error format preserved, no double-retry on 429

## Blocked by

- #4 (chat completions proxy)
