// Every long-running operation (pull, build, scan, conjure) is a job with a live log.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { audit } from "./store.js";

const jobs = new Map();
const MAX_JOBS = 300;
const MAX_LOG = 4000;

export function listJobs() {
  return [...jobs.values()].reverse().map(({ log, controller, ...j }) => ({ ...j, lines: log.length }));
}

export function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { controller, ...rest } = j;
  return rest;
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return false;
  j.controller.abort();
  return true;
}

/** Runs fn(ctx) as a job. ctx: { log, signal, exec, job }. Resolves immediately with the job. */
export function startJob({ kind, title, target }, fn) {
  const job = {
    id: crypto.randomBytes(6).toString("hex"),
    kind, title, target: target ?? null,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    result: null,
    log: [],
    controller: new AbortController(),
  };
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  audit("job.start", { job: job.id, kind, title, target });

  const log = (line, level = "info") => {
    for (const l of String(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      job.log.push({ t: Date.now(), level, l: l.slice(0, 2000) });
    }
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  };
  const ctx = { job, log, signal: job.controller.signal, exec: (cmd, args, opts) => exec(cmd, args, { ...opts, log, signal: job.controller.signal }) };

  Promise.resolve()
    .then(() => fn(ctx))
    .then((result) => {
      job.status = "ok";
      job.result = result ?? null;
    })
    .catch((err) => {
      job.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.result = { error: err?.message || String(err) };
      log(err?.message || String(err), "error");
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      audit("job.end", { job: job.id, kind, status: job.status });
    });
  return job;
}

const SAFE_ARG = /^[\w@:./=,+\-#~^]+$/;
const SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "corepack"]);

/**
 * Spawn a process, streaming output to the log. On Windows .cmd shims need a shell, so every
 * argument is checked against a conservative pattern before it is passed through.
 */
export function exec(cmd, args = [], { cwd, log = () => {}, signal, env, capture = false, allowFail = false, quiet = false } = {}) {
  // Only package-manager .cmd shims need a shell on Windows; git/gh are real executables.
  const win = process.platform === "win32" && SHIMS.has(cmd);
  for (const a of [cmd, ...args]) {
    if (win && !SAFE_ARG.test(a)) return Promise.reject(new Error(`refusing unsafe argument: ${a}`));
  }
  if (!quiet) log(`$ ${[cmd, ...args].join(" ")}`, "cmd");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, shell: win, windowsHide: true, signal });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (capture) out += s;
      else log(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (!capture || !quiet) log(s, "stderr");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFail) resolve({ code, stdout: out, stderr: err });
      else reject(new Error(`${cmd} exited with code ${code}${err ? ": " + err.trim().split("\n").slice(-3).join(" | ") : ""}`));
    });
  });
}
