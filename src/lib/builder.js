// Detects each product's toolchain and builds it inside the 1MIND workspace.
import fs from "node:fs";
import path from "node:path";
import { repoDir } from "./github.js";
import { load, save } from "./store.js";

const has = (dir, f) => fs.existsSync(path.join(dir, f));

export function detect(dir) {
  if (has(dir, "package.json")) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {}
    const pm = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : "npm";
    return {
      kind: "node",
      pm,
      workspace: has(dir, "pnpm-workspace.yaml") || Array.isArray(pkg.workspaces) || Boolean(pkg.workspaces?.packages),
      scripts: Object.keys(pkg.scripts || {}),
      lock: has(dir, "pnpm-lock.yaml") || has(dir, "yarn.lock") || has(dir, "package-lock.json"),
    };
  }
  if (has(dir, "pyproject.toml") || has(dir, "requirements.txt") || has(dir, "setup.py")) return { kind: "python" };
  if (has(dir, "gradlew") || has(dir, "build.gradle") || has(dir, "build.gradle.kts") || has(dir, "settings.gradle.kts")) return { kind: "gradle" };
  if (has(dir, "Cargo.toml")) return { kind: "rust" };
  if (has(dir, "go.mod")) return { kind: "go" };
  if (has(dir, "index.html")) return { kind: "static" };
  return { kind: "unknown" };
}

function steps(t) {
  switch (t.kind) {
    case "node": {
      const install =
        t.pm === "pnpm" ? ["pnpm", ["install", "--frozen-lockfile"]]
        : t.pm === "yarn" ? ["yarn", ["install", "--frozen-lockfile"]]
        : t.lock ? ["npm", ["ci", "--no-audit", "--no-fund"]] : ["npm", ["install", "--no-audit", "--no-fund"]];
      const s = [install];
      if (t.scripts.includes("build")) s.push([t.pm, ["run", "build"]]);
      else if (t.workspace && t.pm === "pnpm") s.push(["pnpm", ["-r", "--if-present", "run", "build"]]);
      else if (t.workspace && t.pm === "npm") s.push(["npm", ["run", "build", "--workspaces", "--if-present"]]);
      if (t.scripts.includes("typecheck")) s.push([t.pm, ["run", "typecheck"]]);
      return s;
    }
    case "python":
      return [["python", ["-m", "compileall", "-q", "."]]];
    case "gradle":
      return process.platform === "win32" ? [["cmd", ["/c", "gradlew.bat", "assemble"]]] : [["./gradlew", ["assemble"]]];
    case "rust":
      return [["cargo", ["build", "--release"]]];
    case "go":
      return [["go", ["build", "./..."]]];
    default:
      return [];
  }
}

export function buildState() {
  return load("builds", {});
}

export async function buildRepo(name, { exec, log }) {
  const dir = repoDir(name);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${name} is not pulled yet; pull it first`);
  const t = detect(dir);
  log(`toolchain: ${JSON.stringify(t)}`);
  const plan = steps(t);
  const started = Date.now();
  const record = (status, extra = {}) => {
    const all = buildState();
    all[name] = { status, toolchain: t.kind, at: new Date().toISOString(), durationMs: Date.now() - started, ...extra };
    save("builds", all);
  };
  if (t.kind === "static") {
    log("static site: index.html present, nothing to compile");
    record("ok", { note: "static" });
    return { status: "ok", toolchain: "static" };
  }
  if (!plan.length) {
    record("skipped", { note: `no build recipe for ${t.kind}` });
    return { status: "skipped", toolchain: t.kind };
  }
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { capture: true, quiet: true });
  try {
    for (const [cmd, args] of plan) await exec(cmd, args, { cwd: dir });
  } catch (e) {
    record("failed", { head: stdout.trim(), error: e.message.slice(0, 500) });
    throw e;
  }
  record("ok", { head: stdout.trim() });
  return { status: "ok", toolchain: t.kind, head: stdout.trim() };
}
