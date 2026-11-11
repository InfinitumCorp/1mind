import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateHost, settings, gatewayConfig, health, agents, chat, OPENCLAW_VERSION } from "../src/lib/openclaw.js";

test("only loopback and private gateway addresses are accepted", () => {
  for (const h of ["127.0.0.1", "localhost", "[::1]", "10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.1.93", "100.101.102.103", "box.tail1234.ts.net"]) assert.equal(isPrivateHost(h), true, h);
  for (const h of ["8.8.8.8", "172.32.0.1", "84.201.173.68", "100.128.0.1", "openclaw.example.com", ""]) assert.equal(isPrivateHost(h), false, h);
  assert.throws(() => settings({ OPENCLAW_URL: "https://84.201.173.68:18789" }), /loopback or private/);
  assert.throws(() => settings({ OPENCLAW_URL: "ftp://127.0.0.1" }), /http/);
  assert.throws(() => settings({ OPENCLAW_PORT: "99999" }), /port/);
});

test("managed settings default to a loopback gateway on the pinned version", () => {
  const s = settings({ CONJURE_MODEL: "claude-sonnet-5-5" });
  assert.deepEqual(s, { mode: "managed", url: "http://127.0.0.1:18789", port: 18789, model: "anthropic/claude-sonnet-5-5", version: OPENCLAW_VERSION });
  assert.equal(settings({ OPENCLAW_PORT: "19001", OPENCLAW_MODEL: "anthropic/x" }).url, "http://127.0.0.1:19001");
  assert.equal(settings({ OPENCLAW_URL: "http://10.0.0.5:18789/" }).mode, "external");
});

test("generated gateway config binds loopback, requires a token and enables chat completions", () => {
  const c = gatewayConfig({ port: 18789, token: "t0k", model: "anthropic/claude-opus-5-5", workspace: "/w" });
  assert.equal(c.gateway.bind, "loopback");
  assert.equal(c.gateway.mode, "local");
  assert.deepEqual(c.gateway.auth, { mode: "token", token: "t0k", rateLimit: { exemptLoopback: false } });
  assert.equal(c.gateway.http.endpoints.chatCompletions.enabled, true);
  assert.equal(c.agents.defaults.model.primary, "anthropic/claude-opus-5-5");
});

function fakeGateway() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.url === "/healthz") return res.writeHead(200).end("ok");
      if (req.url === "/readyz") return res.writeHead(503).end("starting");
      if (req.headers.authorization !== "Bearer s3cret") return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unauthorized" } }));
      if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "openclaw" }, { id: "openclaw/default" }, { id: "openclaw/ops" }] }));
      if (req.url === "/v1/chat/completions") {
        const b = JSON.parse(body);
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: b.model, choices: [{ message: { role: "assistant", content: `echo: ${b.messages[0].content}` } }], usage: { total_tokens: 7 } }));
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, env: { OPENCLAW_URL: `http://127.0.0.1:${srv.address().port}`, OPENCLAW_GATEWAY_TOKEN: "s3cret" } })));
}

test("client talks to the gateway: health, agents, chat with session thread", async () => {
  const { srv, seen, env } = await fakeGateway();
  try {
    assert.deepEqual(await health(env), { live: true, ready: false, liveStatus: 200, readyStatus: 503 });
    assert.deepEqual(await agents(env), ["openclaw", "openclaw/default", "openclaw/ops"]);
    const r = await chat({ agent: "openclaw/ops", message: "  status report  ", thread: "t1" }, env);
    assert.deepEqual(r, { reply: "echo: status report", model: "openclaw/ops", usage: { total_tokens: 7 } });
    const req = seen.find((s) => s.url === "/v1/chat/completions");
    assert.equal(req.auth, "Bearer s3cret");
    assert.deepEqual(req.body, { model: "openclaw/ops", messages: [{ role: "user", content: "status report" }], user: "1mind-t1" });
    await assert.rejects(chat({ message: "hi" }, { ...env, OPENCLAW_GATEWAY_TOKEN: "wrong" }), /OpenClaw: unauthorized/);
  } finally {
    srv.close();
  }
});

test("chat input is validated before anything is sent", async () => {
  const env = { OPENCLAW_URL: "http://127.0.0.1:9", OPENCLAW_GATEWAY_TOKEN: "x" };
  await assert.rejects(chat({ message: "" }, env), /1-20000/);
  await assert.rejects(chat({ message: "x".repeat(20_001) }, env), /1-20000/);
  await assert.rejects(chat({ agent: "gpt-4", message: "hi" }, env), /agent must be/);
  await assert.rejects(chat({ message: "hi", thread: "../etc" }, env), /thread/);
});

test("an unreachable gateway reports down instead of throwing", async () => {
  assert.deepEqual(await health({ OPENCLAW_URL: "http://127.0.0.1:9" }), { live: false, ready: false, liveStatus: null, readyStatus: null });
});
