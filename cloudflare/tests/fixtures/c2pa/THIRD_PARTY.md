# C2PA reader fixtures

These files are copied from the maintained `contentauth/c2pa-js` repository
for offline browser regression tests only. They are not application trust
anchors and are never loaded by the production adapter.

- Upstream commit: `a6c835dcfa68cd8e30325cdcfa22d2c6af642949`
- Asset source: `packages/c2pa-web/test/assets/`
- Trust source: `packages/c2pa-web/test/trust/`
- Upstream repository: <https://github.com/contentauth/c2pa-js>
- Maintained browser package used by this project: `@contentauth/c2pa-web@0.14.4`
- The upstream repository's LICENSE applies to these test fixtures. The test
  trust anchors are public test certificates and must not be used as a
  production trust list.

The SHA-256 values below are checked by the workspace's
`evidence/flux/c2pa-route-roundtrip.mjs` before parsing:

| file | SHA-256 | purpose |
| --- | --- | --- |
| `C_with_CAWG_data.jpg` | `FA0B257C863CB5B367135A017813CE0C1FBFC690A03E94ACDD047C25C2D1ED46` | signed C2PA present fixture |
| `C_with_CAWG_data_thumbnail.jpg` | `C13676FAF4036E8847F6BCE61734376BF8C14FE5F1BC66AE85A2C3106E0FC300` | extracted thumbnail without C2PA |
| `no_alg.jpg` | `7C91641416C18319B823C292AE603C5354892AC365C05543519154C48C6A1F8A` | official parser failure fixture |
| `anchor-correct.pem` | `C0E4156F9CEFC9F8583B44E5A97B528CC0219E50331B382D83CC7CDA58FC0CD9` | test-only trusted C2PA anchor |
| `anchor-cawg.pem` | `2BCB6CDB1DAD10FB518DDC0989E1953BA79092FF9EC6D0B366C34EBE42370D09` | test-only CAWG anchor |
| `anchor-incorrect.pem` | `E48CADE7F0B57BCF4097D2E2B7A69A9BBD4E29CAB5F2E8E01560F4AAC467BDB4` | test-only untrusted anchor |
