import { test } from "node:test";
import assert from "node:assert/strict";
import { cidConfig, startSignIn, finishSignIn, isOwner } from "../src/lib/cid.js";

const base = { issuer: "https://id.example", clientId: "1mind", redirectUri: "http://127.0.0.1:7777/auth/cid/callback", secret: "s3cret" };
const cookieOf = (setCookie) => Object.fromEntries([setCookie.split(";")[0].split("=").map((v, i, a) => (i ? a.slice(1).join("=") : v))].map(([k, v]) => [k, v]));

test("start redirects to the issuer's authorize with PKCE S256", () => {
  const go = startSignIn(base);
  const u = new URL(go.location);
  assert.equal(u.origin + u.pathname, "https://id.example/api/id/authorize");
  assert.equal(u.searchParams.get("client_id"), "1mind");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(u.searchParams.get("prompt"), null);
  assert.equal(new URL(startSignIn({ ...base, create: true }).location).searchParams.get("prompt"), "create");
});

test("callback redeems the code and returns the profile", async () => {
  const go = startSignIn(base);
  const state = new URL(go.location).searchParams.get("state");
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ access_token: "t", profile: { cid: "cid_1", username: "william" } }), { status: 200 });
  };
  const { profile } = await finishSignIn({ ...base, query: new URLSearchParams({ code: "c0de", state }), cookies: cookieOf(go.cookie), fetchImpl });
  assert.equal(profile.cid, "cid_1");
  assert.equal(sent.url, "https://id.example/api/id/token");
  assert.equal(sent.body.code, "c0de");
  assert.equal(sent.body.client_id, "1mind");
  assert.ok(sent.body.code_verifier.length >= 43);
});

test("callback refuses a wrong state, a forged cookie, or a missing profile", async () => {
  const go = startSignIn(base);
  const state = new URL(go.location).searchParams.get("state");
  const ok = async () => new Response(JSON.stringify({ profile: { cid: "x" } }));
  await assert.rejects(finishSignIn({ ...base, query: new URLSearchParams({ code: "c", state: "nope" }), cookies: cookieOf(go.cookie), fetchImpl: ok }));
  await assert.rejects(finishSignIn({ ...base, secret: "other", query: new URLSearchParams({ code: "c", state }), cookies: cookieOf(go.cookie), fetchImpl: ok }));
  const bad = async () => new Response(JSON.stringify({ error: "no" }), { status: 400 });
  await assert.rejects(finishSignIn({ ...base, query: new URLSearchParams({ code: "c", state }), cookies: cookieOf(go.cookie), fetchImpl: bad }), /no/);
});

test("owners: matches cid, username or email; empty list lets nobody in", () => {
  const owners = cidConfig({ CID_OWNERS: "cid_1, Ada@cumuluscloud.app" }).owners;
  assert.ok(isOwner({ cid: "cid_1" }, owners));
  assert.ok(isOwner({ cid: "z", email: "ada@cumuluscloud.app" }, owners));
  assert.ok(!isOwner({ cid: "cid_2" }, owners));
  assert.ok(!isOwner({ cid: "cid_1" }, []));
  assert.equal(cidConfig({}).issuer, "https://id.cumuluscloud.app");
});

test("ownerMatch returns the CID_OWNERS entry that let the profile in", async () => {
  const { ownerMatch } = await import("../src/lib/cid.js");
  const owners = ["info@theinfinitumcorporation.com", "cid_abc"];
  assert.equal(ownerMatch({ cid: "cid_zzz", email: "Info@TheInfinitumCorporation.com" }, owners), "info@theinfinitumcorporation.com");
  assert.equal(ownerMatch({ cid: "cid_abc" }, owners), "cid_abc");
  assert.equal(ownerMatch({ cid: "cid_other", email: "x@y.z" }, owners), null);
  assert.equal(ownerMatch(null, owners), null);
});
