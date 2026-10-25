# Isolated provenance HTTPS Preview proof

This QA package leaves feature `c12518d450aa50edea7d6be66503f4bb51e87945`
(tree `f01e1299eed96e70662be5cdc8c951938e2cb877`) and all production
configuration/dependencies/assets unchanged. `frozen-source.json` checks the
282 original source, asset, configuration and signed/absent fixture hashes.

The workflow runs only for the owner's **open draft PR45**, in the same public
repository and expected feature branch, with both actor identities equal to the
owner. It checks out and freshly rechecks that exact head using a read-only
GitHub token before resource changes. Forks, other actors, changed heads, ready
PRs, production branches and `pull_request_target` are refused. Dependency
installation and all local checks run before the Cloudflare credential step;
installation scripts are disabled.

## Cloud scope and ordering

The only Worker and private R2 bucket names are `flux-pr45-qa-20261025`.
The workflow never uses production `flux-image-gen` or `flux-image-gallery`,
normal `deploy`, `versions deploy`, routes, cron, service/AI/provider bindings,
OAuth refresh, billing changes, bucket deletion or project deletion.

1. Invoke only this package's locked Wrangler **4.135.0**. Check the fixed QA
   Worker's ordinary versions and deployments read-only. Only empty histories
   or the exact missing-script `10007` result are accepted. This proves no
   ordinary uploaded/deployed script; it does not prove parent metadata absent.
2. List R2 buckets without publishing inventory. A missing fixed bucket is
   created private with an owner marker. An existing fixed bucket must already
   contain the exact repository/purpose marker; it is never silently adopted.
3. Generate a 32-byte ephemeral key, mask its raw and Basic-encoded forms, and
   keep it only in a private runner file (0600, directory0700) and the scoped
   Preview secret. The wrapper expires the grant after one hour.
4. Create the named native Preview with explicit `--ignore-base-config`,
   `workers_dev=false`, `preview_urls=true`, an explicit Preview-only R2 binding,
   disabled observability and `assets.run_worker_first=true`. Missing key means
   **deny all**, including static JS/WASM/assets. Probe that initial immutable
   deployment without authentication before proceeding.
5. Pipe the key to **`wrangler preview secret put QA_ACCESS_TOKEN --name ...`**.
   This is the Preview-scoped secret-put path; it creates a new Preview
   deployment, without changing the parent production script or Preview base
   config. The secret command does not support `--ignore-base-config`; it
   patches this already isolated child deployment. Parse the new deployment ID
   and its matching **immutable Deployment URL**, never the mutable alias.
6. Verify kind, run, exact source hash and frozen feature identity before browser
   actions. Any missing permission/unsupported API/resource collision stops the
   run with a bounded API-code receipt. There is no alternate credential,
   deployment fallback, account upgrade or permissions bypass.

The QA config uses the platform's existing CPU limits. It omits custom
`limits.cpu_ms`: Cloudflare rejected that paid-only setting with `100328` on
the actual initial Preview attempt. The Free plan enforces10ms CPU per request;
no billing plan or resource limit is changed. The controller rejects custom
limit overrides, including10ms, which also require the supported paid usage
model. See <https://developers.cloudflare.com/workers/platform/limits/> and
<https://github.com/cloudflare/workers-sdk/issues/8756>.

Native Preview support is documented for new Workers without a production
deployment: <https://developers.cloudflare.com/workers/previews/get-started/>.
Wrangler4.104's experimental Preview and legacy versions upload are deliberately
unused. Native Preview API/token permissions must be confirmed by the actual
run; local tests cannot establish them.

## Runtime and evidence

The wrapper authenticates before **every** asset/API handler. It projects an
explicit fixture environment into the frozen real application: a synthetic AI
transport returns signed, absent, tampered or browser-canvas-stripped JPEG bytes;
provider fallbacks and vision calls are disabled. This verifies the application's
cryptographic/browser/storage behavior and **does not prove real provider output
or imply authenticity/user benefit**. No fixture trust root is installed:
correct signed C2PA stays `present_untrusted`; tampering is `invalid`.

The real Chromium test uses the frozen exact CSP over HTTPS, the same-origin
C2PA module worker and real WASM. It checks generation, edit lineage, original
download, artwork/receipt/full-history download and import, two R2 shares per
scenario, stored-byte/metadata hashes and privacy allowlists. Worker access to
R2 is confined to `qa-runs/<run-id>-<attempt>/`; cleanup deletes only owned
objects, checks that prefix is empty, and retains the bucket and owner marker.
An incomplete or failed cleanup is a failed proof. Preview deployments remain
deny-all after expiry; no bucket/project removal is attempted.

The driver waits for the real edit module and enabled native input before
selecting a file, independently of a pending provider-health response.
A deliberately held script regression reproduces an early lost change event;
the product's native picker stays disabled until ready and on failed loading.
Source and minified asset tests use the actual visible label/native chooser.

Browser credentials are scoped to the exact validated immutable HTTPS origin.
The guarded router injects authorization only there, uses `maxRedirects:0`,
rejects every3xx, aborts other HTTP(S) origins and blocks service workers. Scoped
Basic credentials allow protected module-worker fetches without a global auth
header. A two-origin redirect canary proves no key/request reaches its target.
No key enters URLs/query strings, logs, environment outputs or public R2.

Only `output/qa/preview.json` and `browser.json` are uploaded. They contain
bounded status/version/source hashes and sanitized assertions. No HAR, trace,
raw HTTP headers, private runner state, CLI debug logs, downloads, credential
files or environment dump is uploaded. Wrangler disk logs and metrics are
disabled; raw subprocess errors are reduced to fixed classifications/API codes.
Private runner state is removed even on failure. Failures before credentials
or permissions remain honest gates; HTTPS success is claimed only after an
actual successful hosted run.

## Local review commands

```sh
npm ci --ignore-scripts --prefix cloudflare/qa
node cloudflare/qa/control.mjs validate
node --test --test-concurrency=1 tests/qa/*.test.mjs
npm --prefix cloudflare run sync:check
npm --prefix cloudflare run check
npm --prefix cloudflare test
```

The local HTTPS harness uses a temporary self-signed loopback certificate,
actual workerd/R2 and denied outbound Worker transport. Only explicitly local
loopback tests allow that certificate; hosted tests never disable TLS checks.
AGENTS §8's actual hosted Preview gate remains open until its receipt exists.
