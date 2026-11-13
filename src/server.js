// 1MIND: Infinitum Corporation internal command platform. Binds to 127.0.0.1 only.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ROOT, PORT, PREVIEW_PORT, CONJURED_DIR, accessToken, hasClaude, makeProvider } from "./config.js";
import { audit, readAudit } from "./lib/store.js";
import { startJob, listJobs, getJob, cancelJob } from "./lib/jobs.js";
import { listRepos, repoDetail, pullRepo, validRepo, owner, invalidateRepos } from "./lib/github.js";
import { buildRepo, buildState } from "./lib/builder.js";
import { DIVISIONS } from "./lib/products.js";
import { withNetworkRetry } from "./lib/net.js";
import * as rt from "./lib/redteam.js";
import { conjure, refine } from "./conjure/engine.js";
import { cidConfig, startSignIn, finishSignIn, clearPending, ownerMatch } from "./lib/cid.js";
import { zipDeliverable } from "./conjure/zip.js";
import * as oc from "./lib/openclaw.js";
import { assistRoutes } from "./assist.js";
import { toWebRequest, sendWebResponse } from "./openclaw/openclaw.mjs";

// Server-side signing secret for session cookies. People never type it: they sign in with Cumulus ID.
const SECRET = accessToken();
const COOKIE = "onemind";
const SESSION_TTL_S = 43200;
const CID = cidConfig(process.env, { clientId: "1mind" });
const PUBLIC_URL = (process.env.ONEMIND_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const REDIRECT_URI = `${PUBLIC_URL}/auth/cid/callback`;
const SECURE = PUBLIC_URL.startsWith("https://");
const PUBLIC = path.join(ROOT, "public");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c.split("=").slice(1).join("=")]));
const sign = (v) => crypto.createHmac("sha256", SECRET).update(`1mind-session-v2|${v}`).digest("base64url");
const b64 = (s) => Buffer.from(s).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");
// The session records which CID_OWNERS entry let this person in (a cid, username, handle or
// email), so removing that entry from CID_OWNERS ends the session on the next request.
const sessionFor = (cid, owner) => {
  const v = `${b64(cid)}.${b64(owner)}.${Math.floor(Date.now() / 1000) + SESSION_TTL_S}`;
  return `${v}.${sign(v)}`;
};
/** The signed-in Cumulus ID, or null. */
const sessionCid = (req) => {
  const [id, owner, exp, mac] = String(cookies(req)[COOKIE] || "").split(".");
  if (!id || !owner || !exp || !mac || !safeEqual(mac, sign(`${id}.${owner}.${exp}`)) || Number(exp) < Date.now() / 1000) return null;
  return CID.owners.includes(unb64(owner)) ? unb64(id) : null;
};
// Behind nginx every request comes from 127.0.0.1; with ONEMIND_TRUST_PROXY=1 the audit log
// records the X-Real-IP that nginx sets instead (only trusted when the peer is loopback).
const TRUST_PROXY = process.env.ONEMIND_TRUST_PROXY === "1";
const clientIp = (req) => {
  const peer = req.socket.remoteAddress || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const real = String(req.headers["x-real-ip"] || "");
  return TRUST_PROXY && loopback && /^[0-9a-fA-F:.]{2,45}$/.test(real) ? real : peer;
};
const authed = (req) => Boolean(sessionCid(req));

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
const json = (res, status, data) => res.writeHead(status, { "content-type": "application/json", ...SEC_HEADERS }).end(JSON.stringify(data));

async function body(req) {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 65536) throw new Error("body too large");
  }
  return s;
}
async function readJson(req) {
  const s = await body(req);
  return s ? JSON.parse(s) : {};
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LOGIN = (err) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1MIND</title><link rel="stylesheet" href="/app.css"></head>
<body class="login"><form method="get" action="/auth/cid/start" class="login-box">
<div class="brand-mark">1<span>MIND</span></div><div class="mono dim">INFINITUM CORPORATION · INTERNAL · RESTRICTED</div>
${err ? `<div class="err">${esc(err)}</div>` : ""}
${CID.owners.length ? "" : `<div class="err">NO OWNERS SET · ADD YOUR CUMULUS ID TO CID_OWNERS</div>`}
<button autofocus>SIGN IN WITH CUMULUS ID</button>
<button class="alt" name="create" value="1">CREATE A CUMULUS ID</button></form></body></html>`;

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveStatic(res, rel) {
  const f = path.join(PUBLIC, rel === "/" ? "index.html" : rel);
  if (!f.startsWith(PUBLIC + path.sep)) return res.writeHead(400).end();
  try {
    const data = await fsp.readFile(f);
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache", ...SEC_HEADERS }).end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

/* ---------- conjure ---------- */

async function deliverables() {
  const out = [];
  for (const d of await fsp.readdir(CONJURED_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    try {
      const m = JSON.parse(await fsp.readFile(path.join(CONJURED_DIR, d.name, "conjure.json"), "utf8"));
      out.push({ dir: d.name, name: m.plan?.name, intent: m.intent, ok: m.verification?.ok, files: m.files, createdAt: m.createdAt, updatedAt: m.history?.at(-1)?.at ?? m.createdAt, provider: m.provider, costUsd: m.costUsd, changes: (m.history ?? []).map((h) => h.change) });
    } catch {}
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const conjuredDir = (name) => (typeof name === "string" && /^[\w.-]+$/.test(name) && !name.startsWith(".") ? path.join(CONJURED_DIR, name) : null);

function conjureEvents(log) {
  return (e) => {
    if (!e || e.type === "error") return;
    const { type, workspace, manifest, ...rest } = e;
    const bits = Object.entries(rest).filter(([, v]) => v !== undefined && typeof v !== "object").map(([k, v]) => `${k}=${String(v).slice(0, 300)}`);
    log(`[${type}] ${bits.join(" ")}`);
    if (type === "done" && manifest) log(`verified=${manifest.verification?.ok} files=${manifest.files?.length ?? "?"} cost=$${manifest.costUsd ?? 0}`);
  };
}

/* ---------- overview ---------- */

async function overview() {
  let repos = [];
  let ghError = null;
  try {
    repos = await listRepos();
  } catch (e) {
    ghError = e.message;
  }
  const builds = buildState();
  const findings = rt.getFindings();
  const open = findings.filter((f) => f.status === "open");
  const sev = Object.fromEntries(rt.SEVERITIES.map((s) => [s, open.filter((f) => f.severity === s).length]));
  const byRepo = {};
  for (const f of open) byRepo[f.target] = (byRepo[f.target] || 0) + 1;
  return {
    owner: await owner().catch(() => null),
    ghError,
    divisions: DIVISIONS,
    repos: repos.map((r) => ({ ...r, build: builds[r.name] || null, openFindings: byRepo[r.name] || 0 })),
    findings: { open: open.length, bySeverity: sev, total: findings.length },
    scope: rt.getScope(),
    jobs: listJobs().slice(0, 30),
    conjure: { live: hasClaude(), deliverables: (await deliverables()).length },
    audit: readAudit(40),
    now: new Date().toISOString(),
  };
}

/* ---------- router ---------- */

const routes = [];
// @scalvs / @scalus (SCALVS agent on OpenClaw) and @conjure (Conjure forecasts): /api/scalvs, /api/predict.
const assist = assistRoutes(process.env);
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

route("GET", "/api/overview", async () => overview());
route("POST", "/api/sync", async () => {
  invalidateRepos();
  audit("github.sync");
  return { repos: (await listRepos({ fresh: true })).length };
});
route("GET", "/api/repos/:name", async ({ name }) => repoDetail(name));
route("POST", "/api/repos/:name/pull", async ({ name }) => {
  if (!validRepo(name)) throw httpError(400, "bad repo");
  return startJob({ kind: "pull", title: `Pull ${name}`, target: name }, (ctx) => pullRepo(name, ctx));
});
route("POST", "/api/repos/:name/build", async ({ name }) => {
  if (!validRepo(name)) throw httpError(400, "bad repo");
  return startJob({ kind: "build", title: `Build ${name}`, target: name }, (ctx) => buildRepo(name, ctx));
});
route("POST", "/api/fleet/:op", async ({ op }) => {
  if (!["pull", "build", "deploy-check"].includes(op) && op !== "pull-build") throw httpError(400, "bad op");
  return startJob({ kind: `fleet-${op}`, title: `Fleet ${op}` }, async (ctx) => {
    const net = { log: ctx.log, signal: ctx.signal };
    const repos = (await withNetworkRetry(() => listRepos({ fresh: true }), { ...net, retries: 4 })).filter((r) => !r.archived);
    ctx.log(`fleet ${op}: ${repos.length} repos`);
    const summary = { ok: [], partial: [], failed: [], skipped: [] };
    for (const r of repos) {
      if (ctx.signal.aborted) throw new Error("cancelled");
      ctx.log(`━━ ${r.name}`);
      try {
        if (op === "pull" || op === "pull-build") await withNetworkRetry(() => pullRepo(r.name, ctx), net);
        if (op === "build" || op === "pull-build") {
          const b = await withNetworkRetry(() => buildRepo(r.name, ctx), net);
          if (b.status === "skipped" || b.status === "partial") {
            summary[b.status].push(b.status === "skipped" ? `${r.name}: ${b.note}` : r.name);
            continue;
          }
        }
        summary.ok.push(r.name);
      } catch (e) {
        ctx.log(`✗ ${r.name}: ${e.message}`, "error");
        summary.failed.push(r.name);
      }
    }
    ctx.log(`done: ${summary.ok.length} ok, ${summary.partial.length} partial, ${summary.failed.length} failed, ${summary.skipped.length} skipped`);
    return summary;
  });
});

route("GET", "/api/jobs", async () => listJobs());
route("GET", "/api/jobs/:id", async ({ id }) => getJob(id) ?? Promise.reject(httpError(404, "no job")));
route("POST", "/api/jobs/:id/cancel", async ({ id }) => ({ cancelled: cancelJob(id) }));

route("GET", "/api/redteam", async () => ({ findings: rt.getFindings(), scope: rt.getScope() }));
route("POST", "/api/redteam/scope", async (_, b) => rt.addDomain(b.domain, { operator: b.operator, attestation: b.attestation }));
route("DELETE", "/api/redteam/scope/:domain", async ({ domain }) => rt.removeDomain(decodeURIComponent(domain)));
route("POST", "/api/redteam/findings/:id", async ({ id }, b) => rt.triage(id, b.status));
route("POST", "/api/redteam/scan", async (_, b) => {
  const { module, target } = b;
  const fleet = target === "*";
  const repoTargets = async () => (fleet ? (await listRepos()).filter((r) => r.local.pulled).map((r) => r.name) : [target]);
  if (module === "secrets" || module === "deps") {
    if (!fleet && !validRepo(target)) throw httpError(400, "bad repo");
    const fn = module === "secrets" ? rt.scanSecrets : rt.scanDeps;
    return startJob({ kind: `redteam-${module}`, title: `Red team · ${module} · ${fleet ? "all pulled repos" : target}`, target }, async (ctx) => {
      let n = 0;
      for (const r of await repoTargets()) {
        ctx.log(`━━ ${r}`);
        try {
          n += (await fn(r, ctx)).findings;
        } catch (e) {
          ctx.log(e.message, "error");
        }
      }
      return { findings: n };
    });
  }
  if (module === "posture") return startJob({ kind: "redteam-posture", title: "Red team · GitHub posture · all repos" }, (ctx) => rt.scanPosture(ctx));
  if (module === "surface") {
    const domains = fleet ? rt.getScope().domains.map((d) => d.domain) : [target];
    for (const d of domains) if (!rt.getScope().domains.some((x) => x.domain === d)) throw httpError(403, `${d} is not in the authorized scope`);
    return startJob({ kind: "redteam-surface", title: `Red team · external surface · ${fleet ? `${domains.length} domains` : target}`, target }, async (ctx) => {
      let n = 0;
      for (const d of domains) {
        ctx.log(`━━ ${d}`);
        n += (await rt.scanSurface(d, ctx)).findings;
      }
      return { findings: n };
    });
  }
  throw httpError(400, "unknown module");
});

// Public origin of the preview server (its own origin, so generated code can't call the 1MIND API).
const PREVIEW_URL = (process.env.ONEMIND_PREVIEW_URL || `http://127.0.0.1:${PREVIEW_PORT}`).replace(/\/+$/, "");
route("GET", "/api/conjure", async () => ({ live: hasClaude(), deliverables: await deliverables(), previewPort: PREVIEW_PORT, previewBase: PREVIEW_URL }));
route("POST", "/api/conjure", async (_, b) => {
  const intent = String(b.intent || "").trim();
  if (!intent || intent.length > 4000) throw httpError(400, "intent must be 1-4000 chars");
  if (listJobs().some((j) => j.kind.startsWith("conjure") && j.status === "running")) throw httpError(409, "a Conjure run is already in progress");
  const provider = makeProvider({ mock: b.mock === true });
  return startJob({ kind: "conjure", title: `Conjure · ${intent.slice(0, 60)}` }, async (ctx) => {
    ctx.log(`provider=${provider.name} model=${provider.model || "mock"}`);
    const r = await conjure({ intent, provider, outDir: CONJURED_DIR, signal: ctx.signal, onEvent: conjureEvents(ctx.log) });
    return { dir: path.basename(r.workspace), name: r.plan?.name, ok: r.verification?.ok, costUsd: r.costUsd };
  });
});
route("POST", "/api/conjure/refine", async (_, b) => {
  const dir = conjuredDir(b.dir);
  const change = String(b.change || "").trim();
  if (!dir || !fs.existsSync(dir)) throw httpError(400, "unknown deliverable");
  if (!change || change.length > 4000) throw httpError(400, "change must be 1-4000 chars");
  if (listJobs().some((j) => j.kind.startsWith("conjure") && j.status === "running")) throw httpError(409, "a Conjure run is already in progress");
  const provider = makeProvider({ mock: b.mock === true });
  return startJob({ kind: "conjure-refine", title: `Refine · ${b.dir}`, target: b.dir }, (ctx) => refine({ dir, change, provider, signal: ctx.signal, onEvent: conjureEvents(ctx.log) }).then(() => ({ dir: b.dir })));
});

/* ---------- OpenClaw ---------- */

route("GET", "/api/openclaw", async () => {
  let s;
  try {
    s = oc.settings();
  } catch (e) {
    return { error: e.message };
  }
  const h = await oc.health();
  let agents = [];
  let agentsError = null;
  if (h.live) {
    try {
      agents = await oc.agents();
    } catch (e) {
      agentsError = e.message;
    }
  }
  return {
    settings: s,
    installed: oc.installedVersion(),
    gateway: oc.gatewayProcess(),
    health: h,
    agents,
    agentsError,
    live: hasClaude(),
    installing: listJobs().some((j) => j.kind === "openclaw-install" && j.status === "running"),
  };
});
route("GET", "/api/openclaw/logs", async () => oc.gatewayLogs(200));
route("POST", "/api/openclaw/install", async () => {
  if (listJobs().some((j) => j.kind === "openclaw-install" && j.status === "running")) throw httpError(409, "OpenClaw install already running");
  audit("openclaw.install", { version: oc.OPENCLAW_VERSION });
  return startJob({ kind: "openclaw-install", title: `Install OpenClaw ${oc.OPENCLAW_VERSION}` }, (ctx) => oc.install(ctx));
});
route("POST", "/api/openclaw/gateway/:op", async ({ op }) => {
  if (op !== "start" && op !== "stop") throw httpError(400, "op must be start or stop");
  try {
    const g = op === "start" ? oc.startGateway() : oc.stopGateway();
    audit(`openclaw.gateway.${op}`, { pid: g.pid });
    return g;
  } catch (e) {
    throw httpError(409, e.message);
  }
});
route("POST", "/api/openclaw/chat", async (_, b) => {
  // Every turn is audited, failed ones too: agent and length, never the content.
  const entry = { agent: b.agent || "openclaw/default", chars: String(b.message || "").length };
  try {
    const r = await oc.chat({ agent: b.agent || undefined, message: b.message, thread: b.thread || undefined });
    audit("openclaw.chat", { ...entry, ok: true });
    return r;
  } catch (e) {
    const status = e.status || (e.name === "TimeoutError" ? 504 : 502);
    audit("openclaw.chat", { ...entry, ok: false, status });
    throw httpError(status, e.message);
  }
});

route("GET", "/api/audit", async () => readAudit(500));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/login") {
      if (req.method !== "GET") return res.writeHead(405).end();
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS }).end(LOGIN(""));
    }
    if (url.pathname === "/auth/cid/start" && req.method === "GET") {
      if (!CID.clientId) return res.writeHead(503, { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS }).end(LOGIN("CID_CLIENT_ID IS NOT SET"));
      const go = startSignIn({ ...CID, redirectUri: REDIRECT_URI, secret: SECRET, create: url.searchParams.get("create") === "1", secure: SECURE });
      return res.writeHead(302, { location: go.location, "set-cookie": go.cookie }).end();
    }
    if (url.pathname === "/auth/cid/callback" && req.method === "GET") {
      try {
        const { profile } = await finishSignIn({ ...CID, redirectUri: REDIRECT_URI, secret: SECRET, query: url.searchParams, cookies: cookies(req) });
        const owner = ownerMatch(profile, CID.owners);
        if (!owner) {
          audit("auth.denied", { cid: profile.cid, ip: clientIp(req) });
          return res.writeHead(403, { "content-type": "text/html; charset=utf-8", "set-cookie": clearPending(SECURE), ...SEC_HEADERS }).end(LOGIN("THIS CUMULUS ID HAS NO ACCESS"));
        }
        audit("auth.ok", { cid: profile.cid, ip: clientIp(req) });
        const session = `${COOKIE}=${sessionFor(profile.cid, owner)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${SECURE ? "; Secure" : ""}`;
        return res.writeHead(303, { location: "/", "set-cookie": [session, clearPending(SECURE)] }).end();
      } catch (e) {
        audit("auth.fail", { ip: clientIp(req) });
        return res.writeHead(401, { "content-type": "text/html; charset=utf-8", "set-cookie": clearPending(SECURE), ...SEC_HEADERS }).end(LOGIN(e.message));
      }
    }
    if (url.pathname === "/logout") return res.writeHead(303, { location: "/login", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` }).end();
    if (url.pathname === "/app.css") return serveStatic(res, "/app.css");
    if (!authed(req)) {
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "unauthenticated" });
      return res.writeHead(303, { location: "/login" }).end();
    }

    if (url.pathname === "/api/conjure/download") {
      const dir = conjuredDir(url.searchParams.get("dir"));
      if (!dir || !fs.existsSync(dir)) return res.writeHead(404).end();
      const zip = await zipDeliverable(dir);
      audit("conjure.download", { dir: path.basename(dir) });
      return res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${path.basename(dir)}.zip"` }).end(zip);
    }

    if (url.pathname.startsWith("/api/")) {
      // CSRF: state-changing calls must carry the custom header (cookies are SameSite=Strict too).
      if (req.method !== "GET" && req.headers["x-1mind"] !== "1") return json(res, 403, { error: "missing x-1mind header" });
      if (url.pathname === "/api/scalvs" || url.pathname === "/api/predict" || url.pathname.startsWith("/api/predict/")) {
        const handled = await assist(await toWebRequest(req), sessionCid(req));
        if (handled) {
          audit(url.pathname === "/api/scalvs" ? "scalvs.ask" : "conjure.predict", { method: req.method, status: handled.status });
          return void (await sendWebResponse(res, handled));
        }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const b = req.method === "GET" ? {} : await readJson(req);
        const out = await r.fn(m.groups || {}, b, req);
        if (out && out.controller) {
          const { controller, log, ...j } = out;
          return json(res, 202, j);
        }
        return json(res, 200, out);
      }
      return json(res, 404, { error: "no route" });
    }
    if (req.method === "GET") return serveStatic(res, url.pathname);
    res.writeHead(405).end();
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: e.message });
  }
});

// Conjured deliverables are served from a separate origin so generated code can't call the 1MIND API.
const preview = http.createServer(async (req, res) => {
  if (req.method !== "GET") return res.writeHead(405).end();
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname.slice(1));
  } catch {
    return res.writeHead(400).end();
  }
  let f = path.resolve(CONJURED_DIR, rel);
  if (!f.startsWith(CONJURED_DIR + path.sep)) return res.writeHead(403).end();
  try {
    if ((await fsp.stat(f)).isDirectory()) f = path.join(f, "index.html");
    const data = await fsp.readFile(f);
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "text/plain; charset=utf-8", "cache-control": "no-store" }).end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  preview.listen(PREVIEW_PORT, "127.0.0.1");
  audit("server.start", { port: PORT });
  console.log(`1MIND online  http://127.0.0.1:${PORT}`);
  console.log(`sign-in       Cumulus ID (${CID.issuer}), client ${CID.clientId}, ${CID.owners.length} owner(s) in CID_OWNERS`);
  console.log(`conjure       ${hasClaude() ? "live Claude" : "offline mock (set ANTHROPIC_API_KEY in .env for live)"}`);
});
