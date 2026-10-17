const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileURLToPath, pathToFileURL } = require("node:url");
const test = require("node:test");

const refreshToken = "test-refresh-credential";
const accessToken = "test-access-token";
const moduleUrl = pathToFileURL(resolve(__dirname, "../../scripts/refresh-cloudflare-token.mjs"));

async function refresh(options) {
  const { refreshCloudflareToken } = await import(moduleUrl);
  return refreshCloudflareToken(options);
}

test("refresh uses the documented OAuth form and returns the valid token", async () => {
  const token = await refresh({
    refreshToken,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://dash.cloudflare.com/oauth2/token");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.body.get("grant_type"), "refresh_token");
      assert.equal(options.body.get("refresh_token"), refreshToken);
      assert.equal(options.body.get("client_id"), "54d11594-84e4-41aa-b438-e81b8fa78ee7");
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }) };
    },
  });
  assert.equal(token, accessToken);
});

test("missing refresh configuration stops before making a request", async () => {
  let calls = 0;
  await assert.rejects(refresh({
    refreshToken: " ",
    fetchImpl: async () => { calls++; },
  }), /CF_REFRESH_TOKEN is missing/u);
  assert.equal(calls, 0);
});

test("HTTP and transport failures never reveal provider text or credentials", async (t) => {
  for (const [name, fetchImpl, message] of [
    ["HTTP", async () => ({ ok: false, status: 400, json: async () => ({ error_description: refreshToken }) }), /HTTP 400/u],
    ["transport", async () => { throw new Error(refreshToken); }, /request failed/u],
    ["JSON", async () => ({ ok: true, json: async () => { throw new Error(accessToken); } }), /invalid JSON/u],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(refresh({ refreshToken, fetchImpl }), (error) => {
        assert.match(error.message, message);
        assert.ok(!error.message.includes(refreshToken));
        assert.ok(!error.message.includes(accessToken));
        return true;
      });
    });
  }
});

test("unusable access tokens and OAuth error replies are rejected", async (t) => {
  const replies = [
    null, [], {}, { access_token: null }, { access_token: 12 },
    { access_token: "" }, { access_token: "null" }, { access_token: "undefined" },
    { access_token: "token with space" }, { access_token: "token\r\nheader" },
    { access_token: accessToken, error: "invalid_grant" },
    { access_token: accessToken, token_type: "Basic" },
    { access_token: accessToken, expires_in: 0 },
  ];
  for (const [index, reply] of replies.entries()) {
    await t.test(String(index), async () => {
      await assert.rejects(refresh({
        refreshToken,
        fetchImpl: async () => ({ ok: true, json: async () => reply }),
      }), /Cloudflare OAuth/u);
    });
  }
});

test("CLI masks a successful token before appending the step output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-refresh-cli-"));
  try {
    const preload = join(directory, "mock-fetch.mjs");
    const output = join(directory, "output");
    await writeFile(preload, "globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(process.env.TEST_OAUTH_REPLY) });\n");
    await writeFile(output, "existing=value\n");
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(moduleUrl)], {
      encoding: "utf8",
      env: { ...process.env, CF_REFRESH_TOKEN: refreshToken, GITHUB_OUTPUT: output, TEST_OAUTH_REPLY: JSON.stringify({ access_token: accessToken }) },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "::add-mask::" + accessToken);
    assert.equal(await readFile(output, "utf8"), "existing=value\ntoken=" + accessToken + "\n");
    assert.ok(!run.stderr.includes(refreshToken));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI leaves the output unchanged when refresh returns no usable token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-refresh-cli-"));
  try {
    const preload = join(directory, "mock-fetch.mjs");
    const output = join(directory, "output");
    await writeFile(preload, "globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: 'invalid_grant', error_description: process.env.CF_REFRESH_TOKEN }) });\n");
    await writeFile(output, "existing=value\n");
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(moduleUrl)], {
      encoding: "utf8", env: { ...process.env, CF_REFRESH_TOKEN: refreshToken, GITHUB_OUTPUT: output },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Cloudflare OAuth/u);
    assert.equal(run.stdout, "");
    assert.equal(await readFile(output, "utf8"), "existing=value\n");
    assert.ok(!run.stderr.includes(refreshToken));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
