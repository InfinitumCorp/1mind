// GitHub through the authenticated `gh` CLI: the token never touches 1MIND's own storage.
import fs from "node:fs";
import path from "node:path";
import { exec } from "./jobs.js";
import { REPOS_DIR } from "../config.js";
import { productFor } from "./products.js";

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const validRepo = (n) => typeof n === "string" && REPO_NAME.test(n) && n !== "." && n !== "..";

let ownerCache = process.env.ONEMIND_GH_OWNER || null;
export async function owner() {
  if (ownerCache) return ownerCache;
  const { stdout } = await exec("gh", ["api", "user", "--jq", ".login"], { capture: true, quiet: true });
  ownerCache = stdout.trim();
  return ownerCache;
}

async function ghJson(args, { allowFail = false } = {}) {
  const r = await exec("gh", args, { capture: true, quiet: true, allowFail, signal: AbortSignal.timeout(30_000) }).catch((e) => {
    if (allowFail) return { code: 1, stderr: e.name === "AbortError" ? "gh timed out after 30s" : e.message };
    throw e;
  });
  if (r.code !== 0) return { error: (r.stderr || "").trim().split("\n").pop() || `exit ${r.code}` };
  try {
    return JSON.parse(r.stdout || "null");
  } catch {
    return { error: "bad JSON from gh" };
  }
}

export const api = (route) => ghJson(["api", "-H", "Accept:application/vnd.github+json", route], { allowFail: true });

let repoCache = { at: 0, data: null };
export async function listRepos({ fresh = false } = {}) {
  if (!fresh && repoCache.data && Date.now() - repoCache.at < 60_000) return repoCache.data;
  const o = await owner();
  const fields = "name,description,primaryLanguage,updatedAt,pushedAt,url,isPrivate,isArchived,defaultBranchRef,diskUsage,visibility";
  const raw = await ghJson(["repo", "list", o, "--limit", "300", "--json", fields]);
  if (raw?.error) throw new Error(`gh repo list failed: ${raw.error}`);
  const data = raw.map((r) => ({
    name: r.name,
    description: r.description || "",
    language: r.primaryLanguage?.name || null,
    pushedAt: r.pushedAt,
    updatedAt: r.updatedAt,
    url: r.url,
    private: r.isPrivate,
    archived: r.isArchived,
    visibility: r.visibility,
    defaultBranch: r.defaultBranchRef?.name || "main",
    sizeKb: r.diskUsage,
    ...productFor(r.name),
    local: localState(r.name),
  }));
  repoCache = { at: Date.now(), data };
  return data;
}

export function invalidateRepos() {
  repoCache.at = 0;
}

export function repoDir(name) {
  if (!validRepo(name)) throw new Error("invalid repo name");
  return path.join(REPOS_DIR, name);
}

export function localState(name) {
  const dir = path.join(REPOS_DIR, name);
  if (!fs.existsSync(path.join(dir, ".git"))) return { pulled: false };
  let head = null;
  try {
    const h = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    head = h.startsWith("ref:") ? h.slice(5).replace("refs/heads/", "") : h.slice(0, 7);
  } catch {}
  return { pulled: true, branch: head, path: dir };
}

/** Clone or fast-forward a repo into the 1MIND workspace. */
export async function pullRepo(name, { exec: run }) {
  const o = await owner();
  const dir = repoDir(name);
  if (fs.existsSync(path.join(dir, ".git"))) {
    await run("git", ["-C", dir, "fetch", "--prune", "origin"]);
    await run("git", ["-C", dir, "pull", "--ff-only"]);
  } else {
    await run("gh", ["repo", "clone", `${o}/${name}`, dir]);
  }
  const { stdout } = await run("git", ["-C", dir, "log", "-1", "--format=%h %s (%cr)"], { capture: true });
  invalidateRepos();
  return { head: stdout.trim() };
}

/** Live operational picture for one repo: commits, PRs, CI, security alerts, protection. */
export async function repoDetail(name) {
  if (!validRepo(name)) throw new Error("invalid repo name");
  const o = await owner();
  const base = `repos/${o}/${name}`;
  const repos = await listRepos();
  const meta = repos.find((r) => r.name === name);
  const branch = meta?.defaultBranch || "main";
  const [commits, pulls, runs, dependabot, secrets, codescan, protection] = await Promise.all([
    api(`${base}/commits?per_page=8`),
    api(`${base}/pulls?state=open&per_page=20`),
    api(`${base}/actions/runs?per_page=8`),
    api(`${base}/dependabot/alerts?state=open&per_page=50`),
    api(`${base}/secret-scanning/alerts?state=open&per_page=50`),
    api(`${base}/code-scanning/alerts?state=open&per_page=50`),
    api(`${base}/branches/${branch}/protection`),
  ]);
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    meta: meta ?? { name, ...productFor(name) },
    commits: arr(commits).map((c) => ({ sha: c.sha.slice(0, 7), msg: c.commit.message.split("\n")[0], author: c.commit.author?.name, date: c.commit.author?.date, url: c.html_url })),
    pulls: arr(pulls).map((p) => ({ number: p.number, title: p.title, user: p.user?.login, draft: p.draft, url: p.html_url, updated: p.updated_at })),
    runs: arr(runs?.workflow_runs).map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, url: r.html_url, date: r.created_at })),
    alerts: {
      dependabot: Array.isArray(dependabot) ? dependabot.length : null,
      secretScanning: Array.isArray(secrets) ? secrets.length : null,
      codeScanning: Array.isArray(codescan) ? codescan.length : null,
    },
    protected: !protection?.error,
  };
}
