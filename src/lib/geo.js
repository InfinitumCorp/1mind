// Opt-in geo annotation. Off unless INFINITUM_GEO_ENABLED or the saved switch is on.
// Lookups never allow, deny, or reroute a target. When the switch is off, callers get null
// and must leave logs, policy records, and scan output unchanged.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { setAuditAnnotator, audit } from "./store.js";
import { geoEnabled, getSettings, setGeoRouting, settingsView } from "./settings.js";
import { GeoIpList, GeoSiteList } from "./geodat.js";

export { geoEnabled, getSettings, setGeoRouting, settingsView };

let cache = { key: "", value: null };
let warned = false;

export function geoDataDir() {
  return process.env.INFINITUM_GEO_DIR ? path.resolve(process.env.INFINITUM_GEO_DIR) : path.join(ROOT, "data", "geo");
}

export function resetGeoCache() {
  cache = { key: "", value: null };
  warned = false;
}

function openDatasets() {
  const dir = geoDataDir();
  const geoipPath = path.join(dir, "geoip.dat");
  const geositePath = path.join(dir, "geosite.dat");
  let key = `${dir}:missing`;
  try {
    const a = fs.statSync(geoipPath);
    const b = fs.statSync(geositePath);
    key = `${dir}:${a.mtimeMs}:${a.size}:${b.mtimeMs}:${b.size}`;
  } catch {
    key = `${dir}:missing`;
  }
  if (cache.key === key) return cache.value;
  if (key.endsWith(":missing")) {
    cache = { key, value: null };
    if (!warned) {
      warned = true;
      console.error(`[geo] datasets missing in ${dir}. Run: npm run geo:fetch`);
    }
    return null;
  }
  try {
    cache = {
      key,
      value: {
        geoip: GeoIpList.load(geoipPath),
        geosite: GeoSiteList.load(geositePath),
      },
    };
    return cache.value;
  } catch (e) {
    cache = { key, value: null };
    console.error(`[geo] dataset unreadable: ${e.message}`);
    return null;
  }
}

/**
 * Policy hook: country and category for one IP and/or domain.
 * Returns null when geo routing is off, or when the record has neither field.
 */
export function geoPolicy(detail) {
  if (!geoEnabled()) return null;
  if (!detail || typeof detail !== "object") return null;
  const ip = typeof detail.ip === "string" ? detail.ip : null;
  const domain = typeof detail.domain === "string" ? detail.domain : null;
  if (!ip && !domain) return null;
  const db = openDatasets();
  if (!db) return null;
  const geo = {};
  if (ip) {
    const hit = db.geoip.lookup(ip);
    geo.country = hit.country;
    geo.lists = hit.lists;
  }
  if (domain) geo.categories = db.geosite.lookup(domain).categories;
  return geo;
}

/**
 * Annotation hook for a resolved name. No-op (and no log line) when geo routing is off.
 * @returns {null|{country: string|null, lists: string[], categories: string[]}}
 */
export function noteGeo(log, { domain, ips } = {}) {
  if (!geoEnabled()) return null;
  const db = openDatasets();
  if (!db) return null;
  const categories = domain ? db.geosite.lookup(domain).categories : [];
  let country = null;
  const lists = [];
  for (const ip of ips || []) {
    const hit = db.geoip.lookup(ip);
    if (!country && hit.country) country = hit.country;
    for (const code of hit.lists) if (!lists.includes(code)) lists.push(code);
  }
  if (typeof log === "function") {
    log(`geo country=${country || "-"} lists=${lists.join(",") || "-"} categories=${categories.join(",") || "-"}`);
  }
  return { country, lists, categories };
}

/** Persist the console/CLI switch. Does not override INFINITUM_GEO_ENABLED. */
export function updateGeoRouting(on) {
  if (typeof on !== "boolean") throw Object.assign(new Error("geoRouting must be a boolean"), { status: 400 });
  setGeoRouting(on);
  audit("settings.geo", { enabled: on, via: "settings" });
  return settingsView();
}

/** `--geo` / `--no-geo` write the saved switch. Last flag wins. Returns null when absent. */
export function applyGeoCli(argv = process.argv.slice(2)) {
  let value;
  for (const a of argv) {
    if (a === "--geo" || a === "--geo-routing" || a === "--geo=on" || a === "--geo-routing=on") value = true;
    else if (a === "--no-geo" || a === "--no-geo-routing" || a === "--geo=off" || a === "--geo-routing=off") value = false;
  }
  if (value === undefined) return null;
  const saved = setGeoRouting(value);
  audit("settings.geo", { enabled: saved.geoRouting, via: "cli" });
  return saved;
}

setAuditAnnotator((detail) => geoPolicy(detail));
