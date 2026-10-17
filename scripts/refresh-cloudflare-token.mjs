import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = "https://dash.cloudflare.com/oauth2/token";
const clientId = "54d11594-84e4-41aa-b438-e81b8fa78ee7";

export class CloudflareRefreshError extends Error {}

export async function refreshCloudflareToken({ refreshToken, fetchImpl = globalThis.fetch }) {
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    throw new CloudflareRefreshError("CF_REFRESH_TOKEN is missing. Configure it in GitHub repository Secrets.");
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CloudflareRefreshError("Cloudflare OAuth request failed. Check connectivity and renew CF_REFRESH_TOKEN.");
  }

  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : "unknown";
    throw new CloudflareRefreshError("Cloudflare OAuth returned HTTP " + status + ". Renew CF_REFRESH_TOKEN in GitHub repository Secrets.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CloudflareRefreshError("Cloudflare OAuth returned invalid JSON.");
  }
  const token = payload?.access_token;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.error != null ||
      typeof token !== "string" || !token || /[^\x21-\x7e]/u.test(token) ||
      ["null", "undefined"].includes(token) ||
      (payload.token_type != null && (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer")) ||
      (payload.expires_in != null && (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0))) {
    throw new CloudflareRefreshError("Cloudflare OAuth did not return a usable access token. Renew CF_REFRESH_TOKEN in GitHub repository Secrets.");
  }
  return token;
}

async function main() {
  if (!process.env.GITHUB_OUTPUT) {
    throw new CloudflareRefreshError("GITHUB_OUTPUT is missing; no Cloudflare OAuth request was made.");
  }
  const token = await refreshCloudflareToken({ refreshToken: process.env.CF_REFRESH_TOKEN });
  console.log("::add-mask::" + token.replaceAll("%", "%25"));
  await appendFile(process.env.GITHUB_OUTPUT, "token=" + token + "\n", "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof CloudflareRefreshError
      ? error.message
      : "Cloudflare OAuth step failed before publishing the token output.");
    process.exitCode = 1;
  });
}
