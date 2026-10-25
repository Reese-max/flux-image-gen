# 50-Persona Audit — Round 2

Date: 2026-09-08
Protocol: `Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`

> Fixed 50-persona model simulation plus current repository/CI evidence; not 50 human participants. Static/CI evidence is not represented as deployed-provider/runtime validation.

## Audited revision

Current default branch `main` product SHA before this report commit:

`ce69e934e43df5a9cc0d76337414c63d82b778de`

Round-1 P1 #11 was closed after this SHA added an explicit production-mode fail-closed rate-limit policy and deployment-readiness checks. The same fixed personas and regression scenarios were therefore re-run against the remediation and the repository's actual release path.

## Round 2 result

Status: **P1 REOPENED — NOT CLEAN**

### P1 regression / incomplete remediation — production GitHub Actions bypasses the hardened deploy gate

The code-level remediation is real:

- `cloudflare/src/http.js::checkRateLimit(request, limiter, env)` now returns 503 when `ENVIRONMENT="production"`, a server-funded provider is reachable, and the limiter binding is missing or throws.
- `cloudflare/scripts/check-deploy-readiness.mjs` rejects a deployment configuration when neither production fail-closed mode nor Turnstile is enabled.
- `cloudflare/scripts/deploy.mjs` invokes that readiness script before a real Wrangler deploy.

But the repository's GitHub Actions production deployment path does not use that wrapper:

- `.github/workflows/deploy.yml` `deploy-production` invokes `cloudflare/wrangler-action@v3` directly with `command: deploy`.
- The workflow does not call `npm run deploy`, `scripts/deploy.mjs`, or `check-deploy-readiness.mjs`.
- Current tracked `cloudflare/wrangler.toml` still has `ENVIRONMENT = "development"` and `TURNSTILE_REQUIRED = "false"`.
- In that tracked configuration, `checkRateLimit()` intentionally treats limiter absence/errors as development pass-through. A raw Actions deploy can therefore publish a configuration for which the new fail-closed branch is inactive.

This means the Round-1 requirement that the **public production release gate** enforce the abuse-control policy is not yet satisfied. Issue #11 has been reopened with the exact regression criteria.

### Affected fixed personas/scenarios

The full fixed matrix was considered; the regression is directly exercised by:

- C05 DevOps/SRE — expects protection dependencies and release gates to fail closed.
- D03 IT administrator — expects production configuration to be enforced by the deployment path actually used.
- D04 cost-sensitive owner — server-funded generation must not become unbounded because a protection dependency is absent/broken.
- H04 self-host/Cloudflare deployer — follows repository CI/CD rather than a local-only wrapper.
- H05 first-time maintainer — can reasonably treat the GitHub Actions production job as canonical deployment behavior.
- I01 repeated submissions — abuse load during a disabled/broken limiter.
- I04 timeout/5xx/dependency failure — limiter exception must not turn into allow.
- I05 partial-success retry — protection-layer failure must not permit provider retries to fan out.
- J02 concurrent callers — cost/abuse pressure.
- J03 long-running resource exhaustion — sustained provider consumption.
- J04 security/privacy-sensitive operator — release controls must match documented policy.

No distinct additional P0/P1/P2 passed the Round-2 quality gate beyond this reopened P1.

## Current branch / execution evidence

- `main` SHA `ce69e934e43df5a9cc0d76337414c63d82b778de` has GitHub Actions CI run `34066902969` with conclusion `success`.
- Its only job, `verify`, ran on `windows-latest` and completed the repository's `Run full offline verify` step successfully.
- This establishes CI/offline-test evidence for the source remediation, not a production deployment.
- The `production` branch remains at `4d5c89482ba72a88189959988f7272007f801c67`, 12 commits behind `main`; the fail-closed remediation is not present there.
- The Actions query for the `production` branch shows only an older failing CI run (`32894472224`) on that stale SHA. No post-remediation production deploy/runtime evidence was established.

## Runtime claim boundary

This audit does **not** claim that the currently deployed Worker is using `ENVIRONMENT="development"`, that the live limiter is missing, or that provider quota has actually been abused. No post-remediation Worker deployment, live `/generate` request, forced limiter failure, Turnstile failure, provider call, or production billing observation was executed in this round.

Required runtime evidence after the release-path fix:

1. Deploy the remediated code to a non-production Worker through the same CI/CD path intended for production.
2. Demonstrate effective production-mode configuration in the deployed Worker without exposing secret values.
3. Force/fixture limiter absence and limiter exception and verify 503 occurs before Workers AI/NVIDIA/Gemini calls.
4. Verify `/generate`, batch generation, `/edit`, and Gemini-backed prompt routes share the blocking policy.
5. Verify Turnstile-required misconfiguration remains fail closed.
6. Re-run the same fixed persona scenarios.

## CLEAN accounting

`flux-image-gen` remains **NOT CLEAN**. P1 #11 is reopened, so the two-consecutive-clean-round counter is reset. A CLEAN state requires #11 to be resolved (or explicitly justified), relevant runtime evidence on current/recent code, and two consecutive fixed-persona rounds with no new P0/P1/P2 findings.