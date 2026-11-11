// Build strategies: detect each product's toolchain(s) and build it inside the 1MIND workspace.
//
// A repo can be one toolchain at the root, several components in subdirectories (aether, fabric),
// or nothing buildable at all (docs, content). Every outcome is recorded with a reason, so
// "skipped" always says why. A build never runs side-effect steps (migrations, deploys, publishes).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoDir } from "./github.js";
import { load, save } from "./store.js";

const has = (dir, f) => fs.existsSync(path.join(dir, f));
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

/** `npm run <name>` segments matching this are side effects, never part of a 1MIND build. */
export const SIDE_EFFECT = /^(db:|migrate|deploy|release|publish|seed|upload|push)/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "dist", "build", "target", "out", "vendor", ".venv", "venv", "__pycache__", "examples", "test", "tests", ".github", "supabase"]);
const PMS = new Set(["npm", "pnpm", "yarn", "npx"]);
const SYSTEM = new Set(["node", "bash", "sh", "python", "python3", "go", "cargo", "git", "java", "cmd", "npm", "pnpm", "yarn", "npx", "corepack"]);
const BIN_PKG = { tsc: "typescript", "vue-tsc": "vue-tsc", next: "next", astro: "astro", vite: "vite", tsx: "tsx", esbuild: "esbuild" };
const DOC_EXT = new Set(["md", "mdx", "txt", "rst", "pdf", "docx", "doc", "xlsx", "csv", "sql"]);
const SCRIPT_EXT = new Set(["js", "mjs", "cjs", "ts", "py", "sh", "ps1", "patch", "diff"]);
const MEDIA_EXT =new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mov", "psd", "ai", "pdf", "html", "json", "yml", "yaml", "txt", "md", "css"]);

/** The toolchain at exactly `dir`, or null. */
export function detect(dir, { loose = true } = {}) {
  if (has(dir, "package.json")) {
    const pkg = readJson(path.join(dir, "package.json")) || {};
    const pm = has(dir, "pnpm-lock.yaml") || has(dir, "pnpm-workspace.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : "npm";
    return {
      kind: "node",
      pm,
      workspace: has(dir, "pnpm-workspace.yaml") || Array.isArray(pkg.workspaces) || Boolean(pkg.workspaces?.packages),
      scripts: pkg.scripts || {},
      lock: has(dir, "pnpm-lock.yaml") || has(dir, "yarn.lock") || has(dir, "package-lock.json"),
    };
  }
  if (has(dir, "gradlew") || has(dir, "build.gradle") || has(dir, "build.gradle.kts") || has(dir, "settings.gradle.kts")) {
    const files = ["build.gradle.kts", "build.gradle", "app/build.gradle.kts", "app/build.gradle"].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
    const android = files.some((f) => /com\.android/.test(fs.readFileSync(f, "utf8")));
    return { kind: "gradle", android };
  }
  if (has(dir, "Cargo.toml")) {
    const toml = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    return { kind: "rust", wasm: /wasm-bindgen/.test(toml) && /cdylib/.test(toml) };
  }
  if (has(dir, "go.mod")) return { kind: "go" };
  if (has(dir, "pyproject.toml") || has(dir, "requirements.txt") || has(dir, "setup.py")) return { kind: "python" };
  const entries = loose ? safeList(dir) : [];
  if (entries.some((e) => e.isFile() && e.name.endsWith(".py")) || entries.some((e) => e.isDirectory() && has(path.join(dir, e.name), "__init__.py")))
    return { kind: "python", note: "no requirements file; compile check only" };
  if (has(dir, "index.html")) return { kind: "static" };
  return null;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Buildable components below `root` (depth 1-2), for repos with no root manifest. */
export function findComponents(root, maxDepth = 2) {
  const found = [];
  const walk = (rel, depth) => {
    for (const e of safeList(path.join(root, rel))) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      const t = detect(path.join(root, sub), { loose: false });
      if (t) found.push({ path: sub, t });
      else if (depth < maxDepth) walk(sub, depth + 1);
    }
  };
  walk("", 1);
  return found;
}

/** Why a repo with no buildable component has nothing to build. */
export function classifyFiles(files) {
  const ext = files.map((f) => (f.includes(".") ? f.split(".").pop().toLowerCase() : ""));
  const n = ext.length || 1;
  const docs = ext.filter((e) => DOC_EXT.has(e)).length;
  const media = ext.filter((e) => MEDIA_EXT.has(e)).length;
  const scripts = ext.filter((e) => SCRIPT_EXT.has(e)).length;
  if (!files.length) return { kind: "empty", note: "empty repository (no files committed)" };
  if (docs / n >= 0.6) return { kind: "docs", note: `documentation only (${docs}/${ext.length} files are docs)` };
  if (media / n >= 0.6) return { kind: "content", note: `content/assets only (${media}/${ext.length} files are media, pages or data)` };
  if (scripts / n >= 0.5) return { kind: "scripts", note: `loose scripts and patches, no package manifest (${scripts}/${ext.length} files are scripts)` };
  return { kind: "unknown", note: `no recognised manifest (${ext.length} files)` };
}

/** Path of a locally installed package binary's JS entry, relative to `dir`, or null. */
export function resolveBin(dir, name, roots = [dir]) {
  for (const base of roots) {
    for (const pkgName of [BIN_PKG[name], name].filter(Boolean)) {
      const pj = path.join(base, "node_modules", pkgName, "package.json");
      const pkg = readJson(pj);
      if (!pkg?.bin) continue;
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[name];
      if (!rel) continue;
      return path.relative(dir, path.join(base, "node_modules", pkgName, rel)).split(path.sep).join("/");
    }
  }
  return null;
}

/**
 * Turns a package.json build script into exec steps.
 * - `a && b` runs as separate steps, so a side-effect segment (`npm run db:migrate`) can be dropped.
 * - Local binaries (vite, tsc) run as `node <bin.js>`: no shell, no `.cmd` shim, works on Windows.
 * - `node wrapper.mjs vite build` (the app-builder env wrapper) has its `vite` rewritten the same way.
 * Scripts with shell syntax beyond `&&` fall back to `<pm> run <name>`.
 */
export function scriptSteps(script, { pm = "npm", name = "build", dir = ".", roots } = {}) {
  const warnings = [];
  const fallback = () => {
    if (/run\s+(db:|migrate|deploy|publish|seed)/.test(script)) warnings.push(`"${name}" contains a side-effect step but uses shell syntax 1MIND cannot split; running it as-is`);
    return { steps: [[pm, ["run", name]]], warnings };
  };
  if (/[|;<>`$"'()]/.test(script.replace(/&&/g, "")) || /\|\|/.test(script)) return fallback();
  const steps = [];
  for (const seg of script.split("&&").map((s) => s.trim()).filter(Boolean)) {
    const [cmd, ...rest] = seg.split(/\s+/);
    if (PMS.has(cmd) && rest[0] === "run" && SIDE_EFFECT.test(rest[1] || "")) {
      warnings.push(`skipped side-effect step "${seg}"`);
      continue;
    }
    if (cmd === "node" && rest.length >= 2) {
      const bin = rest[1].startsWith("-") ? null : resolveBin(dir, rest[1], roots);
      steps.push(bin ? ["node", [rest[0], "node", bin, ...rest.slice(2)]] : ["node", rest]);
      continue;
    }
    if (SYSTEM.has(cmd)) {
      steps.push([cmd, rest]);
      continue;
    }
    const bin = resolveBin(dir, cmd, roots);
    if (bin) steps.push(["node", [bin, ...rest]]);
    else return fallback();
  }
  return { steps, warnings };
}

function installStep(t) {
  if (t.pm === "pnpm") return ["pnpm", ["install", "--frozen-lockfile"]];
  if (t.pm === "yarn") return ["yarn", ["install", "--frozen-lockfile"]];
  return t.lock ? ["npm", ["ci", "--no-audit", "--no-fund"]] : ["npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"]];
}

/** Environment for builds: Git Bash on PATH (Windows) so `bash scripts/*.sh` works. */
export function buildEnv(env = process.env, platform = process.platform) {
  if (platform !== "win32") return {};
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const gitBin = "C:\\Program Files\\Git\\bin";
  const cur = env[key] || "";
  if (!fs.existsSync(path.join(gitBin, "bash.exe")) || cur.toLowerCase().includes(gitBin.toLowerCase())) return {};
  return { [key]: `${cur};${gitBin}` };
}

const once = (fn) => {
  let v;
  return () => (v === undefined ? (v = fn()) : v);
};
const tryRun = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return "";
  }
};
const rustTargets = once(() => tryRun("rustup", ["target", "list", "--installed"]).split(/\r?\n/).filter(Boolean));
const onPath = (exe) => (process.env.PATH || process.env.Path || "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, exe)));
/** True on a windows-gnu Rust host that has no MinGW dlltool to link raw-dylib imports. */
export const gnuWithoutDlltool = once(() => process.platform === "win32" && /host: \S*windows-gnu/.test(tryRun("rustc", ["-vV"])) && !onPath("dlltool.exe"));

/** Builds one component; returns { status, warnings, error, packages? }. */
async function buildComponent(dir, t, { exec, log, env }) {
  const warnings = [];
  const run = (cmd, args, cwd = dir, opts = {}) => exec(cmd, args, { cwd, log, env, ...opts });
  switch (t.kind) {
    case "static":
      return { status: "ok", note: "static site, nothing to compile", warnings };
    case "python":
      await run("python", ["-m", "compileall", "-q", "."]);
      if (t.note) warnings.push(t.note);
      return { status: "ok", warnings };
    case "gradle": {
      const task = t.android ? "assembleDebug" : "assemble";
      // Explicit .\ path: cmd ignores the current directory when NoDefaultCurrentDirectoryInExePath is set.
      if (process.platform === "win32") await run("cmd", ["/c", ".\\gradlew.bat", task]);
      else await run("./gradlew", [task]);
      return { status: "ok", warnings };
    }
    case "rust": {
      if (t.wasm) {
        // wasm-bindgen crates target the browser; the host toolchain is irrelevant. The
        // wasm-bindgen CLI step is not run: it rewrites committed output in the repo.
        if (!rustTargets().includes("wasm32-unknown-unknown")) throw new Error("wasm crate needs: rustup target add wasm32-unknown-unknown");
        await run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"]);
        return { status: "ok", warnings };
      }
      if (gnuWithoutDlltool()) {
        // windows-gnu without MinGW cannot link raw-dylib crates (windows-sys): a workstation
        // limitation, not a product defect. Type-check instead and say so.
        await run("cargo", ["check", "--release"]);
        warnings.push("type-checked only (cargo check): linking needs MinGW dlltool, which this workstation's windows-gnu Rust toolchain lacks");
        return { status: "ok", warnings };
      }
      await run("cargo", ["build", "--release"]);
      return { status: "ok", warnings };
    }
    case "go":
      await run("go", ["build", "./..."]);
      return { status: "ok", warnings };
    case "node": {
      await run(...installStep(t));
      let result = { status: "ok", warnings };
      if (t.scripts.build) {
        const s = scriptSteps(t.scripts.build, { pm: t.pm, dir });
        warnings.push(...s.warnings);
        for (const [c, a] of s.steps) await run(c, a);
      } else if (t.workspace && t.pm === "pnpm") {
        result = await buildPnpmWorkspace(dir, { exec, log, env, warnings });
      } else if (t.workspace && t.pm === "npm") {
        await run("npm", ["run", "build", "--workspaces", "--if-present"]);
      } else warnings.push("no build script; install only");
      if (t.scripts.typecheck) {
        if (/^tsc\b/.test(t.scripts.typecheck) && !resolveBin(dir, "tsc")) warnings.push("typecheck skipped: it calls tsc but typescript is not installed");
        else {
          try {
            await run(t.pm, ["run", "typecheck"]);
          } catch (e) {
            const msg = `typecheck: ${e.message.slice(0, 300)}`;
            result = { ...result, status: result.status === "ok" ? "failed" : result.status, error: [result.error, msg].filter(Boolean).join(" | ") };
          }
        }
      }
      return result;
    }
    default:
      return { status: "skipped", warnings };
  }
}

/** pnpm workspace: build each package separately so one broken package doesn't hide the rest. */
async function buildPnpmWorkspace(root, { exec, log, env, warnings }) {
  const { stdout } = await exec("pnpm", ["-r", "ls", "--json", "--depth", "-1"], { cwd: root, capture: true, quiet: true, env });
  let pkgs = [];
  try {
    pkgs = JSON.parse(stdout);
  } catch {}
  const packages = [];
  for (const p of pkgs) {
    if (!p.path || path.resolve(p.path) === path.resolve(root)) continue;
    const script = readJson(path.join(p.path, "package.json"))?.scripts?.build;
    if (!script) continue;
    const rel = path.relative(root, p.path).split(path.sep).join("/");
    log(`── ${rel}`);
    const s = scriptSteps(script, { pm: "pnpm", dir: p.path, roots: [p.path, root] });
    warnings.push(...s.warnings.map((w) => `${rel}: ${w}`));
    try {
      for (const [c, a] of s.steps) await exec(c, a, { cwd: p.path, log, env });
      packages.push({ path: rel, status: "ok" });
    } catch (e) {
      log(`✗ ${rel}: ${e.message}`, "error");
      packages.push({ path: rel, status: "failed", error: e.message.slice(0, 300) });
    }
  }
  const failed = packages.filter((p) => p.status === "failed");
  return {
    status: !failed.length ? "ok" : failed.length === packages.length ? "failed" : "partial",
    error: failed.length ? `failed: ${failed.map((p) => p.path).join(", ")}` : undefined,
    packages,
    warnings,
  };
}

/** What 1MIND will build in a checkout: root toolchain, components, or a reason there is nothing. */
export function plan(dir, files = []) {
  const root = detect(dir);
  if (root && root.kind !== "static") return { mode: "single", components: [{ path: ".", t: root }] };
  const comps = findComponents(dir);
  if (comps.some((c) => c.t.kind !== "static")) return { mode: "multi", components: comps };
  if (root) return { mode: "single", components: [{ path: ".", t: root }] };
  return { mode: "none", ...classifyFiles(files) };
}

export function buildState() {
  return load("builds", {});
}

const overall = (statuses) => {
  const real = statuses.filter((s) => s !== "skipped");
  if (!real.length) return "skipped";
  if (real.every((s) => s === "ok")) return "ok";
  if (real.every((s) => s === "failed")) return "failed";
  return "partial";
};

export async function buildRepo(name, { exec, log }) {
  const dir = repoDir(name);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${name} is not pulled yet; pull it first`);
  const started = Date.now();
  const { stdout: head } = await exec("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { capture: true, quiet: true });
  const { stdout: lsFiles } = await exec("git", ["-C", dir, "ls-files"], { capture: true, quiet: true });
  const p = plan(dir, lsFiles.split("\n").filter(Boolean));
  const record = (rec) => {
    const all = buildState();
    all[name] = { at: new Date().toISOString(), durationMs: Date.now() - started, head: head.trim(), ...rec };
    save("builds", all);
    return all[name];
  };

  if (p.mode === "none") {
    log(`nothing to build: ${p.note}`);
    return record({ status: "skipped", toolchain: p.kind, note: p.note, warnings: [] });
  }

  log(`strategy: ${p.mode} · ${p.components.map((c) => `${c.path}=${c.t.kind}`).join(", ")}`);
  const env = buildEnv();
  const components = [];
  for (const c of p.components) {
    if (p.mode === "multi") log(`━ component ${c.path} (${c.t.kind})`);
    try {
      const r = await buildComponent(path.join(dir, c.path), c.t, { exec, log, env });
      components.push({ path: c.path, toolchain: c.t.kind, ...r });
    } catch (e) {
      log(`✗ ${c.path}: ${e.message}`, "error");
      components.push({ path: c.path, toolchain: c.t.kind, status: "failed", error: e.message.slice(0, 500), warnings: [] });
    }
  }
  const status = overall(components.map((c) => c.status));
  const warnings = components.flatMap((c) => (c.warnings || []).map((w) => (p.mode === "multi" ? `${c.path}: ${w}` : w)));
  const errors = components.filter((c) => c.error).map((c) => (p.mode === "multi" ? `${c.path}: ${c.error}` : c.error));
  const rec = record({
    status,
    toolchain: p.mode === "multi" ? "multi" : components[0].toolchain,
    note: components.length === 1 ? components[0].note : `${components.length} components`,
    warnings,
    error: errors.join(" || ").slice(0, 800) || undefined,
    components: p.mode === "multi" || components[0].packages ? components : undefined,
  });
  for (const w of warnings) log(`⚠ ${w}`);
  if (status === "failed") throw new Error(rec.error || "build failed");
  return rec;
}
