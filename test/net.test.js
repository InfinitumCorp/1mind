import { test } from "node:test";
import assert from "node:assert/strict";
import { isNetworkError, waitOnline, withNetworkRetry } from "../src/lib/net.js";

test("network errors are told apart from build errors", () => {
  for (const m of [
    'cannot reach GitHub: Get "https://api.github.com/user": net/http: TLS handshake timeout',
    "npm error code ETIMEDOUT",
    "fatal: unable to access 'https://github.com/x/y/': Failed to connect to github.com port 443",
    "npm error network request to https://registry.npmjs.org/vite failed, reason: getaddrinfo ENOTFOUND",
  ])
    assert.equal(isNetworkError(m), true, m);
  for (const m of ["src/a.ts(3,1): error TS2304: Cannot find name 'x'.", "npm exited with code 1: vite build failed", "spawn vite ENOENT"])
    assert.equal(isNetworkError(m), false, m);
});

test("waitOnline returns once the probe succeeds", async () => {
  let n = 0;
  assert.equal(await waitOnline({ check: async () => ++n >= 3, everyMs: 1, maxMs: 1000 }), true);
  assert.equal(n, 3);
  assert.equal(await waitOnline({ check: async () => false, everyMs: 1, maxMs: 20 }), false);
});

test("withNetworkRetry retries network failures only", async () => {
  let calls = 0;
  const flaky = async () => {
    if (++calls < 3) throw new Error("npm error code ETIMEDOUT");
    return "built";
  };
  assert.equal(await withNetworkRetry(flaky, { wait: async () => true }), "built");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    withNetworkRetry(async () => {
      calls++;
      throw new Error("error TS2304");
    }, { wait: async () => true }),
    /TS2304/,
  );
  assert.equal(calls, 1);

  await assert.rejects(withNetworkRetry(async () => { throw new Error("ETIMEDOUT"); }, { wait: async () => false }), /ETIMEDOUT/);
});
