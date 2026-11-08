# Issue 11 isolated deployed abuse-control proof

This QA-only adapter imports unchanged product code from main `ac6fec19336fec1140b6c2b0cc862e95611bf43d`
(tree `70cb68de02fbe6ffedf26621c86db7c23d51ddfe`). It preserves every existing tracked
file except the registered Preview workflow, whose old PR45 job remains verbatim.
Production/default branches, release gates and the old strict C2PA controller are unchanged.

The registered `.github/workflows/provenance-preview-qa.yml` gains one dedicated
job on its existing `pull_request` opened/synchronize/reopened events:

```
workflow: provenance-preview-qa.yml (existing registered PR trigger)
head: feature/issue11-isolated-abuse-qa-20261025
base: main
state: open draft, same repository and owner
required PR body marker: <!-- flux-issue11-isolated-qa:20261025 -->
```

Only the owner and same repository/ref are admitted. Checkout uses the exact event
head, distinct from GitHub's synthetic merge SHA. Before the Cloudflare step's
secret environment is referenced, a fresh GET of that same PR must verify its
number, owner, open/draft state, head commit, repository, branch, base and marker
against the event and checkout. Creating/updating that reviewed draft PR with the
marker is the deliberate activation. No workflow_dispatch is added or invoked.
The old pull-request C2PA admission is unchanged. Unsupported admission/API means
STOP; do not merge first, reopen PR45, rerun an old job, weaken admission or change platforms.

The only new remote namespace is `flux-issue11-qa-20261025`, Preview
`issue11-<run>-<attempt>`. Complete ordinary/native Worker inventories must prove
that name absent. No existing Worker is adopted. Locked Wrangler4.135 creates only
the native Preview parent/Preview/deployment with `workers_dev=false`, no routes,
assets, cron, D1/R2/KV/service/AI/provider binding or custom paid CPU limit.
Initial upload uses `--ignore-base-config`; Preview-scoped `QA_ACCESS_TOKEN` put
does not. Official private JSONL session/deployment identity and immutable URL
checks retain the strict namespace/UUID-first8/alias distinction. No normal deploy,
production version, OAuth refresh, account upgrade or alternate credential is used.

Authentication precedes all paths. The newly generated 32-byte QA grant lasts
three minutes, is masked and stored only in an owned0700 runner directory/0600
state and the new Preview's scoped secret. Only fixed server-owned synthetic
payloads are accepted; caller bodies are refused. The product environment is an
explicit projection, never a spread of real bindings/secrets. `production`,
unknown/staging and explicit development positive controls are separate cases.
Global fetch is permanently replaced by a throwing counted stub; per-request
AsyncLocalStorage prevents concurrent counter attribution errors. Synthetic AI
throws and is counted. There is no egress window and no real provider capability.

The hosted proof requires all six original routes under missing/wrong/throwing/
malformed/deny limiter cases, missing Turnstile config/token, synthetic unavailable
Turnstile, combined faults, repeated calls and24 concurrent calls. Two positive
controls must observe synthetic AI/fetch dispatch so zero blocked counters are
meaningful. All110 results are fixed status/code/counter records. Finally the
driver waits for actual expiry (at most three minutes) and requires seven401s
using the former valid key. A timeout/403/unsupported API/schema/collision/expiry
failure stops without retry or fallback. Raw errors, account IDs, names inventory,
tokens, headers, provider bodies, traces and private state are never artifacts.

Missing limiter is genuinely unbound in this deployed Worker. Throwing/malformed/
deny/allow limiter outcomes and Turnstile outage are deliberate JS fault doubles
inside a real deployed Worker; they do not prove a Cloudflare native outage or
real Turnstile challenge. Local native limiter exhaustion is separate local proof.
This does not deploy production, establish rollback propagation, prove real
provider quality/cost, or certify the whole50-persona matrix CLEAN.

No data resources or objects exist to remove. Under AGENTS5, no Worker/project is
deleted: all uploaded deployments deny after grant expiry, leaving inert Preview
metadata. Cleanup removes only this run's private runner directory; receipts are
retained. An early failure may leave an initial deny-all or a bounded short-lived
Preview; it never enables provider/storage access. Production's three missing
secret names and production approval are separate release gates.

Local checks: `node --test tests/qa-abuse/*.test.mjs`,
`node cloudflare/qa-abuse/control.mjs validate`, `node scripts/verify.mjs`,
and actionlint on the changed workflow. These do not establish hosted acceptance.
