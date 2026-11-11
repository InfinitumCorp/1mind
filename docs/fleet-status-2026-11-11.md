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
| Built | 27 | 1mind, aether, aleph-pr, architect, argus-military-reference, argus-odin-reference, capital-chronicles, Conjure, cumulus-exchange, cumulus-mail, eidetic, eon, fabric, firmament-launch, hrvst, infinitum-academy, infinitum-corporation-site, infinitum-defense-site, infinitum-nexus, infinitum-revenue, odin, odin-daemon, scalvs-ai, scalvs-ru, veil-vpn, williamaaronturner-redesign, zerkalo |
| Failed | 0 |  |
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

Repos with no `build` script get install (and typecheck, when present) only: 1mind, aether, Conjure, eon, fabric, firmament-launch, hrvst, odin.

## Repo defects found and fixed (merged 2026-11-11)

| Repo | Problem | Fix |
|---|---|---|
| aleph-pr | Static site still carried TanStack app-builder scaffolding; `build` called the never-committed `scripts/with-app-env.mjs`, then `db:migrate`. | [InfinitumCorp/aleph-pr#2](https://github.com/InfinitumCorp/aleph-pr/pull/2): `vercel.json` serves the files as-is; scaffolding removed. |
| hrvst | Typecheck failed with 7× TS5097: Node type-stripping needs `.ts` import paths. | [InfinitumCorp/hrvst#4](https://github.com/InfinitumCorp/hrvst/pull/4): `allowImportingTsExtensions` + `erasableSyntaxOnly`. Typecheck 0 errors, tests 10/10. |
| infinitum-academy | No TypeScript in the repo, but a leftover `"typecheck": "tsc --noEmit"` made `whop apps deploy` fail at its typecheck step. | [InfinitumCorp/infinitum-academy#2](https://github.com/InfinitumCorp/infinitum-academy/pull/2): script removed; the Whop CLI skips the step when it is absent. |

Security follow-up: the critical `golang.org/x/crypto` advisories in infinitum-nexus are resolved. #72 was superseded by #76, #81 and #83, and both VEIL Go modules are on v0.58.0.

## New repositories seen

- **scalvs-ru**: static site, builds.
- **veil-phase1**: VEIL phase-1 working set (scripts, patches, QA); no package manifest.
- **flower-pollen**: empty (initial commit only).

None of the three are in the product ontology yet; they show under "Unassigned".

## Workstation notes

- Internet goes through the Happ VPN tunnel. When it stalls, all traffic stops while the physical Ethernet link still works. Switching Happ server, or routing `github.com`, `api.github.com`, `githubusercontent.com` and `registry.npmjs.org` direct, stops the drops.
- Rust is the windows-gnu toolchain without MinGW. Installing MinGW-w64 (for `dlltool`) or the MSVC toolchain would let aether's core link instead of type-check.
