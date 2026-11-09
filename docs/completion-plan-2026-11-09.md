# Completion plan: 2026-11-09

Supersedes the action list in [fleet-status-2026-11-08.md](fleet-status-2026-11-08.md). That file stays as the point-in-time snapshot.

## Where things stand

- **Local checkouts:** all 69 were fetched. 20 clean branches were fast-forwarded; nothing with local work was touched.
- **Open PRs:** 64 across InfinitumCorp. 22 are drafts and 42 are ready for review.
- **Of the 42 ready PRs:**
  - 7 can merge now: 6 green Dependabot PRs and 1 clean feature PR.
  - 21 have merge conflicts with `main`.
  - 14 are blocked by a broken check.

## Strategy

**1. Security fixes before features.** The 2026-11-08 red-team criticals come first.

**2. One owner per area.** On 2026-11-09 two sessions rebranded the Android icons at once and overwrote each other's installs. From now on, one session owns each area:

| Area | Owner |
|---|---|
| Icons | MasterBuild (fork), using the Arial style |
| FabriC++ | FABRIC build |
| VEIL VPN | VEIL VPN |

Before a session installs on the TECNO, it checks `ListAgents`.

**3. Rebase or close stale PRs.** 21 PRs conflict with `main` because `main` has moved on: Cloudflare Workers, the shared shell and the brand rollout.
- Rebase a PR only if its feature is still wanted.
- Close a PR whose work has already landed elsewhere, such as the duplicate shell or brand PRs.

**4. Russia without a VPN is a launch requirement.** It was tested from the TECNO on Russian Wi-Fi with the VPN off.

| Host | Result |
|---|---|
| Cloudflare | blocked: times out, or large files stall |
| Vercel | times out |
| Supabase | times out |
| GitHub Pages | loads in about 1 s |
| Gcore | loads in about 1 s |

Any product that must work in Russia needs a mirror that is reachable from there. Any product that signs in through Supabase will fail there today.

**5. Nothing ships without a test on the TECNO** with the VPN off.

## Do now (ordered)

### A. Security and CI

| # | Item | Status |
|---|---|---|
| A1 | Merge infinitum-nexus #80–85: GitHub Actions bumps, `x/crypto` 0.58.0, `x/sys` | Green and clean; needs the user's OK |
| A2 | cumulus-mail and cumulus-exchange: one branch per repo applying `better-auth`, `zod`, `seroval` and `fast-xml-parser`, with a regenerated `package-lock.json` | Dependabot's lockfiles miss `lru-cache@11.5.3`, so `npm ci` fails. This one branch replaces mail #13/15/16/17 and exchange #15/16/17/19 |
| A3 | Apply the same `better-auth` upgrade to odin-daemon | Still on `~1.6.30` |
| A4 | Hold infinitum-nexus #86 (TypeScript 7), #87 (postal-mime 4) and #88 (@types/node 26) | Major versions that fail CI; need code changes |

### B. Build defects from the fleet report (all still open)

| # | Repo | Fix |
|---|---|---|
| B1 | aleph-pr | Remove the stale `package.json`; the site is a static `index.html` |
| B2 | hrvst | Add `allowImportingTsExtensions` to `tsconfig.json` |
| B3 | infinitum-academy | Add `typescript` as a dev dependency |
| B4 | cumulus-exchange, cumulus-mail, odin-daemon | Make `scripts/with-app-env.mjs` call `spawn` with a shell on Windows |

### C. Russia reach

| # | Item | Status |
|---|---|---|
| C1 | `ru.scalvs.app` | **Live**: GitHub Pages, HTTPS enforced, tested on the TECNO. Runs in demo mode with no API |
| C2 | SCALVS live AI on the mirror | Add CORS for `https://ru.scalvs.app` to the `scalvs-ai` Worker's `/api/*`; needs a Worker deploy from the current branch |
| C3 | Same mirror for FabriC++, VEIL and Cumulus | Static front ends on GitHub Pages; their APIs need a Russia-reachable path |
| C4 | Supabase from Russia | Sign-in times out. Decide between a proxy and a reachable auth host before marketing in Russia |
| C5 | VEIL VPN WireGuard tunnel | Blocked in Russia. A separate transport fix is needed |
| C6 | Legal | Review sanctions before taking payments from, or marketing SCALVS in, Russia |

### D. Feature PRs to resolve (conflicting, needs a decision each)

| Area | PRs | Decision |
|---|---|---|
| Shared shell and brand | infinitum-nexus #53, #6; aether #1; eidetic #1; odin #1; odin-daemon #1 | Rebase onto the white/black layout on `main`, or close as superseded |
| Open-weight AI | infinitum-nexus #54; architect #4; cumulus-mail #7 | Rebase, since the strategy is OmniRoute first |
| Labyrinth and Cumulus ID | infinitum-nexus #26, #35, #48 (mergeable, CI pending); eon #1; cumulus-exchange #3, #4 | Land #48 first, then rebase the rest onto it |
| Architect rename | RULES #1; infinitum-nexus #60 | Rebase |
| FabriC++ Android | fabric #11 | Rebase; FABRIC build owns this |
| Other | cumulus-exchange #14; cumulus-mail #4; infinitum-revenue #6 | Rebase |
| SCALVS prototype | infinitum-corporation-site #2 | Mergeable, but no CI ran. Check it against the Cloudflare Workers build that is now live |

### E. On the user (not codeable)

- Payments go-live: run `Go-Live-Payments.cmd`.
- Decide whether to put Cumulus Mail behind an access wall.
- Upload the VEIL zip to the Chrome Web Store.
- Transfer `mttrn.app` to its new registrar.
- VEIL VPN release build: it is signed with the VEIL upload key and must be built and signed by the user.
- TANK X: it doesn't show up in adb yet (MTP only). Try a different cable or port, set the default USB mode to file transfer, or use wireless debugging.

## Gates before "shipped"

- Builds green in CI on `main`.
- No critical or high dependency findings left open.
- Tested on the TECNO with the VPN off: the app loads and its main flow works.
- Military products (ODIN and the MIL editions) stay out of public material.
