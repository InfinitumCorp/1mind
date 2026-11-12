// 1MIND console. Vanilla JS, no build step, no third-party code.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const main = $("#main");
const drawer = $("#drawer");

const state = { ov: null, view: "overview", filter: { div: "all", q: "" }, rtFilter: "open", sevFilter: "all", jobSel: null, timers: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json", "x-1mind": "1" } : { "x-1mind": "1" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthenticated");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

const ago = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const chip = (t, cls = "") => `<span class="chip ${cls}">${esc(t)}</span>`;
const sevChip = (s) => chip(s, `sev ${s}`);
const stChip = (s) => (s ? chip(s, `st-${s}`) : chip("—"));
const divName = (id) => state.ov?.divisions.find((d) => d.id === id)?.name || id;

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
  }
}

async function startJob(path, body, label) {
  const j = await act(() => api(path, { method: "POST", body: body || {} }), `${label} started`);
  return j;
}

/* ---------- chrome ---------- */

function chrome() {
  const ov = state.ov;
  if (!ov) return;
  $("#owner").innerHTML = `<span class="dot ${ov.ghError ? "crit" : "on"}"></span>GH/${esc(ov.owner || "offline")}`;
  $("#conjure-pill").innerHTML = `<span class="dot ${ov.conjure.live ? "on" : "warn"}"></span>CONJURE ${ov.conjure.live ? "LIVE" : "MOCK"}`;
  const running = ov.jobs.filter((j) => j.status === "running").length;
  $("#jobs-pill").innerHTML = `<span class="dot ${running ? "on" : ""}"></span>${running} JOB${running === 1 ? "" : "S"} RUNNING`;
  $$("#rail a").forEach((a) => a.classList.toggle("active", a.dataset.v === state.view));
}
setInterval(() => {
  $("#clock").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
}, 1000);

$("#theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("1mind-theme", next);
  } catch {}
  if (state.view === "overview") render();
};

document.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const map = { 1: "overview", 2: "products", 3: "pipeline", 4: "redteam", 5: "conjure", 6: "openclaw", 7: "jobs", 8: "audit" };
  if (map[e.key]) location.hash = map[e.key];
  if (e.key === "Escape") closeDrawer();
});

/* ---------- overview ---------- */

function viewOverview() {
  const ov = state.ov;
  const repos = ov.repos;
  const pulled = repos.filter((r) => r.local.pulled).length;
  const bOk = repos.filter((r) => r.build?.status === "ok").length;
  const bFail = repos.filter((r) => r.build?.status === "failed").length;
  const sev = ov.findings.bySeverity;
  const running = ov.jobs.filter((j) => j.status === "running").length;
  const products = new Set(repos.map((r) => r.product)).size;
  const maxSev = Math.max(1, ...Object.values(sev));
  const pushes = [...repos].sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt))).slice(0, 14);

  main.innerHTML = `
  <h1 class="view">Command Overview</h1>
  <div class="view-sub up">${repos.length} repositories · ${ov.divisions.length - 1} divisions · ${esc(ov.owner || "")} · synced ${ago(ov.now)} ago</div>
  ${ov.ghError ? `<div class="banner"><b>GITHUB</b><span>${esc(ov.ghError)} — run <span class="mono">gh auth login</span> on this machine.</span></div>` : ""}
  <div class="grid g-kpi">
    ${kpi("Products", products, `${repos.length} repos`)}
    ${kpi("Pulled", `${pulled}/${repos.length}`, "local workspace")}
    ${kpi("Builds", `${bOk}`, `${bFail} failed`, bFail > 0)}
    ${kpi("Open findings", ov.findings.open, `${ov.findings.total} total`)}
    ${kpi("Critical", sev.critical, `${sev.high} high`, sev.critical > 0)}
    ${kpi("Jobs", running, "running now")}
  </div>
  <div class="grid g-main" style="margin-top:12px">
    <div class="panel">
      <header>Ontology · Infinitum product graph<span class="r"><button class="btn ghost sm" id="sync">Sync GitHub</button></span></header>
      <div class="body flush graph-wrap"><canvas id="graph"></canvas>
        <div class="graph-legend"><span>● product</span><span>◯ not pulled</span><span style="color:var(--crit)">● critical/failed</span><span>drag · click to open</span></div>
      </div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="panel"><header>Threat posture<span class="r"><a class="btn ghost sm" href="#redteam">Red team</a></span></header>
        <div class="body">${["critical", "high", "medium", "low", "info"].map((s) => `<div class="bar"><span class="up">${s}</span><span class="track"><span class="fill ${s}" style="width:${(sev[s] / maxSev) * 100}%"></span></span><span>${sev[s]}</span></div>`).join("")}
        <div class="mono dim" style="font-size:10px;margin-top:8px">${ov.scope.domains.length} external target(s) in authorized scope</div></div>
      </div>
      <div class="panel"><header>Recent pushes</header>
        <ul class="feed">${pushes.map((r) => `<li class="click" data-repo="${esc(r.name)}"><span class="t">${ago(r.pushedAt)}</span><span><b>${esc(r.product)}</b> <span class="faint mono">${esc(r.name)}</span></span></li>`).join("")}</ul>
      </div>
    </div>
  </div>
  <div class="grid g-2" style="margin-top:12px">
    <div class="panel"><header>Division matrix</header><div class="body flush">
      <table><thead><tr><th>Division</th><th class="num">Repos</th><th class="num">Pulled</th><th class="num">Built</th><th class="num">Findings</th></tr></thead><tbody>
      ${ov.divisions.map((d) => {
        const rs = repos.filter((r) => r.division === d.id);
        if (!rs.length) return "";
        return `<tr class="click" data-div="${d.id}"><td>${esc(d.name)}</td><td class="num">${rs.length}</td><td class="num">${rs.filter((r) => r.local.pulled).length}</td><td class="num">${rs.filter((r) => r.build?.status === "ok").length}</td><td class="num">${rs.reduce((a, r) => a + r.openFindings, 0)}</td></tr>`;
      }).join("")}
      </tbody></table></div></div>
    <div class="panel"><header>Audit stream<span class="r"><a class="btn ghost sm" href="#audit">All</a></span></header>
      <ul class="feed">${ov.audit.slice(0, 16).map((a) => `<li><span class="t">${ago(a.ts)}</span><span class="mono" style="font-size:11px">${esc(a.action)} <span class="dim">${esc(a.title || a.target || a.domain || a.kind || a.status || "")}</span></span></li>`).join("") || `<li><span></span><span class="faint">no activity yet</span></li>`}</ul>
    </div>
  </div>`;
  $("#sync").onclick = () => act(() => api("/api/sync", { method: "POST" }), "GitHub synced");
  $$("[data-repo]").forEach((el) => (el.onclick = () => openRepo(el.dataset.repo)));
  $$("[data-div]").forEach((el) => (el.onclick = () => {
    state.filter.div = el.dataset.div;
    location.hash = "products";
  }));
  drawGraph($("#graph"), ov);
}

function kpi(l, v, s, alert = false) {
  return `<div class="panel kpi ${alert ? "alert" : ""}"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;
}

/* ---------- force graph ---------- */

let graphAnim = null;
function drawGraph(canvas, ov) {
  cancelAnimationFrame(graphAnim);
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const C = { fg: css.getPropertyValue("--fg").trim(), dim: css.getPropertyValue("--dim").trim(), faint: css.getPropertyValue("--faint").trim(), line: css.getPropertyValue("--line2").trim(), bg: css.getPropertyValue("--panel").trim(), crit: css.getPropertyValue("--crit").trim(), high: css.getPropertyValue("--high").trim() };
  const dpr = window.devicePixelRatio || 1;
  let W, H;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    W = r.width;
    H = r.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const nodes = [{ id: "core", label: "1MIND", type: "core", x: W / 2, y: H / 2, fixed: true }];
  const links = [];
  const divs = ov.divisions.filter((d) => ov.repos.some((r) => r.division === d.id));
  divs.forEach((d, i) => {
    const a = (i / divs.length) * Math.PI * 2;
    nodes.push({ id: "d:" + d.id, label: d.name.toUpperCase(), type: "div", x: W / 2 + Math.cos(a) * 140, y: H / 2 + Math.sin(a) * 140 });
    links.push(["core", "d:" + d.id, 130]);
  });
  ov.repos.forEach((r, i) => {
    const parent = nodes.find((n) => n.id === "d:" + r.division);
    nodes.push({ id: "r:" + r.name, repo: r, label: r.product, type: "repo", x: parent.x + Math.cos(i) * 40, y: parent.y + Math.sin(i) * 40 });
    links.push(["d:" + r.division, "r:" + r.name, 78]);
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  nodes.forEach((n) => ((n.vx = 0), (n.vy = 0)));

  let hover = null;
  let drag = null;
  let alpha = 1;
  const tip = $("#tip");

  function tick() {
    if (alpha > 0.005) {
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 90000) continue;
        const f = (1700 / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
      for (const [s, t, len] of links) {
        const a = byId[s], b = byId[t];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - len) / d) * 0.08 * alpha;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      for (const n of nodes) {
        if (n.fixed || n === drag) continue;
        n.vx += (W / 2 - n.x) * 0.002 * alpha;
        n.vy += (H / 2 - n.y) * 0.002 * alpha;
        n.x += n.vx *= 0.6;
        n.y += n.vy *= 0.6;
        n.x = Math.max(20, Math.min(W - 20, n.x));
        n.y = Math.max(20, Math.min(H - 20, n.y));
      }
      alpha *= 0.985;
    }
    paint();
    graphAnim = requestAnimationFrame(tick);
  }

  function paint() {
    ctx.clearRect(0, 0, W, H);
    // grid
    ctx.strokeStyle = C.line;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
    ctx.globalAlpha = 1;
    for (const [s, t] of links) {
      const a = byId[s], b = byId[t];
      const hot = hover && (hover === a || hover === b);
      ctx.strokeStyle = hot ? C.fg : C.line;
      ctx.globalAlpha = hot ? 0.9 : 0.6;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const n of nodes) {
      ctx.lineWidth = 1.2;
      if (n.type === "core") {
        ctx.fillStyle = C.fg;
        ctx.fillRect(n.x - 15, n.y - 15, 30, 30);
        ctx.fillStyle = C.bg;
        ctx.font = "800 15px ui-monospace, Consolas, monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("1", n.x, n.y + 1);
        continue;
      }
      if (n.type === "div") {
        ctx.strokeStyle = C.fg; ctx.fillStyle = C.bg;
        ctx.beginPath(); ctx.moveTo(n.x, n.y - 8); ctx.lineTo(n.x + 8, n.y); ctx.lineTo(n.x, n.y + 8); ctx.lineTo(n.x - 8, n.y); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = C.dim; ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(n.label, n.x, n.y + 11);
        continue;
      }
      const r = n.repo;
      const bad = r.build?.status === "failed" || r.openFindings > 0 && hasCrit(r.name);
      const color = bad ? C.crit : r.openFindings ? C.high : C.fg;
      const rad = 4 + Math.min(6, Math.log2(1 + (r.sizeKb || 1) / 2000));
      ctx.beginPath(); ctx.arc(n.x, n.y, rad, 0, Math.PI * 2);
      if (r.local.pulled) { ctx.fillStyle = color; ctx.fill(); } else { ctx.fillStyle = C.bg; ctx.fill(); ctx.strokeStyle = color; ctx.stroke(); }
      if (r.build?.status === "ok") { ctx.strokeStyle = C.fg; ctx.beginPath(); ctx.arc(n.x, n.y, rad + 3, 0, Math.PI * 2); ctx.stroke(); }
      if (hover === n || W > 700) {
        ctx.fillStyle = hover === n ? C.fg : C.faint;
        ctx.font = (hover === n ? "600 " : "") + "10px ui-monospace, Consolas, monospace";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label, n.x + rad + 5, n.y);
      }
    }
  }

  const pick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 196;
    for (const n of nodes) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; best = n; } }
    return { n: best, x, y };
  };
  canvas.onmousemove = (e) => {
    const { n, x, y } = pick(e);
    if (drag) { drag.x = x; drag.y = y; alpha = Math.max(alpha, 0.3); return; }
    hover = n;
    if (n?.repo) {
      const r = n.repo;
      tip.style.display = "block";
      tip.style.left = e.clientX + 14 + "px";
      tip.style.top = e.clientY + 10 + "px";
      tip.innerHTML = `<b>${esc(r.product)}</b><br>${esc(r.name)} · ${esc(r.language || "—")}<br>${r.local.pulled ? "PULLED" : "NOT PULLED"} · BUILD ${esc(r.build?.status || "—").toUpperCase()}<br>${r.openFindings} OPEN FINDINGS · PUSH ${ago(r.pushedAt)}`;
    } else tip.style.display = "none";
  };
  canvas.onmouseleave = () => { hover = null; tip.style.display = "none"; };
  canvas.onmousedown = (e) => { const { n } = pick(e); if (n && !n.fixed) { drag = n; drag.moved = false; } };
  window.onmouseup = (e) => {
    if (drag) {
      const n = drag;
      drag = null;
      const { n: under } = pick(e);
      if (under === n && n.repo) openRepo(n.repo.name);
    }
  };
  window.onresize = () => { resize(); nodes[0].x = W / 2; nodes[0].y = H / 2; alpha = 0.5; };
  tick();
}
function hasCrit(repo) {
  return (state.findings || []).some((f) => f.target === repo && f.status === "open" && (f.severity === "critical" || f.severity === "high"));
}

/* ---------- products ---------- */

function viewProducts() {
  const ov = state.ov;
  const f = state.filter;
  const q = f.q.toLowerCase();
  const rows = ov.repos.filter((r) => (f.div === "all" || r.division === f.div) && (!q || `${r.name} ${r.product} ${r.description} ${r.language}`.toLowerCase().includes(q)));
  main.innerHTML = `
  <h1 class="view">Products</h1>
  <div class="view-sub up">Every Infinitum product, its repository, and its live state</div>
  <div class="panel">
    <header>Registry · ${rows.length} of ${ov.repos.length}<span class="r">
      <input class="f" id="q" placeholder="SEARCH" value="${esc(f.q)}" style="width:180px">
      <select class="f" id="div"><option value="all">ALL DIVISIONS</option>${ov.divisions.map((d) => `<option value="${d.id}" ${f.div === d.id ? "selected" : ""}>${esc(d.name.toUpperCase())}</option>`).join("")}</select>
    </span></header>
    <div class="body flush scroll" style="max-height:72vh">
    <table><thead><tr><th>Product</th><th>Repository</th><th>Division</th><th>Lang</th><th>Vis</th><th>Push</th><th>Local</th><th>Build</th><th class="num">Find.</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-repo="${esc(r.name)}">
      <td><b>${esc(r.product)}</b>${r.builtin ? " " + chip("built-in", "solid") : ""}<div class="faint" style="font-size:11px;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.description)}</div></td>
      <td class="mono">${esc(r.name)}</td><td class="mono dim">${esc(divName(r.division))}</td><td class="mono dim">${esc(r.language || "—")}</td>
      <td>${chip(r.private ? "private" : "public", r.private ? "" : "sev medium")}</td>
      <td class="mono dim">${ago(r.pushedAt)}</td>
      <td>${r.local.pulled ? chip(r.local.branch || "pulled", "st-ok") : chip("remote")}</td>
      <td>${stChip(r.build?.status)}</td>
      <td class="num">${r.openFindings || ""}</td>
      <td class="row" style="flex-wrap:nowrap"><button class="btn ghost sm" data-pull="${esc(r.name)}">Pull</button><button class="btn ghost sm" data-build="${esc(r.name)}" ${r.local.pulled ? "" : "disabled"}>Build</button></td>
    </tr>`).join("") || `<tr><td colspan="10"><div class="empty">NO MATCHES</div></td></tr>`}
    </tbody></table></div>
  </div>`;
  $("#q").oninput = (e) => {
    f.q = e.target.value;
    const pos = e.target.selectionStart;
    viewProducts();
    $("#q").focus();
    $("#q").setSelectionRange(pos, pos);
  };
  $("#div").onchange = (e) => { f.div = e.target.value; viewProducts(); };
  wireRepoButtons();
  $$("tr[data-repo]").forEach((el) => (el.onclick = (e) => { if (!e.target.closest("button")) openRepo(el.dataset.repo); }));
}

function wireRepoButtons(root = document) {
  $$("[data-pull]", root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); startJob(`/api/repos/${b.dataset.pull}/pull`, null, `Pull ${b.dataset.pull}`); }));
  $$("[data-build]", root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); startJob(`/api/repos/${b.dataset.build}/build`, null, `Build ${b.dataset.build}`); }));
}

async function openRepo(name) {
  const r = state.ov.repos.find((x) => x.name === name);
  drawer.classList.add("open");
  drawer.innerHTML = `<div class="dh"><div><div class="mono dim up" style="font-size:10px">${esc(divName(r?.division))}</div><h2>${esc(r?.product || name)}</h2><div class="mono faint">${esc(name)}</div></div><span style="flex:1"></span><button class="iconbtn" id="dclose">ESC ✕</button></div><div class="empty">LOADING LIVE PICTURE…</div>`;
  $("#dclose").onclick = closeDrawer;
  let d;
  try {
    d = await api(`/api/repos/${encodeURIComponent(name)}`);
  } catch (e) {
    drawer.querySelector(".empty").textContent = e.message;
    return;
  }
  const fs = (state.findings || []).filter((f) => f.target === name && f.status === "open");
  const alertCell = (v) => (v === null ? `<span class="faint">n/a</span>` : v ? `<b style="color:var(--crit)">${v}</b>` : "0");
  drawer.innerHTML = `<div class="dh"><div><div class="mono dim up" style="font-size:10px">${esc(divName(r?.division))}</div><h2>${esc(r?.product || name)}</h2><div class="mono faint">${esc(name)}</div></div><span style="flex:1"></span><button class="iconbtn" id="dclose">ESC ✕</button></div>
  <section class="row"><button class="btn sm" data-pull="${esc(name)}">Pull</button><button class="btn ghost sm" data-build="${esc(name)}" ${r?.local.pulled ? "" : "disabled"}>Build</button>
    <button class="btn ghost sm" id="d-sec" ${r?.local.pulled ? "" : "disabled"}>Secret sweep</button><button class="btn ghost sm" id="d-dep" ${r?.local.pulled ? "" : "disabled"}>Dependency audit</button>
    <a class="btn ghost sm" href="${esc(r?.url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;text-decoration:none">GitHub ↗</a></section>
  <section><h3>Identity</h3><dl class="kv">
    <dt>Description</dt><dd>${esc(r?.description || "—")}</dd>
    <dt>Language</dt><dd class="mono">${esc(r?.language || "—")}</dd>
    <dt>Visibility</dt><dd>${esc(r?.visibility)}</dd>
    <dt>Branch</dt><dd class="mono">${esc(r?.defaultBranch)} ${d.protected ? chip("protected", "st-ok") : chip("unprotected", "sev low")}</dd>
    <dt>Workspace</dt><dd class="mono" style="font-size:11px">${r?.local.pulled ? esc(r.local.path) : "not pulled"}</dd>
    <dt>Last build</dt><dd>${stChip(r?.build?.status)} <span class="mono faint">${r?.build ? `${ago(r.build.at)} ago · ${esc(r.build.toolchain)} ${r.build.head ? "@" + esc(r.build.head) : ""}` : ""}</span>${r?.build?.error ? `<div class="mono" style="color:var(--crit);font-size:11px;margin-top:4px">${esc(r.build.error)}</div>` : ""}${r?.build?.note ? `<div class="mono faint" style="font-size:11px;margin-top:4px">${esc(r.build.note)}</div>` : ""}${(r?.build?.components || []).map((c) => `<div class="mono" style="font-size:11px;margin-top:4px">${stChip(c.status)} ${esc(c.path)} · ${esc(c.toolchain)}${(c.packages || []).filter((p) => p.status !== "ok").map((p) => ` · ${esc(p.path)} ${esc(p.status)}`).join("")}</div>`).join("")}${(r?.build?.warnings || []).map((w) => `<div class="mono" style="color:var(--med);font-size:11px;margin-top:4px">⚠ ${esc(w)}</div>`).join("")}</dd>
  </dl></section>
  <section><h3>Security alerts (GitHub)</h3><dl class="kv"><dt>Dependabot</dt><dd>${alertCell(d.alerts.dependabot)}</dd><dt>Secret scanning</dt><dd>${alertCell(d.alerts.secretScanning)}</dd><dt>Code scanning</dt><dd>${alertCell(d.alerts.codeScanning)}</dd><dt>1MIND findings</dt><dd>${fs.length ? fs.map((f) => sevChip(f.severity)).join(" ") : "0"}</dd></dl></section>
  <section><h3>CI runs</h3>${d.runs.length ? `<table><tbody>${d.runs.map((x) => `<tr><td>${stChip(x.conclusion || x.status)}</td><td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td class="mono dim">${esc(x.branch)}</td><td class="mono faint">${ago(x.date)}</td></tr>`).join("")}</tbody></table>` : `<div class="faint mono">no workflow runs</div>`}</section>
  <section><h3>Open pull requests</h3>${d.pulls.length ? `<table><tbody>${d.pulls.map((p) => `<tr><td class="mono">#${p.number}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.draft ? " " + chip("draft") : ""}</td><td class="mono faint">${ago(p.updated)}</td></tr>`).join("")}</tbody></table>` : `<div class="faint mono">none</div>`}</section>
  <section><h3>Commits</h3><table><tbody>${d.commits.map((c) => `<tr><td class="mono"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.sha)}</a></td><td>${esc(c.msg)}</td><td class="mono faint">${ago(c.date)}</td></tr>`).join("")}</tbody></table></section>`;
  $("#dclose").onclick = closeDrawer;
  wireRepoButtons(drawer);
  $("#d-sec").onclick = () => startJob("/api/redteam/scan", { module: "secrets", target: name }, "Secret sweep");
  $("#d-dep").onclick = () => startJob("/api/redteam/scan", { module: "deps", target: name }, "Dependency audit");
}
function closeDrawer() {
  drawer.classList.remove("open");
}

/* ---------- pipeline ---------- */

function viewPipeline() {
  const ov = state.ov;
  const running = new Set(ov.jobs.filter((j) => j.status === "running" && j.target).map((j) => j.target));
  const fleet = ov.jobs.filter((j) => j.kind.startsWith("fleet")).slice(0, 6);
  main.innerHTML = `
  <h1 class="view">Pipeline</h1>
  <div class="view-sub up">Pull every product from GitHub and build it in the 1MIND workspace</div>
  <div class="panel"><header>Fleet operations</header><div class="body row">
    <button class="btn" data-fleet="pull-build">Pull + build all</button>
    <button class="btn ghost" data-fleet="pull">Pull all</button>
    <button class="btn ghost" data-fleet="build">Build all pulled</button>
    <span class="mono faint" style="font-size:11px;margin-left:8px">Repos clone into workspace/repos. Builds run each product's own toolchain (pnpm / npm / yarn / python / gradle).</span>
  </div></div>
  <div class="panel" style="margin-top:12px"><header>Build matrix · ${ov.repos.length} products<span class="r">${["ok", "partial", "failed", "skipped"].map((s) => chip(`${s} ${ov.repos.filter((r) => r.build?.status === s).length}`, `st-${s}`)).join("")}</span></header>
    <div class="body"><div class="tiles">
    ${ov.repos.map((r) => {
      const st = running.has(r.name) ? "running" : r.build?.status || (r.local.pulled ? "pulled" : "remote");
      return `<div class="tile ${st}" data-repo="${esc(r.name)}"><span class="stripe"></span><div class="n">${esc(r.product)}</div><div class="m">${esc(r.name)}</div><div class="m">${st.toUpperCase()}${r.build ? " · " + ago(r.build.at) : ""}${r.build?.toolchain ? " · " + esc(r.build.toolchain) : ""}</div></div>`;
    }).join("")}
    </div></div></div>
  <div class="panel" style="margin-top:12px"><header>Recent fleet runs</header><div class="body flush">${jobTable(fleet)}</div></div>`;
  $$("[data-fleet]").forEach((b) => (b.onclick = () => startJob(`/api/fleet/${b.dataset.fleet}`, null, "Fleet " + b.dataset.fleet)));
  $$(".tile[data-repo]").forEach((el) => (el.onclick = () => openRepo(el.dataset.repo)));
  wireJobRows();
}

function jobTable(jobs) {
  if (!jobs.length) return `<div class="empty">NO RUNS</div>`;
  return `<table><thead><tr><th>Status</th><th>Job</th><th>Kind</th><th>Started</th><th>Duration</th></tr></thead><tbody>${jobs.map((j) => `<tr class="click" data-job="${j.id}"><td>${stChip(j.status)}</td><td>${esc(j.title)}</td><td class="mono dim">${esc(j.kind)}</td><td class="mono faint">${ago(j.startedAt)} ago</td><td class="mono faint">${dur(j)}</td></tr>`).join("")}</tbody></table>`;
}
const dur = (j) => {
  const s = Math.round(((j.endedAt ? new Date(j.endedAt) : Date.now()) - new Date(j.startedAt)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
function wireJobRows() {
  $$("[data-job]").forEach((el) => (el.onclick = () => { state.jobSel = el.dataset.job; location.hash = "jobs"; }));
}

/* ---------- red team ---------- */

async function viewRedteam() {
  const { findings, scope } = await api("/api/redteam");
  state.findings = findings;
  const ov = state.ov;
  const pulled = ov.repos.filter((r) => r.local.pulled);
  const list = findings
    .filter((f) => (state.rtFilter === "all" || f.status === state.rtFilter) && (state.sevFilter === "all" || f.severity === state.sevFilter))
    .sort((a, b) => ["critical", "high", "medium", "low", "info"].indexOf(a.severity) - ["critical", "high", "medium", "low", "info"].indexOf(b.severity));
  const repoOpts = `<option value="*">ALL PULLED REPOS (${pulled.length})</option>` + pulled.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join("");
  const domOpts = `<option value="*">ALL IN-SCOPE DOMAINS (${scope.domains.length})</option>` + scope.domains.map((d) => `<option value="${esc(d.domain)}">${esc(d.domain)}</option>`).join("");
  main.innerHTML = `
  <h1 class="view">Red Team</h1>
  <div class="view-sub up">Adversarial self-assessment of Infinitum assets · authorized scope only</div>
  <div class="banner"><b>RULES OF ENGAGEMENT</b><span>Targets are limited to Infinitum repositories and domains an operator has attested Infinitum owns or is authorized to test. External checks are low-rate, read-only GETs and DNS/TLS lookups: no exploitation, brute force, or load. Every run is written to the audit log.</span></div>
  <div class="grid g-4">
    ${mod("secrets", "Secret sweep", "Leaked keys, tokens, private keys and committed .env files in tracked source.", repoOpts, !pulled.length)}
    ${mod("deps", "Dependency audit", "Dependabot alerts, falling back to npm/pnpm audit on the lockfile.", repoOpts, !pulled.length)}
    ${mod("posture", "GitHub posture", "Public repos, unprotected default branches, GitHub secret and code scanning alerts.", null, false)}
    ${mod("surface", "External surface", "DNS (SPF/DMARC/CAA), TLS, HTTPS redirect, security headers, cookie flags, exposed .git/.env.", domOpts, !scope.domains.length)}
  </div>
  <div class="grid g-main" style="margin-top:12px">
    <div class="panel"><header>Findings · ${list.length}<span class="r">
      <select class="f" id="rt-st">${["open", "accepted", "resolved", "false-positive", "all"].map((s) => `<option ${state.rtFilter === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <select class="f" id="rt-sev">${["all", "critical", "high", "medium", "low", "info"].map((s) => `<option ${state.sevFilter === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    </span></header>
    <div class="body flush scroll"><table><thead><tr><th>Sev</th><th>Finding</th><th>Target</th><th>Module</th><th>Seen</th><th>Triage</th></tr></thead><tbody>
    ${list.map((f) => `<tr><td>${sevChip(f.severity)}</td><td>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a>` : esc(f.title)}<div class="mono faint" style="font-size:10.5px">${esc(f.location || "")}${f.detail ? " · " + esc(f.detail) : ""}</div></td><td class="mono">${esc(f.target)}</td><td class="mono dim">${esc(f.module)}</td><td class="mono faint">${ago(f.lastSeen)}</td>
      <td><select class="f" data-triage="${f.id}" style="height:22px;font-size:10px">${["open", "accepted", "resolved", "false-positive"].map((s) => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("") || `<tr><td colspan="6"><div class="empty">NO FINDINGS IN THIS FILTER</div></td></tr>`}
    </tbody></table></div></div>
    <div class="panel" style="align-self:start"><header>Authorized external scope</header><div class="body">
      ${scope.domains.map((d) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0"><span class="mono">${esc(d.domain)}</span><span class="row"><span class="mono faint" style="font-size:10px">${esc(d.operator)} · ${ago(d.addedAt)}</span><button class="btn ghost sm" data-rmdom="${esc(d.domain)}">✕</button></span></div>`).join("") || `<div class="mono faint" style="font-size:11px">No external targets yet.</div>`}
      <form id="addscope" style="display:grid;gap:8px;margin-top:12px">
        <input class="f" name="domain" placeholder="DOMAIN, e.g. firmnetwork.app" required>
        <input class="f" name="operator" placeholder="OPERATOR NAME" required>
        <label class="chk"><input type="checkbox" name="att" required> I confirm Infinitum Corporation owns this domain or holds written authorization to test it.</label>
        <button class="btn">Add to scope</button>
      </form>
    </div></div>
  </div>`;
  $$("[data-run]").forEach((b) => (b.onclick = () => {
    const m = b.dataset.run;
    const sel = $(`[data-target="${m}"]`);
    startJob("/api/redteam/scan", { module: m, target: sel ? sel.value : "*" }, `Red team ${m}`);
  }));
  $("#rt-st").onchange = (e) => { state.rtFilter = e.target.value; viewRedteam(); };
  $("#rt-sev").onchange = (e) => { state.sevFilter = e.target.value; viewRedteam(); };
  $$("[data-triage]").forEach((s) => (s.onchange = () => act(() => api(`/api/redteam/findings/${s.dataset.triage}`, { method: "POST", body: { status: s.value } }), "Triage saved").then(() => state.view === "redteam" && viewRedteam())));
  $$("[data-rmdom]").forEach((b) => (b.onclick = () => confirm(`Remove ${b.dataset.rmdom} from scope?`) && act(() => api(`/api/redteam/scope/${encodeURIComponent(b.dataset.rmdom)}`, { method: "DELETE" }), "Removed").then(viewRedteam)));
  $("#addscope").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    act(() => api("/api/redteam/scope", { method: "POST", body: { domain: fd.get("domain"), operator: fd.get("operator"), attestation: fd.get("att") === "on" } }), "Added to authorized scope").then(viewRedteam);
  };
}
function mod(id, title, desc, opts, disabled) {
  return `<div class="panel"><header>${esc(title)}</header><div class="body" style="display:grid;gap:10px">
    <div class="dim" style="font-size:12px;min-height:52px">${esc(desc)}</div>
    ${opts ? `<select class="f" data-target="${id}" ${disabled ? "disabled" : ""}>${opts}</select>` : `<div class="mono faint" style="font-size:11px;height:28px;line-height:28px">ALL ${state.ov.repos.length} REPOSITORIES</div>`}
    <button class="btn" data-run="${id}" ${disabled ? "disabled" : ""}>Run</button>
  </div></div>`;
}

/* ---------- conjure ---------- */

async function viewConjure() {
  const c = await api("/api/conjure");
  const running = state.ov.jobs.find((j) => j.kind.startsWith("conjure") && j.status === "running");
  const previewBase = c.previewBase || `http://127.0.0.1:${c.previewPort}`;
  main.innerHTML = `
  <h1 class="view">Conjure</h1>
  <div class="view-sub up">Intent in, verified deliverable out · built into 1MIND · ${c.live ? "live Claude" : "offline mock provider (set ANTHROPIC_API_KEY in .env)"}</div>
  <div class="panel"><header>New intent</header><div class="body" style="display:grid;gap:10px">
    <textarea class="f" id="intent" rows="3" maxlength="4000" placeholder="e.g. an internal incident tracker for the FIRM wallet team"></textarea>
    <div class="row"><button class="btn" id="go" ${running ? "disabled" : ""}>Conjure</button>
    <label class="chk" style="align-items:center"><input type="checkbox" id="mock" ${c.live ? "" : "checked disabled"}> Offline mock</label>
    ${running ? `<a class="btn ghost sm" href="#jobs" id="watch" style="display:inline-flex;align-items:center;text-decoration:none">Watching: ${esc(running.title)}</a>` : ""}
    <span class="mono faint" style="font-size:11px">PLAN → FORGE → VERIFY → REPAIR → DELIVER</span></div>
  </div></div>
  <div class="panel" style="margin-top:12px"><header>Deliverables · ${c.deliverables.length}</header><div class="body flush scroll">
  <table><thead><tr><th>Name</th><th>Intent</th><th>Verified</th><th>Files</th><th>Cost</th><th>Updated</th><th></th></tr></thead><tbody>
  ${c.deliverables.map((d) => `<tr><td><b>${esc(d.name || d.dir)}</b><div class="mono faint" style="font-size:10.5px">${esc(d.dir)}</div></td><td style="max-width:320px">${esc(d.intent)}${d.changes.length ? `<div class="mono faint" style="font-size:10.5px">+${d.changes.length} refinement(s)</div>` : ""}</td>
    <td>${d.ok ? chip("verified", "st-ok") : chip("unverified", "st-failed")}</td><td class="num">${Array.isArray(d.files) ? d.files.length : "—"}</td><td class="num">${d.costUsd != null ? "$" + Number(d.costUsd).toFixed(3) : "—"}</td><td class="mono faint">${ago(d.updatedAt)}</td>
    <td class="row" style="flex-wrap:nowrap"><a class="btn ghost sm" style="display:inline-flex;align-items:center;text-decoration:none" target="_blank" rel="noopener" href="${previewBase}/${encodeURIComponent(d.dir)}/">Open</a><a class="btn ghost sm" style="display:inline-flex;align-items:center;text-decoration:none" href="/api/conjure/download?dir=${encodeURIComponent(d.dir)}">Zip</a><button class="btn ghost sm" data-refine="${esc(d.dir)}" ${running ? "disabled" : ""}>Refine</button></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty">NOTHING CONJURED YET</div></td></tr>`}
  </tbody></table></div></div>`;
  const mock = () => $("#mock").checked;
  $("#go").onclick = async () => {
    const intent = $("#intent").value.trim();
    if (!intent) return toast("Describe what to build", true);
    const j = await startJob("/api/conjure", { intent, mock: mock() }, "Conjure");
    if (j?.id) { state.jobSel = j.id; location.hash = "jobs"; }
  };
  $$("[data-refine]").forEach((b) => (b.onclick = async () => {
    const change = prompt(`Change to apply to ${b.dataset.refine}:`);
    if (!change) return;
    const j = await startJob("/api/conjure/refine", { dir: b.dataset.refine, change, mock: mock() }, "Refine");
    if (j?.id) { state.jobSel = j.id; location.hash = "jobs"; }
  }));
}

/* ---------- OpenClaw ---------- */

// Transcript and draft live here so the 2.5 s poll can re-render without losing them.
state.oc = { agent: "openclaw/default", thread: null, msgs: [], draft: "", busy: false };
const newThread = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function viewOpenclaw() {
  const o = await api("/api/openclaw");
  if (o.error) {
    main.innerHTML = `<h1 class="view">OpenClaw</h1><div class="banner"><b>CONFIG</b><span>${esc(o.error)}</span></div>`;
    return;
  }
  const oc = state.oc;
  if (!oc.thread) oc.thread = newThread();
  const s = o.settings;
  const managed = s.mode === "managed";
  const g = o.gateway;
  const up = o.health.live;
  const ready = o.health.ready;
  const agentOpts = [...new Set(["openclaw/default", ...o.agents])];
  if (!agentOpts.includes(oc.agent)) oc.agent = "openclaw/default";
  const gwState = up ? (o.health.ready ? chip("ready", "st-ok") : chip("starting", "st-running")) : g.running ? chip("starting", "st-running") : chip("stopped", "st-skipped");
  const msgs = oc.msgs.length
    ? oc.msgs.map((m) => `<div class="oc-msg ${m.role}"><div class="who mono">${m.role === "user" ? "OPERATOR" : m.role === "error" ? "ERROR" : esc(m.model || "OPENCLAW")} · ${esc(m.at.slice(11, 19))}</div><div class="txt">${esc(m.text)}</div></div>`).join("")
    : `<div class="empty">${ready ? "GATEWAY READY · SEND AN INSTRUCTION" : up || g.running ? "GATEWAY STARTING · THIS TAKES ABOUT A MINUTE" : "START THE GATEWAY TO TALK TO OPENCLAW"}</div>`;
  main.innerHTML = `
  <h1 class="view">OpenClaw</h1>
  <div class="view-sub up">Agent gateway built into 1MIND · ${managed ? "managed by 1MIND, loopback only" : "external gateway on a private address"} · ${o.live ? "Claude key present" : "no ANTHROPIC_API_KEY: the agent cannot answer until one is set in .env"}</div>
  <div class="grid g-main" style="grid-template-columns:minmax(0,1fr) minmax(0,1.7fr)">
    <div style="display:grid;gap:12px;align-content:start">
      <div class="panel"><header>Gateway<span class="r">${gwState}</span></header><div class="body">
        <dl class="oc-kv">
          <dt>Endpoint</dt><dd class="mono">${esc(s.url)}</dd>
          <dt>Runtime</dt><dd class="mono">${managed ? (o.installed ? "openclaw " + esc(o.installed) : "not installed") : "external"}${managed && o.installed && o.installed !== s.version ? " " + chip("pinned " + s.version, "sev medium") : ""}</dd>
          <dt>Model</dt><dd class="mono">${esc(s.model)}</dd>
          <dt>Process</dt><dd class="mono">${g.running ? "pid " + esc(g.pid) + " · up " + ago(g.startedAt) : g.exitedAt ? "exited " + esc(g.exitCode) + " · " + ago(g.exitedAt) + " ago" : "—"}</dd>
          <dt>Health</dt><dd class="mono">healthz ${esc(o.health.liveStatus ?? "—")} · readyz ${esc(o.health.readyStatus ?? "—")}</dd>
          <dt>Agents</dt><dd class="mono">${o.agents.length ? o.agents.map(esc).join(", ") : o.agentsError ? `<span style="color:var(--crit)">${esc(o.agentsError)}</span>` : "—"}</dd>
        </dl>
        ${managed ? `<div class="row" style="margin-top:12px">
          ${!o.installed ? `<button class="btn" id="oc-install" ${o.installing ? "disabled" : ""}>${o.installing ? "Installing…" : "Install OpenClaw " + esc(s.version)}</button>` : ""}
          ${o.installed && !g.running ? `<button class="btn" id="oc-start">Start gateway</button>` : ""}
          ${g.running ? `<button class="btn danger sm" id="oc-stop">Stop gateway</button>` : ""}
          <button class="btn ghost sm" id="oc-refresh">Refresh</button>
        </div>` : ""}
      </div></div>
      <div class="panel"><header>Gateway log</header><div class="body flush scroll" style="max-height:38vh"><pre class="oc-log" id="oc-log">…</pre></div></div>
    </div>
    <div class="panel oc-chat"><header>Operator console<span class="r">
      <select class="f sm" id="oc-agent">${agentOpts.map((a) => `<option ${a === oc.agent ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>
      <button class="btn ghost sm" id="oc-new" title="Start a new OpenClaw session">New thread</button></span></header>
      <div class="body oc-msgs" id="oc-msgs">${msgs}${oc.busy ? `<div class="oc-msg assistant"><div class="who mono">OPENCLAW</div><div class="txt faint">working…</div></div>` : ""}</div>
      <div class="body" style="border-top:1px solid var(--line);display:grid;gap:8px">
        <textarea class="f" id="oc-input" rows="3" maxlength="20000" placeholder="Instruction for the agent · Ctrl+Enter to send" ${ready && !oc.busy ? "" : "disabled"}>${esc(oc.draft)}</textarea>
        <div class="row"><button class="btn" id="oc-send" ${ready && !oc.busy ? "" : "disabled"}>Send</button><span class="mono faint" style="font-size:11px">thread ${esc(oc.thread)} · each turn is audited (agent and length, not content)</span></div>
      </div>
    </div>
  </div>`;
  const box = $("#oc-msgs");
  box.scrollTop = box.scrollHeight;
  // The gateway takes a minute or more to boot; keep checking until it is ready (not while someone types).
  clearTimeout(state.ocTimer);
  if (managed && g.running && !o.health.ready) {
    const tick = () => {
      if (state.view !== "openclaw") return;
      if (document.activeElement?.matches("input,textarea,select")) state.ocTimer = setTimeout(tick, 5000);
      else viewOpenclaw();
    };
    state.ocTimer = setTimeout(tick, 5000);
  }
  api("/api/openclaw/logs")
    .then((lines) => {
      const el = $("#oc-log");
      if (!el) return;
      el.textContent = lines.map((x) => x.t.slice(11, 19) + "  " + x.l).join("\n") || "no gateway output yet";
      el.parentElement.scrollTop = el.parentElement.scrollHeight;
    })
    .catch(() => {});
  const gw = async (op) => {
    await act(() => api(`/api/openclaw/gateway/${op}`, { method: "POST", body: {} }), op === "start" ? "Gateway starting" : "Gateway stopped");
    setTimeout(() => state.view === "openclaw" && viewOpenclaw(), op === "start" ? 3000 : 600);
  };
  if ($("#oc-install")) $("#oc-install").onclick = async () => { await startJob("/api/openclaw/install", {}, "OpenClaw install"); viewOpenclaw(); };
  if ($("#oc-start")) $("#oc-start").onclick = () => gw("start");
  if ($("#oc-stop")) $("#oc-stop").onclick = () => gw("stop");
  if ($("#oc-refresh")) $("#oc-refresh").onclick = () => viewOpenclaw();
  $("#oc-agent").onchange = (e) => (oc.agent = e.target.value);
  $("#oc-new").onclick = () => { oc.thread = newThread(); oc.msgs = []; viewOpenclaw(); };
  const input = $("#oc-input");
  input.oninput = () => (oc.draft = input.value);
  const send = async () => {
    const message = input.value.trim();
    if (!message || oc.busy) return;
    oc.msgs.push({ role: "user", text: message, at: new Date().toISOString() });
    oc.draft = "";
    oc.busy = true;
    viewOpenclaw();
    try {
      const r = await api("/api/openclaw/chat", { method: "POST", body: { agent: oc.agent, message, thread: oc.thread } });
      oc.msgs.push({ role: "assistant", text: r.reply, model: r.model, at: new Date().toISOString() });
    } catch (e) {
      oc.msgs.push({ role: "error", text: e.message, at: new Date().toISOString() });
    } finally {
      oc.busy = false;
      if (state.view === "openclaw") viewOpenclaw();
    }
  };
  $("#oc-send").onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); };
}

/* ---------- jobs ---------- */

async function viewJobs() {
  const jobs = state.ov.jobs;
  if (!state.jobSel && jobs.length) state.jobSel = jobs[0].id;
  main.innerHTML = `
  <h1 class="view">Jobs</h1>
  <div class="view-sub up">Live operations log</div>
  <div class="grid g-main" style="grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)">
    <div class="panel"><header>Runs · ${jobs.length}</header><div class="body flush scroll" style="max-height:70vh">${jobTable(jobs)}</div></div>
    <div class="panel" id="jobpane"><header>Select a job</header><div class="empty">—</div></div>
  </div>`;
  wireJobRows();
  $$("[data-job]").forEach((el) => {
    el.classList.toggle("sel", el.dataset.job === state.jobSel);
    el.onclick = () => { state.jobSel = el.dataset.job; viewJobs(); };
  });
  await paintJob();
}
async function paintJob() {
  const pane = $("#jobpane");
  if (!pane || !state.jobSel) return;
  let j;
  try {
    j = await api(`/api/jobs/${state.jobSel}`);
  } catch {
    return;
  }
  const logEl = $(".log", pane);
  const stick = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  pane.innerHTML = `<header>${stChip(j.status)} ${esc(j.title)}<span class="r"><span class="mono faint">${dur(j)}</span>${j.status === "running" ? `<button class="btn danger sm" id="cancel">Cancel</button>` : ""}</span></header>
  ${j.result ? `<div class="body mono" style="font-size:11px">${esc(JSON.stringify(j.result))}</div>` : ""}
  <div class="log">${j.log.map((l) => `<div class="${l.level}"><span class="ts">${new Date(l.t).toISOString().slice(11, 19)}</span>${esc(l.l)}</div>`).join("") || `<span class="faint">waiting for output…</span>`}</div>`;
  const nl = $(".log", pane);
  if (stick) nl.scrollTop = nl.scrollHeight;
  else nl.scrollTop = logEl.scrollTop;
  $("#cancel")?.addEventListener("click", () => act(() => api(`/api/jobs/${j.id}/cancel`, { method: "POST" }), "Cancel requested"));
}

/* ---------- audit ---------- */

async function viewAudit() {
  const rows = await api("/api/audit");
  main.innerHTML = `
  <h1 class="view">Audit</h1>
  <div class="view-sub up">Append-only record of every action taken in 1MIND · data/audit.jsonl</div>
  <div class="panel"><header>${rows.length} most recent events</header><div class="body flush scroll" style="max-height:74vh">
  <table><thead><tr><th>Time (UTC)</th><th>Action</th><th>Detail</th></tr></thead><tbody>
  ${rows.map((a) => {
    const { ts, action, ...rest } = a;
    return `<tr><td class="mono dim">${esc(ts.replace("T", " ").slice(0, 19))}</td><td class="mono">${esc(action)}</td><td class="mono faint" style="font-size:11px">${esc(Object.entries(rest).map(([k, v]) => `${k}=${v}`).join("  "))}</td></tr>`;
  }).join("")}
  </tbody></table></div></div>`;
}

/* ---------- router / refresh ---------- */

const VIEWS = { overview: viewOverview, products: viewProducts, pipeline: viewPipeline, redteam: viewRedteam, conjure: viewConjure, openclaw: viewOpenclaw, jobs: viewJobs, audit: viewAudit };

async function refresh() {
  state.ov = await api("/api/overview");
  if (!state.findings) state.findings = (await api("/api/redteam")).findings;
  chrome();
}

async function render() {
  const v = location.hash.slice(1) || "overview";
  state.view = VIEWS[v] ? v : "overview";
  chrome();
  try {
    await VIEWS[state.view]();
  } catch (e) {
    main.innerHTML = `<div class="banner"><b>ERROR</b><span>${esc(e.message)}</span></div>`;
  }
}

window.addEventListener("hashchange", () => { closeDrawer(); render(); });

// Live updates: poll state; re-render views that show job state while things are running.
let lastSig = "";
let booted = false;
setInterval(async () => {
  try {
    await refresh();
  } catch {
    return;
  }
  if (!booted) {
    // The first load stalled (e.g. a slow cold GitHub call): recover as soon as data arrives.
    booted = true;
    lastSig = state.ov.jobs.map((j) => j.id + j.status).join();
    return render();
  }
  const sig = state.ov.jobs.map((j) => j.id + j.status).join();
  if (state.view === "jobs") return paintJob().then(() => sig !== lastSig && viewJobs()).finally(() => (lastSig = sig));
  if (sig !== lastSig && ["pipeline", "products", "conjure", "openclaw"].includes(state.view) && !document.activeElement?.matches("input,textarea,select")) render();
  if (sig !== lastSig) state.findings = (await api("/api/redteam")).findings;
  lastSig = sig;
}, 2500);

// The Cumulus://ID account bar (/cumulus-bar.js): show who is signed in to this server session.
// Module scripts run after deferred ones, so window.CumulusBar is already there.
api("/api/me")
  .then((me) => {
    window.CumulusBar?.setProfile({ name: me.name, username: me.username, email: me.email });
    $("[data-cumulus-bar]")?.classList.add("ready");
  })
  .catch(() => {});

(async () => {
  main.innerHTML = `<div class="empty">ESTABLISHING LINK…</div>`;
  try {
    await refresh();
  } catch (e) {
    main.innerHTML = `<div class="banner"><b>ERROR</b><span>${esc(e.message)}</span></div>`;
    return;
  }
  if (booted) return;
  booted = true;
  lastSig = state.ov.jobs.map((j) => j.id + j.status).join();
  render();
})();
