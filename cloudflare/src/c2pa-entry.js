import { createC2pa } from '@contentauth/c2pa-web';

// The deployable browser adapter is built from this pinned official SDK entry
// by scripts/build-c2pa.mjs. Keep the SDK behind one global so the legacy
// script based UI does not import an unpinned CDN module at runtime.
globalThis.FluxC2paWeb = { createC2pa };
