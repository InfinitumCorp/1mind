import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detect, findComponents, classifyFiles, resolveBin, scriptSteps, plan, buildEnv } from "../src/lib/builder.js";

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-build-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return root;
}

const withVite = () =>
  tree({
    "package.json": "{}",
    "node_modules/vite/package.json": JSON.stringify({ name: "vite", bin: { vite: "bin/vite.js" } }),
    "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc", tsserver: "./bin/tsserver" } }),
  });

test("app-builder wrapper: vite runs through node, db:migrate is dropped", () => {
  const dir = withVite();
  const { steps, warnings } = scriptSteps("node scripts/with-app-env.mjs vite build && npm run db:migrate", { dir });
  assert.deepEqual(steps, [["node", ["scripts/with-app-env.mjs", "node", "node_modules/vite/bin/vite.js", "build"]]]);
  assert.match(warnings[0], /skipped side-effect step "npm run db:migrate"/);
});

test("bare local binaries run as node <bin.js>; tsc resolves via typescript", () => {
  const dir = withVite();
  assert.deepEqual(scriptSteps("tsc --noEmit && vite build", { dir }).steps, [
    ["node", ["node_modules/typescript/bin/tsc", "--noEmit"]],
    ["node", ["node_modules/vite/bin/vite.js", "build"]],
  ]);
});

test("system commands (bash) pass through; shell syntax falls back to pm run", () => {
  const dir = withVite();
  assert.deepEqual(scriptSteps("bash scripts/build.sh", { dir }).steps, [["bash", ["scripts/build.sh"]]]);
  assert.deepEqual(scriptSteps("vite build || true", { pm: "pnpm", dir }).steps, [["pnpm", ["run", "build"]]]);
  assert.deepEqual(scriptSteps("unknown-tool go", { dir }).steps, [["npm", ["run", "build"]]]);
});

test("resolveBin searches extra roots (hoisted workspace deps)", () => {
  const root = withVite();
  const pkg = path.join(root, "apps", "web");
  fs.mkdirSync(pkg, { recursive: true });
  assert.equal(resolveBin(pkg, "vite", [pkg, root]), "../../node_modules/vite/bin/vite.js");
  assert.equal(resolveBin(pkg, "nope", [pkg, root]), null);
});

test("python is detected from root .py files without a requirements file", () => {
  const t = detect(tree({ "main.py": "print(1)\n", "argus/__init__.py": "" }));
  assert.equal(t.kind, "python");
  assert.match(t.note, /no requirements/);
});

test("multi-component repos are planned per component", () => {
  const dir = tree({
    "README.md": "x",
    "core/Cargo.toml": "[package]",
    "web/wasm/Cargo.toml": "[package]",
    "web/bridge/package.json": "{}",
    "android/gradlew": "",
    "android/build.gradle.kts": 'plugins { id("com.android.application") }',
    "docs/package.json": "{}",
    "node_modules/x/package.json": "{}",
  });
  const p = plan(dir);
  assert.equal(p.mode, "multi");
  const got = Object.fromEntries(p.components.map((c) => [c.path, c.t.kind]));
  assert.deepEqual(got, { android: "gradle", core: "rust", "web/bridge": "node", "web/wasm": "rust" });
  assert.equal(p.components.find((c) => c.path === "android").t.android, true);
  assert.equal(findComponents(dir).some((c) => c.path.startsWith("docs") || c.path.startsWith("node_modules")), false);
});

test("a root manifest wins over subdirectories", () => {
  const p = plan(tree({ "go.mod": "module x", "web/package.json": "{}" }));
  assert.equal(p.mode, "single");
  assert.equal(p.components[0].t.kind, "go");
});

test("repos with nothing to build get a reason", () => {
  assert.equal(classifyFiles(["README.md", "a.md", "b.md", "x.ts"]).kind, "docs");
  assert.equal(classifyFiles(["a.jpg", "b.jpg", "c.pdf", "README.md", "d.yml"]).kind, "content");
  assert.equal(classifyFiles(["a.bin", "b.dat"]).kind, "unknown");
  const p = plan(tree({ "README.md": "x" }), ["README.md"]);
  assert.equal(p.mode, "none");
  assert.match(p.note, /documentation only/);
});

test("buildEnv adds Git Bash to PATH only on Windows", () => {
  assert.deepEqual(buildEnv({ PATH: "/usr/bin" }, "linux"), {});
  const env = buildEnv({ Path: "C:\\Windows" }, "win32");
  if (fs.existsSync("C:\\Program Files\\Git\\bin\\bash.exe")) assert.equal(env.Path, "C:\\Windows;C:\\Program Files\\Git\\bin");
  else assert.deepEqual(env, {});
});

test("loose .py scripts and static pages in subfolders do not make a repo buildable", () => {
  const dir = tree({ "seo/audit.py": "x", "press/index.html": "<p>", "README.md": "x", "notes/a.md": "x", "notes/b.md": "x", "notes/c.md": "x" });
  const p = plan(dir, ["seo/audit.py", "press/index.html", "README.md", "notes/a.md", "notes/b.md", "notes/c.md"]);
  assert.equal(p.mode, "none");
  assert.match(p.note, /only/);
});
