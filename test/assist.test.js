// @scalvs / @scalus (SCALVS agent on OpenClaw) and @conjure (Conjure forecasts) in 1MIND.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistRoutes, mentionIn } from "../src/assist.js";

const post = (path, text) => new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });

test("the intent box routes @conjure, @scalvs and @scalus, not @openclaw", () => {
  assert.equal(mentionIn("@scalvs list open red-team findings"), "scalvs");
  assert.equal(mentionIn("＠Scalus summarise the fleet"), "scalvs");
  assert.equal(mentionIn("@conjure will the FIRM launch slip?"), "conjure");
  assert.equal(mentionIn("@scalvs ask @conjure"), "conjure");
  assert.equal(mentionIn("@openclaw do it"), null);
  assert.equal(mentionIn("an internal incident tracker"), null);
});

test("@scalvs reaches the SCALVS agent as the signed-in owner", async () => {
  const sent = [];
  const fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "2 critical findings open." } }] }));
  };
  const assist = assistRoutes({ OPENCLAW_GATEWAY_URL: "https://claw.test", OPENCLAW_GATEWAY_TOKEN: "tok_secret" }, { fetch });
  const res = await assist(post("/api/scalvs", "@scalvs list open findings"), "cid_owner");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { mention: true, text: "2 critical findings open.", agent: "openclaw" });
  assert.equal(sent[0].user, "1mind:cid_owner");
  assert.ok(!JSON.stringify(body).includes("tok_secret"));
  assert.equal((await assist(post("/api/scalvs", "@scalvs x"), null)).status, 401);
});

test("both are off until configured and say how to connect", async () => {
  const assist = assistRoutes({});
  const s = await assist(post("/api/scalvs", "@scalvs list findings"), "cid_owner");
  assert.equal(s.status, 503);
  assert.match((await s.json()).error, /OPENCLAW_GATEWAY_URL/);
  const p = await assist(post("/api/predict", "@conjure will it ship?"), "cid_owner");
  assert.equal(p.status, 503);
  assert.match((await p.json()).error, /CONJURE_URL/);
  assert.equal(await assist(new Request("http://127.0.0.1/api/overview"), "cid_owner"), null);
});
