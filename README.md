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

The top bar carries the Cumulus://ID account bar (`public/cumulus-bar.js`, a copy of `https://id.cumuluscloud.app/id/bar.js`, because the CSP allows scripts from this origin only): the signed-in person's initial, a menu with their name and `@cumuluscloud.app` address, **Manage your Cumulus://ID**, Cumulus://Mail, the Infinitum product launcher and **Sign out** (`/logout`). 1MIND keeps its own session cookie; `GET /api/me` tells the bar who is signed in.

## OpenClaw

The **OPENCLAW** view (key 6) runs an [OpenClaw](https://github.com/openclaw/openclaw) agent gateway inside 1MIND and gives operators a console to talk to its agents.

- **Install** puts the pinned runtime (openclaw 2026.11.3, MIT, ~275 MB) in `workspace/openclaw`. It is not a 1MIND dependency, so nothing is downloaded until someone presses the button.
- **Start gateway** writes `workspace/openclaw/state/openclaw.json` and runs the gateway bound to loopback on `OPENCLAW_PORT` (18789), with token auth (a random token kept in `state/gateway-token`, or `OPENCLAW_GATEWAY_TOKEN`) and the OpenAI-compatible `/v1/chat/completions` endpoint switched on. The gateway stops when 1MIND stops.
- The agent model is `OPENCLAW_MODEL`, default `anthropic/<CONJURE_MODEL>`; it uses the same `ANTHROPIC_API_KEY`.
- To use a gateway you already run, set `OPENCLAW_URL` (and `OPENCLAW_GATEWAY_TOKEN`). 1MIND refuses public addresses: OpenClaw's chat endpoint is full operator access to the gateway and must stay on loopback or a private network (10/8, 172.16/12, 192.168/16, 100.64/10, `*.ts.net`).
- Each turn keeps an OpenClaw session per thread. Install, start, stop and every chat turn are audited (agent and message length, never the content). Gateway output is shown with the token and API keys redacted.

## Deploy (Russia)

1MIND runs on the Yandex Cloud VM `conjure-russia` at https://1mind-ru.infinitumcorporation.ai, with Conjure deliverables on https://1mind-ru-preview.infinitumcorporation.ai. Both hosts are DNS-only (grey-cloud) A records pointing at the VM, so they load in Russia without a VPN and everywhere else too. Config is in `deploy/russia/`:

- `install.sh`: run on the VM with `sudo bash deploy/russia/install.sh <branch>`. It is idempotent: it creates the `onemind` user, installs git, gh and python3, clones to `/opt/1mind`, runs `npm ci`, creates `/etc/1mind/env` with a random cookie secret, installs the systemd unit, gets a Let's Encrypt certificate (webroot `/var/www/acme`) and enables nginx.
- `1mind.service`: sandboxed systemd unit, bound to 127.0.0.1:4400 (preview on :4401). It trusts `X-Real-IP` only from the local nginx.
- `nginx-1mind.conf` + `1mind-proxy.conf`: TLS, HSTS, noindex, and rate limits on `/auth/` and the API. The preview host is GET-only.
- `env.example`: the template for `/etc/1mind/env`. Set `CID_OWNERS` there; never commit the real file, and never add `ANTHROPIC_API_KEY` on a server in Russia (Conjure runs on its mock).

After the first install, sign GitHub in once as the service user: `sudo -u onemind -H gh auth login`, then `sudo systemctl restart 1mind`. Sign-in needs `https://1mind-ru.infinitumcorporation.ai` on the `1mind` client's origins in infinitum-nexus `packages/cid/src/id-clients.ts`.

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
