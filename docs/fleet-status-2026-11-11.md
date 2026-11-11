# 1MIND fleet status: 2026-11-11

Second full run of 1MIND across every InfinitumCorp repository (pull + build), the first on the new build strategies.
Workstation: Windows, Node 26.13, pnpm 10.28, Python 3.14, Go 1.27, Rust (windows-gnu), JDK 21, Android SDK, Git Bash.

## What changed in how 1MIND builds

| Strategy | Why |
|---|---|
| Build scripts are split on `&&`; side-effect steps (`db:migrate`, `deploy`, `publish`, `seed`) are skipped with a warning | The app-builder repos chain `npm run db:migrate` into `build`. A build must never touch a database. |
| Local binaries (vite, tsc) run as `node <bin.js>`, including inside the `with-app-env.mjs` wrapper | Fixes `spawn vite ENOENT` on Windows without changing the product repos. |
| Git Bash is on PATH for builds; Gradle runs `.\gradlew.bat` explicitly | `bash scripts/*.sh` and Android wrappers now run on Windows (cmd ignores the current folder when `NoDefaultCurrentDirectoryInExePath` is set). |
| pnpm workspaces build per package; a broken package makes the repo **partial**, not failed | One package no longer hides the state of the rest. |
| Typecheck is skipped with a warning when it calls `tsc` and TypeScript is not installed | Reports the missing dependency instead of failing a good build. |
| Repos with no root manifest build per component (depth 2) | aether (gradle, cargo x2, npm, static) and fabric (npm, gradle, static). |
| Rust on windows-gnu without MinGW `dlltool` falls back to `cargo check` | Workstation limitation, not a product defect; recorded as a warning. |
| Python detected from root `.py` files / packages without a requirements file | argus repos now get a compile check. |
| Nothing-to-build repos say why: docs, content, loose scripts, empty | Every "skipped" carries a reason. |
| Pull stashes build byproducts in 1MIND's mirrors; npm no longer writes lockfiles there | The first pull failed on odin, eon and nexus because earlier builds dirtied the checkouts. |
| Fleet steps that fail on a network error wait for GitHub + npm and retry | The workstation's VPN tunnel (Happ / xray) drops for minutes at a time; drops were showing up as false build failures. |

## Results (34 repos)

| Result | Count | Repos |
|---|---|---|
| Built | 25 | 1mind, aether, architect, argus-military-reference, argus-odin-reference, capital-chronicles, Conjure, cumulus-exchange, cumulus-mail, eidetic, eon, fabric, firmament-launch, infinitum-academy, infinitum-corporation-site, infinitum-defense-site, infinitum-nexus, infinitum-revenue, odin, odin-daemon, scalvs-ai, scalvs-ru, veil-vpn, williamaaronturner-redesign, zerkalo |
| Failed | 2 | aleph-pr, hrvst |
| Nothing to build | 7 | cos-workspace-backup (content), flower-pollen (empty), InfinitumCorp (docs), RULES (docs), scalvs-ai-metatron-bot (docs), ukraine-files-flyers (content), veil-phase1 (scripts) |

Previous run (2026-11-08, 34 repos incl. 3 since excluded): 15 built, 10 failed, 9 nothing to build.

### Built with warnings

| Repo | Warning |
|---|---|
| aether | core: type-checked only (cargo check): linking needs MinGW dlltool, which this workstation's windows-gnu Rust toolchain lacks |
| argus-military-reference | no requirements file; compile check only |
| argus-odin-reference | no requirements file; compile check only |
| cumulus-exchange | skipped side-effect step "npm run db:migrate" |
| cumulus-mail | skipped side-effect step "npm run db:migrate" |
| infinitum-academy | typecheck skipped: it calls tsc but typescript is not installed |

Repos with no `build` script get install (and typecheck, when present) only: 1mind, aether, Conjure, eon, fabric, firmament-launch, odin.

### Failures

| Repo | Error |
|---|---|
| aleph-pr | `node exited with code 1: } /  / Node.js v26.13.0` |
| hrvst | `typecheck: npm exited with code 2` |

## Real defects (fix in the product repo)

| Repo | Problem | Fix |
|---|---|---|
| aleph-pr | `build` runs `node scripts/with-app-env.mjs`, but `scripts/` is not committed. The site is a static `index.html`; the `package.json` is leftover app-builder scaffolding. | Delete the stale `package.json`/lockfile, or commit `scripts/`. |
| hrvst | Typecheck fails with TS5097: imports end in `.ts` but `tsconfig.json` lacks `allowImportingTsExtensions`. | Add `"allowImportingTsExtensions": true` (with `"noEmit": true`). |
| infinitum-academy | Builds, but `typecheck` calls `tsc` and `typescript` is not a dependency (now a warning, not a failure). | `npm i -D typescript`. |

## New repositories seen

- **scalvs-ru**: static site, builds.
- **veil-phase1**: VEIL phase-1 working set (scripts, patches, QA); no package manifest.
- **flower-pollen**: empty (initial commit only).

None of the three are in the product ontology yet; they show under "Unassigned".

## Workstation notes

- Internet goes through the Happ VPN tunnel. When it stalls, all traffic stops while the physical Ethernet link still works. Switching Happ server, or routing `github.com`, `api.github.com`, `githubusercontent.com` and `registry.npmjs.org` direct, stops the drops.
- Rust is the windows-gnu toolchain without MinGW. Installing MinGW-w64 (for `dlltool`) or the MSVC toolchain would let aether's core link instead of type-check.
