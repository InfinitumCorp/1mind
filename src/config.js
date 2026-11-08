import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ClaudeProvider, MockProvider, DEFAULT_MODEL } from "./conjure/providers.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const PORT = Number(process.env.PORT || 4400);
export const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 4401);
export const DATA = path.join(ROOT, "data");
export const WORKSPACE = path.join(ROOT, "workspace");
export const REPOS_DIR = path.join(WORKSPACE, "repos");
export const CONJURED_DIR = path.join(WORKSPACE, "conjured");
for (const d of [DATA, REPOS_DIR, CONJURED_DIR]) fs.mkdirSync(d, { recursive: true });

/** Console access token: env wins, else a persisted random one. */
export function accessToken() {
  if (process.env.ONEMIND_TOKEN) return process.env.ONEMIND_TOKEN;
  const f = path.join(ROOT, ".1mind-token");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(f, t + "\n", { mode: 0o600 });
  return t;
}

export function hasClaude() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

/** Reads an integer setting from the environment; undefined when unset. */
export function intEnv(name, min) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${v}"`);
  return n;
}

export function makeProvider({ mock } = {}) {
  if (mock || !hasClaude()) return new MockProvider({});
  return new ClaudeProvider({
    model: process.env.CONJURE_MODEL || DEFAULT_MODEL,
    fallbacks: process.env.CONJURE_FALLBACKS !== "0",
    timeoutMs: intEnv("CONJURE_TIMEOUT_MS", 1),
    maxRetries: intEnv("CONJURE_MAX_RETRIES", 0) ?? 3,
  });
}
