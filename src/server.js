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
import * as rt from "./lib/redteam.js";
import { conjure, refine } from "./conjure/engine.js";
import { zipDeliverable } from "./conjure/zip.js";

const TOKEN = accessToken();
const COOKIE = "onemind";
const SESSION = crypto.createHmac("sha256", TOKEN).update("1mind-session-v1").digest("base64url");
const PUBLIC = path.join(ROOT, "public");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c.split("=").slice(1).join("=")]));
const authed = (req) => safeEqual(cookies(req)[COOKIE] || "", SESSION);

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

const LOGIN = (err) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1MIND</title><link rel="stylesheet" href="/app.css"></head>
<body class="login"><form method="post" action="/login" class="login-box">
<div class="brand-mark">1<span>MIND</span></div><div class="mono dim">INFINITUM CORPORATION · INTERNAL · RESTRICTED</div>
${err ? `<div class="err">${err}</div>` : ""}
<input name="token" type="password" autocomplete="current-password" placeholder="ACCESS TOKEN" required autofocus>
<button>AUTHENTICATE</button></form></body></html>`;

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
  const repos = (await listRepos()).filter((r) => !r.archived);
  return startJob({ kind: `fleet-${op}`, title: `Fleet ${op} (${repos.length} repos)` }, async (ctx) => {
    const summary = { ok: [], partial: [], failed: [], skipped: [] };
    for (const r of repos) {
      if (ctx.signal.aborted) throw new Error("cancelled");
      ctx.log(`━━ ${r.name}`);
      try {
        if (op === "pull" || op === "pull-build") await pullRepo(r.name, ctx);
        if (op === "build" || op === "pull-build") {
          const b = await buildRepo(r.name, ctx);
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

route("GET", "/api/conjure", async () => ({ live: hasClaude(), deliverables: await deliverables(), previewPort: PREVIEW_PORT }));
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

route("GET", "/api/audit", async () => readAudit(500));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/login") {
      if (req.method === "GET") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS }).end(LOGIN(""));
      const token = new URLSearchParams(await body(req)).get("token") || "";
      if (!safeEqual(token, TOKEN)) {
        audit("auth.fail", { ip: req.socket.remoteAddress });
        await new Promise((r) => setTimeout(r, 800));
        return res.writeHead(401, { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS }).end(LOGIN("ACCESS DENIED"));
      }
      audit("auth.ok", { ip: req.socket.remoteAddress });
      return res.writeHead(303, { location: "/", "set-cookie": `${COOKIE}=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` }).end();
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
  console.log(`access token  ${process.env.ONEMIND_TOKEN ? "(from ONEMIND_TOKEN)" : "in .1mind-token"}`);
  console.log(`conjure       ${hasClaude() ? "live Claude" : "offline mock (set ANTHROPIC_API_KEY in .env for live)"}`);
});
