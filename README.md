# 1MIND

Infinitum Corporation's proprietary internal command platform. One console that controls every Infinitum product. **Not client facing.**

```
GitHub (InfinitumCorp/*) ──► PULL ──► BUILD ──► RED TEAM ──► FINDINGS
                                 ▲                               │
            CONJURE (intent → verified deliverable) ◄────────────┘
```

| Module | What it does |
|---|---|
| **Overview** | Ontology graph of every product by division, KPIs, threat posture, push and audit streams. |
| **Products** | Registry of all repos mapped to Infinitum products and divisions (`src/lib/products.js`). Drawer shows live commits, PRs, CI runs, GitHub security alerts, branch protection. |
| **Pipeline** | Pull every repo into `workspace/repos` and build it with its own toolchain (pnpm / npm / yarn / python / gradle / cargo / go). Fleet or per-product. |
| **Red Team** | Adversarial self-assessment of Infinitum assets: secret sweep, dependency audit, GitHub posture, external surface (DNS, TLS, headers, exposed `.git`/`.env`). Findings are triaged in place. |
| **Conjure** | The Conjure engine, built in (`src/conjure`): one-line intent → planned, forged, verified, repaired deliverable. Previews served from a separate origin (port 4401). |
| **Jobs** | Every long operation is a cancellable job with a live log. |
| **Audit** | Append-only `data/audit.jsonl` of every action, login and scan. |

## Run

```bash
npm install
npm start          # http://127.0.0.1:4400
```

Sign in with Cumulus ID (id.cumuluscloud.app). People without one press **Create a Cumulus ID** on the same screen and come back signed in. Set `CID_OWNERS` (comma-separated CIDs, usernames or emails) to say who may enter; nobody can until it is set. `CID_CLIENT_ID` defaults to `1mind`, `CID_ISSUER` to `https://id.cumuluscloud.app` (point it at a mirror that loads in Russia), and `ONEMIND_PUBLIC_URL` to `http://127.0.0.1:<port>` (the redirect is `<that>/auth/cid/callback`, which must be on the issuer's allowlist). `.1mind-token` / `ONEMIND_TOKEN` is now only the server's cookie-signing secret; nobody types it. GitHub access uses the machine's `gh` login; no GitHub token is stored by 1MIND. For live Conjure put `ANTHROPIC_API_KEY` in `.env`; without it Conjure runs on its offline mock provider.

## Geo routing

Off by default. Policy decisions, audit lines, and red-team scan logs stay the same until an operator turns it on. The switch never allows or blocks a target; it only annotates country and domain category.

- Console: **GEO OFF / GEO ON** in the top bar. The choice is stored in `data/settings.json`.
- Environment: `INFINITUM_GEO_ENABLED=on` or `off` overrides the saved switch for that process.
- CLI: `npm start -- --geo` or `npm start -- --no-geo` writes the saved switch.

Datasets are the v2fly `geoip.dat` and `dlc.dat` (saved as `geosite.dat`) releases pinned in `data/geo/lock.json`. They are not committed. `npm run geo:fetch` downloads them and stops if the official `.sha256sum` asset disagrees with the lockfile. Attribution is in `THIRD_PARTY_NOTICES.md`.

## Red team rules of engagement

- Repository modules only touch Infinitum repos pulled into the workspace.
- External modules only run against domains an operator added to scope with an ownership/authorization attestation (recorded with operator name and time).
- External checks are read-only and low-rate: DNS lookups, one TLS handshake, and a handful of GETs spaced 300 ms apart. No exploitation, brute force, fuzzing, or load.
- Every run, scope change and triage decision is audited.

## Security

- Binds to `127.0.0.1` only. Expose it remotely only behind an authenticated tunnel (e.g. Cloudflare Access / Tailscale).
- HttpOnly + SameSite=Lax session cookie (Lax so the Cumulus ID redirect can land), Cumulus ID sign-in (PKCE S256) with a signed, expiring session cookie, CSRF header on every state change, strict CSP, no third-party scripts.
- Child processes never go through a shell except package-manager shims on Windows, whose arguments are allow-listed.
- Secrets found by the sweep are masked in findings.

`npm test` runs the vendored Conjure test suite.
