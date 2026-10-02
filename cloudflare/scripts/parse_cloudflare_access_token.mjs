import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const [responsePath, httpStatus, ...extra] = process.argv.slice(2);
if (!responsePath || !httpStatus || extra.length > 0 || !/^\d{3}$/.test(httpStatus)) {
  fail("Cloudflare token refresh response could not be validated.");
}
if (httpStatus !== "200") {
  fail("Cloudflare token refresh failed (HTTP " + httpStatus + ").");
}

let payload;
try {
  payload = JSON.parse(readFileSync(responsePath, "utf8"));
} catch {
  fail("Cloudflare token refresh returned invalid JSON.");
}

const token = payload?.access_token;
if (typeof token !== "string" || token.length === 0 || token.trim() !== token || /[\u0000-\u001F\u007F]/.test(token)) {
  fail("Cloudflare token refresh response did not include a usable access token.");
}

process.stdout.write(token);
