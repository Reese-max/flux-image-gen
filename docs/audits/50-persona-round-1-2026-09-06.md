# 50-Persona Audit — Round 1

Date: 2026-09-06
Protocol: `Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`

> Fixed 50-persona model simulation plus repository evidence review; not 50 human participants. No live/provider path is marked passed without execution evidence.

## Round 1 result

Status: **P1 OPEN — NOT CLEAN**

### P1 — production abuse controls can fail open

The Cloudflare deployment uses server-side provider credentials and a rate-limit binding, but the current policy is not fail-closed:

- `cloudflare/wrangler.toml` defaults `TURNSTILE_REQUIRED = "false"` while noting public deployments should enable it.
- `cloudflare/src/http.js::checkRateLimit()` returns allow when the limiter binding is missing or when `limiter.limit()` throws.
- Generation/prompt routes can consume Workers AI, NVIDIA or Gemini-backed quota.

Actionable issue: #11 — `[P1][50-persona audit] Fail closed when public generation abuse controls are unavailable`.

## Positive evidence

- Request bodies are byte-bounded rather than trusting Content-Length.
- Turnstile itself fails closed when explicitly required but misconfigured/unavailable.
- Moderation runs before generation.
- Wrangler declares the rate limiter, R2 bucket and Workers AI binding; secrets are documented as Worker secrets rather than vars.
- Usage telemetry is designed to omit prompts/images/keys.

## Regression gates

1. Production must reject provider-consuming requests when the durable limiter is absent/failing.
2. Public production release gate must require Turnstile or an equivalent enforced abuse-control policy.
3. Add dependency-failure fixtures for limiter/Turnstile plus concurrent/repeated requests.
4. Verify generate/batch/edit/Gemini prompt routes share the policy.
5. Run browser/provider runtime tests on a non-production Worker.
6. After P0/P1/P2 clear, require two consecutive clean fixed-persona rounds.

## Runtime status

**Pending.** This round proved the fail-open behavior from default-branch code/configuration but did not generate images or call deployed provider endpoints.