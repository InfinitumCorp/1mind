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

Sign in with the token in `.1mind-token` (generated on first start) or set `ONEMIND_TOKEN` in `.env`. GitHub access uses the machine's `gh` login; no GitHub token is stored by 1MIND. For live Conjure put `ANTHROPIC_API_KEY` in `.env`; without it Conjure runs on its offline mock provider.

## Geo datasets

Optional cyber annotation for addresses and domain categories. Off unless `INFINITUM_GEO_ENABLED=1`. While it is off, audit entries, scan findings, and allow/deny decisions stay as they are. `npm run geo:fetch` downloads the pinned v2fly `geoip.dat` and `geosite.dat` (upstream asset `dlc.dat`) into `data/geo/` and stops if a file disagrees with the official `.sha256sum` or `geo.lock.json`. The binary datasets are gitignored. See `THIRD_PARTY_NOTICES`.

## Red team rules of engagement

- Repository modules only touch Infinitum repos pulled into the workspace.
- External modules only run against domains an operator added to scope with an ownership/authorization attestation (recorded with operator name and time).
- External checks are read-only and low-rate: DNS lookups, one TLS handshake, and a handful of GETs spaced 300 ms apart. No exploitation, brute force, fuzzing, or load.
- Every run, scope change and triage decision is audited.

## Security

- Binds to `127.0.0.1` only. Expose it remotely only behind an authenticated tunnel (e.g. Cloudflare Access / Tailscale).
- HttpOnly + SameSite=Strict session cookie, timing-safe token check, CSRF header on every state change, strict CSP, no third-party scripts.
- Child processes never go through a shell except package-manager shims on Windows, whose arguments are allow-listed.
- Secrets found by the sweep are masked in findings.

`npm test` runs the vendored Conjure test suite.
