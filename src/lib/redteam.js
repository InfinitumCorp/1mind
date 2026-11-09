// 1MIND Red Team: adversarial assessment of Infinitum's OWN assets.
// Every target must be in the authorized scope (Infinitum repos, or a domain an operator added with
// an ownership attestation). External probes are passive/low-rate GETs: no exploitation, no fuzzing,
// no credential attacks, no denial of service.
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import tls from "node:tls";
import crypto from "node:crypto";
import { load, save, audit } from "./store.js";
import { noteGeo } from "./geo.js";
import { listRepos, repoDir, owner, api, validRepo } from "./github.js";

/* ---------- scope ---------- */

const DOMAIN = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

export function getScope() {
  return load("scope", { domains: [] });
}

export function addDomain(domain, { operator, attestation }) {
  const d = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!DOMAIN.test(d)) throw new Error("not a valid domain name");
  if (attestation !== true) throw new Error("ownership/authorization attestation is required to add a target");
  const scope = getScope();
  if (!scope.domains.some((x) => x.domain === d)) {
    scope.domains.push({ domain: d, addedAt: new Date().toISOString(), operator: operator || "operator", attested: true });
    save("scope", scope);
    audit("scope.add", { domain: d, operator });
  }
  return scope;
}

export function removeDomain(domain) {
  const scope = getScope();
  scope.domains = scope.domains.filter((x) => x.domain !== domain);
  save("scope", scope);
  audit("scope.remove", { domain });
  return scope;
}

function assertDomainInScope(d) {
  if (!getScope().domains.some((x) => x.domain === d)) throw new Error(`${d} is not in the authorized scope`);
}

/* ---------- findings ---------- */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];

export function getFindings() {
  return load("findings", []);
}

/** Replace all findings from (module, target) with a fresh set, keeping triage status of ones still present. */
function commitFindings(module, target, fresh) {
  const all = getFindings();
  const prior = new Map(all.filter((f) => f.module === module && f.target === target).map((f) => [f.key, f]));
  const kept = all.filter((f) => !(f.module === module && f.target === target));
  const now = new Date().toISOString();
  for (const f of fresh) {
    const key = crypto.createHash("sha1").update(`${module}|${target}|${f.title}|${f.location || ""}`).digest("hex").slice(0, 12);
    const old = prior.get(key);
    kept.push({ id: key, key, module, target, firstSeen: old?.firstSeen || now, lastSeen: now, status: old?.status || "open", ...f });
  }
  save("findings", kept);
  return fresh.length;
}

export function triage(id, status) {
  if (!["open", "accepted", "resolved", "false-positive"].includes(status)) throw new Error("bad status");
  const all = getFindings();
  const f = all.find((x) => x.id === id);
  if (!f) throw new Error("no such finding");
  f.status = status;
  save("findings", all);
  audit("finding.triage", { id, status });
  return f;
}

/* ---------- module: secret exposure in source ---------- */

const SECRET_RULES = [
  ["critical", "AWS access key ID", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["critical", "GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ["critical", "Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["critical", "OpenAI API key", /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["critical", "Stripe live secret", /\b(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["critical", "Private key block", /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ["high", "Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["high", "Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["high", "Supabase service role JWT", /service_role[^\n]{0,40}eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["medium", "Hard-coded credential assignment", /\b(password|passwd|secret|api_?key|access_?token|auth_?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|otf|mp4|mov|mp3|wav|apk|jar|lock|map)$/i;
const PLACEHOLDER = /(example|placeholder|your[_-]|xxxx|changeme|dummy|test|<.*>|\$\{|process\.env)/i;

const mask = (s) => (s.length <= 8 ? "****" : s.slice(0, 6) + "…" + "*".repeat(6));

export async function scanSecrets(repo, { exec, log }) {
  const dir = repoDir(repo);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${repo} is not pulled; pull it first`);
  const { stdout } = await exec("git", ["-C", dir, "ls-files", "-z"], { capture: true, quiet: true });
  const files = stdout.split("\0").filter(Boolean);
  log(`scanning ${files.length} tracked files in ${repo}`);
  const out = [];
  for (const rel of files) {
    const base = path.basename(rel);
    if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) {
      out.push({ severity: "high", title: "Environment file committed to git", location: rel, detail: "Tracked .env file; rotate anything in it and remove from history." });
    }
    if (/\.(pem|p12|pfx|keystore|jks)$/i.test(base)) {
      out.push({ severity: "high", title: "Key/certificate material committed", location: rel, detail: "Tracked key store or PEM file." });
    }
    if (SKIP_EXT.test(rel)) continue;
    const abs = path.join(dir, rel);
    let text;
    try {
      const st = fs.statSync(abs);
      if (st.size > 1_000_000) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      for (const [severity, name, re] of SECRET_RULES) {
        const m = line.match(re);
        if (!m) continue;
        if (severity === "medium" && PLACEHOLDER.test(line)) continue;
        out.push({ severity, title: `${name} in source`, location: `${rel}:${i + 1}`, detail: `match ${mask(m[0])}` });
      }
    }
  }
  const n = commitFindings("secrets", repo, out);
  log(`${n} finding(s)`);
  return { findings: n };
}

/* ---------- module: dependency vulnerabilities ---------- */

export async function scanDeps(repo, { exec, log }) {
  const dir = repoDir(repo);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`${repo} is not pulled; pull it first`);
  const out = [];
  const o = await owner();
  const alerts = await api(`repos/${o}/${repo}/dependabot/alerts?state=open&per_page=100`);
  if (Array.isArray(alerts)) {
    for (const a of alerts) {
      const sev = (a.security_advisory?.severity || "medium").toLowerCase();
      out.push({
        severity: SEVERITIES.includes(sev) ? sev : "medium",
        title: `${a.dependency?.package?.name}: ${a.security_advisory?.summary || a.security_advisory?.ghsa_id}`,
        location: a.dependency?.manifest_path,
        detail: `Dependabot ${a.security_advisory?.ghsa_id}; fixed in ${a.security_vulnerability?.first_patched_version?.identifier || "n/a"}`,
        url: a.html_url,
      });
    }
    log(`dependabot: ${alerts.length} open alert(s)`);
  } else {
    log(`dependabot unavailable (${alerts?.error || "disabled"}); falling back to local audit`);
    if (fs.existsSync(path.join(dir, "package-lock.json"))) {
      const r = await exec("npm", ["audit", "--json", "--omit=dev"], { cwd: dir, capture: true, quiet: true, allowFail: true });
      try {
        const j = JSON.parse(r.stdout);
        for (const [name, v] of Object.entries(j.vulnerabilities || {})) {
          out.push({ severity: SEVERITIES.includes(v.severity) ? v.severity : "medium", title: `${name}: vulnerable dependency`, location: "package-lock.json", detail: `range ${v.range}; fix ${v.fixAvailable ? "available" : "not available"}` });
        }
      } catch {
        log("npm audit returned no JSON", "stderr");
      }
    } else if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) {
      const r = await exec("pnpm", ["audit", "--json", "--prod"], { cwd: dir, capture: true, quiet: true, allowFail: true });
      try {
        const j = JSON.parse(r.stdout);
        for (const a of Object.values(j.advisories || {})) {
          out.push({ severity: SEVERITIES.includes(a.severity) ? a.severity : "medium", title: `${a.module_name}: ${a.title}`, location: "pnpm-lock.yaml", detail: `patched ${a.patched_versions}`, url: a.url });
        }
      } catch {
        log("pnpm audit returned no JSON", "stderr");
      }
    } else log("no lockfile to audit");
  }
  const n = commitFindings("deps", repo, out);
  log(`${n} finding(s)`);
  return { findings: n };
}

/* ---------- module: repository posture ---------- */

export async function scanPosture({ log }) {
  const repos = await listRepos({ fresh: true });
  const o = await owner();
  let total = 0;
  for (const r of repos) {
    if (r.archived) continue;
    const out = [];
    if (!r.private) out.push({ severity: "medium", title: "Repository is public", detail: "Confirm this product is meant to be public." });
    const prot = await api(`repos/${o}/${r.name}/branches/${r.defaultBranch}/protection`);
    if (prot?.error) out.push({ severity: "low", title: `Default branch '${r.defaultBranch}' is unprotected`, detail: "No branch protection: force-push and direct pushes allowed." });
    const sa = await api(`repos/${o}/${r.name}/secret-scanning/alerts?state=open&per_page=100`);
    if (Array.isArray(sa)) for (const a of sa) out.push({ severity: "critical", title: `GitHub secret scanning: ${a.secret_type_display_name || a.secret_type}`, location: a.html_url, url: a.html_url });
    const cs = await api(`repos/${o}/${r.name}/code-scanning/alerts?state=open&per_page=100`);
    if (Array.isArray(cs)) for (const a of cs) out.push({ severity: (a.rule?.security_severity_level || "medium").toLowerCase(), title: `Code scanning: ${a.rule?.description}`, location: a.most_recent_instance?.location?.path, url: a.html_url });
    total += commitFindings("posture", r.name, out);
    log(`${r.name}: ${out.length} finding(s)`);
  }
  return { findings: total, repos: repos.length };
}

/* ---------- module: external surface (in-scope domains only) ---------- */

const SECURITY_HEADERS = [
  ["strict-transport-security", "medium", "HSTS missing"],
  ["content-security-policy", "medium", "Content-Security-Policy missing"],
  ["x-content-type-options", "low", "X-Content-Type-Options missing"],
  ["referrer-policy", "low", "Referrer-Policy missing"],
  ["permissions-policy", "info", "Permissions-Policy missing"],
];
// Common accidental exposures. Each check has a content test so a SPA's catch-all 200 is not a false positive.
const EXPOSURES = [
  ["/.git/HEAD", "critical", "Git metadata exposed", (b) => /^ref: refs\//.test(b)],
  ["/.git/config", "critical", "Git config exposed", (b) => /\[core\]/.test(b)],
  ["/.env", "critical", "Environment file exposed", (b) => /^[A-Z0-9_]+=/m.test(b) && !/<html/i.test(b)],
  ["/.env.production", "critical", "Production env file exposed", (b) => /^[A-Z0-9_]+=/m.test(b) && !/<html/i.test(b)],
  ["/.DS_Store", "low", ".DS_Store exposed", (b) => b.includes("Bud1")],
  ["/.vscode/sftp.json", "high", "Editor deploy credentials exposed", (b) => /"host"/.test(b)],
  ["/server-status", "medium", "Apache server-status exposed", (b) => /Apache Server Status/i.test(b)],
  ["/package.json", "low", "package.json exposed", (b) => /"dependencies"/.test(b)],
  ["/.well-known/security.txt", null, null, null],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function certInfo(host, signal) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 8000, rejectUnauthorized: false, signal }, () => {
      const c = sock.getPeerCertificate();
      resolve({ authorized: sock.authorized, error: sock.authorizationError || null, protocol: sock.getProtocol(), validTo: c?.valid_to, issuer: c?.issuer?.O || c?.issuer?.CN, subject: c?.subject?.CN });
      sock.end();
    });
    sock.on("error", (e) => resolve({ error: e.code || e.message }));
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ error: "timeout" });
    });
  });
}

async function get(url, signal) {
  const ctl = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const res = await fetch(url, { redirect: "manual", signal: ctl, headers: { "user-agent": "1MIND-RedTeam/0.1 (Infinitum internal; authorized self-assessment)" } });
  const body = (await res.text()).slice(0, 4000);
  return { status: res.status, headers: res.headers, body };
}

export async function scanSurface(domain, { log, signal }) {
  assertDomainInScope(domain);
  const out = [];
  try {
    const a = await dns.resolve4(domain).catch(() => []);
    const aaaa = await dns.resolve6(domain).catch(() => []);
    const cname = await dns.resolveCname(domain).catch(() => []);
    log(`dns A=${a.join(",") || "-"} AAAA=${aaaa.length} CNAME=${cname.join(",") || "-"}`);
    noteGeo(log, { domain, ips: [...a, ...aaaa] });
    if (!a.length && !aaaa.length && !cname.length) out.push({ severity: "info", title: "Domain does not resolve" });
    const txt = await dns.resolveTxt(domain).catch(() => []);
    const flat = txt.map((t) => t.join(""));
    if (!flat.some((t) => t.startsWith("v=spf1"))) out.push({ severity: "low", title: "No SPF record", detail: "Domain can be spoofed in email." });
    const dmarc = await dns.resolveTxt(`_dmarc.${domain}`).catch(() => []);
    if (!dmarc.length) out.push({ severity: "low", title: "No DMARC record", detail: "Add _dmarc TXT with p=quarantine or p=reject." });
    const caa = await dns.resolveCaa(domain).catch(() => []);
    if (!caa.length) out.push({ severity: "info", title: "No CAA record", detail: "Any CA can issue certificates for this domain." });
  } catch (e) {
    log(`dns error ${e.message}`, "stderr");
  }

  const cert = await certInfo(domain, signal);
  log(`tls ${JSON.stringify(cert)}`);
  if (cert.error && !cert.validTo) out.push({ severity: "high", title: "TLS handshake failed", detail: cert.error });
  else {
    if (!cert.authorized) out.push({ severity: "high", title: "TLS certificate not trusted", detail: String(cert.error) });
    const days = Math.floor((new Date(cert.validTo) - Date.now()) / 86400000);
    if (days < 0) out.push({ severity: "critical", title: "TLS certificate expired", detail: cert.validTo });
    else if (days < 14) out.push({ severity: "high", title: `TLS certificate expires in ${days} days`, detail: cert.validTo });
    if (/TLSv1(\.1)?$/.test(cert.protocol || "")) out.push({ severity: "medium", title: `Legacy TLS negotiated (${cert.protocol})` });
  }

  try {
    const plain = await get(`http://${domain}/`, signal);
    const loc = plain.headers.get("location") || "";
    if (!(plain.status >= 300 && plain.status < 400 && loc.startsWith("https://"))) out.push({ severity: "medium", title: "HTTP does not redirect to HTTPS", detail: `status ${plain.status}` });
  } catch (e) {
    log(`http check: ${e.message}`, "stderr");
  }

  try {
    const home = await get(`https://${domain}/`, signal);
    log(`GET / -> ${home.status}`);
    for (const [h, sev, title] of SECURITY_HEADERS) {
      if (h === "content-security-policy" && home.headers.get("content-security-policy-report-only")) continue;
      if (!home.headers.get(h)) out.push({ severity: sev, title, location: "/" });
    }
    if (!home.headers.get("x-frame-options") && !/frame-ancestors/.test(home.headers.get("content-security-policy") || "")) out.push({ severity: "low", title: "Clickjacking protection missing", detail: "No X-Frame-Options or CSP frame-ancestors.", location: "/" });
    for (const h of ["x-powered-by", "server"]) {
      const v = home.headers.get(h);
      if (v && /\d/.test(v)) out.push({ severity: "info", title: `Version disclosure in ${h}`, detail: v });
    }
    const cookies = home.headers.getSetCookie?.() || [];
    for (const c of cookies) {
      const name = c.split("=")[0];
      if (!/;\s*secure/i.test(c)) out.push({ severity: "low", title: `Cookie '${name}' lacks Secure`, location: "/" });
      if (!/;\s*httponly/i.test(c)) out.push({ severity: "info", title: `Cookie '${name}' lacks HttpOnly`, location: "/" });
    }
  } catch (e) {
    out.push({ severity: "high", title: "HTTPS request failed", detail: e.message });
  }

  for (const [p, sev, title, test] of EXPOSURES) {
    if (signal.aborted) throw new Error("cancelled");
    await sleep(300);
    try {
      const r = await get(`https://${domain}${p}`, signal);
      log(`GET ${p} -> ${r.status}`);
      if (p === "/.well-known/security.txt") {
        if (r.status !== 200 || !/contact:/i.test(r.body)) out.push({ severity: "info", title: "No security.txt", detail: "Publish a vulnerability disclosure contact." });
        continue;
      }
      if (r.status === 200 && test(r.body)) out.push({ severity: sev, title, location: p });
    } catch (e) {
      log(`GET ${p}: ${e.message}`, "stderr");
    }
  }

  const n = commitFindings("surface", domain, out);
  log(`${n} finding(s)`);
  return { findings: n };
}

export { validRepo };
