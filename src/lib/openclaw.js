// OpenClaw inside 1MIND: a managed, loopback-only OpenClaw gateway plus a client for its
// OpenAI-compatible HTTP API (https://github.com/openclaw/openclaw, MIT).
//
// OpenClaw's own guidance: its chat endpoint is full operator access to the gateway, so it must
// stay on loopback or private ingress. 1MIND therefore runs the gateway bound to loopback with a
// generated token, and talks to an external gateway only at a loopback or private address.
// The runtime (~275 MB) is installed on demand into workspace/openclaw, not as a 1MIND dependency.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { WORKSPACE } from "../config.js";
import { DEFAULT_MODEL } from "../conjure/providers.js";

export const OPENCLAW_VERSION = "2026.11.3";
const HOME = path.join(WORKSPACE, "openclaw");
const STATE = path.join(HOME, "state");
const CONFIG = path.join(STATE, "openclaw.json");
const TOKEN_FILE = path.join(STATE, "gateway-token");
const BIN = path.join(HOME, "node_modules", "openclaw", "openclaw.mjs");

/** True for loopback, RFC 1918, CGNAT/Tailscale (100.64/10) and *.ts.net hosts. */
export function isPrivateHost(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (h.endsWith(".ts.net")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Where the gateway is and who runs it. OPENCLAW_URL switches to an external gateway. */
export function settings(env = process.env) {
  const port = Number(env.OPENCLAW_PORT || 18789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPENCLAW_PORT must be a port number");
  const model = env.OPENCLAW_MODEL || `anthropic/${env.CONJURE_MODEL || DEFAULT_MODEL}`;
  if (env.OPENCLAW_URL) {
    let u;
    try {
      u = new URL(env.OPENCLAW_URL);
    } catch {
      throw new Error("OPENCLAW_URL is not a valid URL");
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error("OPENCLAW_URL must be http(s)");
    if (!isPrivateHost(u.hostname)) throw new Error("OPENCLAW_URL must be a loopback or private address: the gateway API is operator access and must not be reached over the public internet");
    return { mode: "external", url: u.origin, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), model, version: null };
  }
  return { mode: "managed", url: `http://127.0.0.1:${port}`, port, model, version: OPENCLAW_VERSION };
}

/** Gateway config 1MIND writes for the managed gateway. */
export function gatewayConfig({ port, token, model, workspace }) {
  return {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token, rateLimit: { exemptLoopback: false } },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    agents: { defaults: { workspace, model: { primary: model } } },
  };
}

function gatewayToken(env = process.env) {
  if (env.OPENCLAW_GATEWAY_TOKEN) return env.OPENCLAW_GATEWAY_TOKEN;
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  fs.mkdirSync(STATE, { recursive: true });
  const t = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}

/** Installed runtime version, or null. */
export function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "node_modules", "openclaw", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** Installs the pinned runtime into workspace/openclaw (a 1MIND job). */
export async function install({ exec, log }) {
  fs.mkdirSync(HOME, { recursive: true });
  const pj = path.join(HOME, "package.json");
  if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ name: "1mind-openclaw-runtime", private: true }, null, 2) + "\n");
  log(`installing openclaw@${OPENCLAW_VERSION} into ${HOME}`);
  await exec("npm", ["install", `openclaw@${OPENCLAW_VERSION}`, "--save-exact", "--no-audit", "--no-fund"], { cwd: HOME });
  const v = installedVersion();
  if (v !== OPENCLAW_VERSION) throw new Error(`expected openclaw ${OPENCLAW_VERSION}, found ${v ?? "nothing"}`);
  return { version: v };
}

/* ---------- managed gateway process ---------- */

const proc = { child: null, pid: null, startedAt: null, exitedAt: null, exitCode: null, lines: [] };
const MAX_LINES = 300;

function redact(s, token) {
  let out = String(s);
  if (token) out = out.split(token).join("«token»");
  return out.replace(/sk-ant-[\w-]{10,}/g, "sk-ant-«redacted»");
}

function pushLines(text, token) {
  for (const l of redact(text, token).split(/\r?\n/)) {
    if (!l.trim()) continue;
    proc.lines.push({ t: new Date().toISOString(), l: l.slice(0, 2000) });
  }
  if (proc.lines.length > MAX_LINES) proc.lines.splice(0, proc.lines.length - MAX_LINES);
}

export function gatewayProcess() {
  return {
    running: Boolean(proc.child),
    pid: proc.pid,
    startedAt: proc.startedAt,
    exitedAt: proc.exitedAt,
    exitCode: proc.exitCode,
  };
}

export const gatewayLogs = (n = 200) => proc.lines.slice(-n);

/** Starts the managed gateway: loopback bind, token auth, chat completions on. */
export function startGateway(env = process.env) {
  const s = settings(env);
  if (s.mode !== "managed") throw new Error("OPENCLAW_URL points at an external gateway; 1MIND does not manage it");
  if (proc.child) return gatewayProcess();
  if (!installedVersion()) throw new Error("OpenClaw runtime is not installed yet");
  const token = gatewayToken(env);
  fs.mkdirSync(path.join(STATE, "agent-workspace"), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(gatewayConfig({ port: s.port, token, model: s.model, workspace: path.join(STATE, "agent-workspace") }), null, 2) + "\n", { mode: 0o600 });
  const child = spawn(process.execPath, [BIN, "gateway", "--port", String(s.port)], {
    cwd: STATE,
    env: { ...env, OPENCLAW_STATE_DIR: STATE, OPENCLAW_CONFIG_PATH: CONFIG, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_GATEWAY_PORT: String(s.port), NO_COLOR: "1", FORCE_COLOR: "0" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  Object.assign(proc, { child, pid: child.pid, startedAt: new Date().toISOString(), exitedAt: null, exitCode: null });
  pushLines(`1mind: starting openclaw ${installedVersion()} gateway on ${s.url} (loopback, token auth)`, token);
  child.stdout.on("data", (d) => pushLines(d, token));
  child.stderr.on("data", (d) => pushLines(d, token));
  child.on("error", (e) => pushLines(`1mind: gateway failed to start: ${e.message}`, token));
  child.on("exit", (code, signal) => {
    pushLines(`1mind: gateway exited (${signal || code})`, token);
    Object.assign(proc, { child: null, exitedAt: new Date().toISOString(), exitCode: code ?? signal });
  });
  return gatewayProcess();
}

export function stopGateway() {
  if (!proc.child) return gatewayProcess();
  proc.child.kill();
  return gatewayProcess();
}

// Never leave an orphaned gateway behind when 1MIND exits.
process.on("exit", () => proc.child?.kill());
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => (proc.child?.kill(), process.exit(0)));

/* ---------- HTTP client ---------- */

function authHeaders(env) {
  const s = settings(env);
  const token = s.mode === "managed" ? gatewayToken(env) : env.OPENCLAW_GATEWAY_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function probe(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status;
  } catch {
    return null;
  }
}

/** Liveness (/healthz) and readiness (/readyz) of the gateway. */
export async function health(env = process.env) {
  const s = settings(env);
  const [live, ready] = await Promise.all([probe(`${s.url}/healthz`), probe(`${s.url}/readyz`)]);
  return { live: live === 200, ready: ready === 200, liveStatus: live, readyStatus: ready };
}

/** Agent targets the gateway exposes (openclaw, openclaw/default, openclaw/<agentId>). */
export async function agents(env = process.env) {
  const s = settings(env);
  const r = await fetch(`${s.url}/v1/models`, { headers: authHeaders(env), signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`gateway /v1/models: HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((m) => m.id).filter(Boolean);
}

const AGENT = /^(openclaw(\/[\w.-]+)?|openclaw:[\w.-]+|agent:[\w.-]+)$/;
const THREAD = /^[\w.-]{1,64}$/;

/** One chat turn. `thread` keeps an OpenClaw session across turns (OpenAI `user` field). */
export async function chat({ agent = "openclaw/default", message, thread }, env = process.env, { timeoutMs = 300_000 } = {}) {
  if (!AGENT.test(agent)) throw new Error("agent must be openclaw, openclaw/<id> or agent:<id>");
  const text = String(message ?? "").trim();
  if (!text || text.length > 20_000) throw new Error("message must be 1-20000 chars");
  if (thread !== undefined && !THREAD.test(thread)) throw new Error("thread must be 1-64 word characters");
  const s = settings(env);
  const r = await fetch(`${s.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(env) },
    body: JSON.stringify({ model: agent, messages: [{ role: "user", content: text }], ...(thread ? { user: `1mind-${thread}` } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenClaw: ${j.error?.message || `HTTP ${r.status}`}`);
  const reply = j.choices?.[0]?.message?.content;
  return { reply: typeof reply === "string" ? reply : JSON.stringify(reply ?? ""), model: j.model || agent, usage: j.usage || null };
}
