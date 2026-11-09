// Opt-in v2fly GeoIP / GeoSite reader.
// Wire format is the v2ray GeoIPList / GeoSiteList protobuf (routercommon). No protobuf package:
// the messages we need are a handful of length-delimited fields.
// Datasets are not shipped in git. `npm run geo:fetch` writes them under data/geo/.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../config.js";

const PLAIN = 0;
const REGEX = 1;
const ROOT = 2;
const FULL = 3;

const ENABLED = new Set(["1", "true", "yes", "on"]);

let cache = { key: "", data: null };

/** True only when INFINITUM_GEO_ENABLED is explicitly turned on. Unset means off. */
export function geoEnabled() {
  const v = process.env.INFINITUM_GEO_ENABLED;
  if (v == null) return false;
  return ENABLED.has(String(v).trim().toLowerCase());
}

/** Directory the fetch script fills. Override with INFINITUM_GEO_DIR. */
export function geoDataDir() {
  if (process.env.INFINITUM_GEO_DIR) return path.resolve(process.env.INFINITUM_GEO_DIR);
  return path.join(DATA, "geo");
}

export function resetGeoCache() {
  cache = { key: "", data: null };
}

/**
 * Load geoip.dat and geosite.dat. Returns null when either file is absent.
 * Throws if a file is present but is not a readable protobuf list.
 */
export function loadGeo() {
  const dir = geoDataDir();
  const ipPath = path.join(dir, "geoip.dat");
  const sitePath = path.join(dir, "geosite.dat");
  let ipStat;
  let siteStat;
  try {
    ipStat = fs.statSync(ipPath);
    siteStat = fs.statSync(sitePath);
  } catch {
    return null;
  }
  const key = `${ipPath}:${ipStat.mtimeMs}:${ipStat.size}|${sitePath}:${siteStat.mtimeMs}:${siteStat.size}`;
  if (cache.key === key && cache.data) return cache.data;
  const data = {
    ip: parseGeoIpDat(fs.readFileSync(ipPath)),
    site: parseGeoSiteDat(fs.readFileSync(sitePath)),
  };
  cache = { key, data };
  return data;
}

export function parseGeoIpDat(buf) {
  const forward = new Map();
  const inverse = [];
  walk(buf, (field, wire, val) => {
    if (field !== 1 || wire !== 2) return;
    const entry = parseGeoIp(val);
    if (!entry.code) return;
    if (entry.inverse) {
      const idx = new Map();
      const families = new Set();
      for (const c of entry.cidrs) {
        if (addCidr(idx, c.ip, c.prefix, entry.code)) families.add(c.ip.length);
      }
      inverse.push({ code: entry.code, forward: idx, families });
      return;
    }
    for (const c of entry.cidrs) addCidr(forward, c.ip, c.prefix, entry.code);
  });
  return { forward, inverse };
}

export function parseGeoSiteDat(buf) {
  const site = { full: new Map(), root: new Map(), plain: new Map(), regex: [] };
  walk(buf, (field, wire, val) => {
    if (field !== 1 || wire !== 2) return;
    addSite(site, val);
  });
  return site;
}

/**
 * @returns {{ country: string|null, matches: { code: string, prefix: number, inverse: boolean }[] }}
 */
export function lookupIp(ip, data) {
  const idx = resolve(data)?.ip;
  const empty = { country: null, matches: [] };
  if (!idx) return empty;
  const buf = parseIp(ip);
  if (!buf) return empty;
  const matches = matchForward(idx.forward, buf);
  for (const inv of idx.inverse) {
    if (!inv.families.has(buf.length)) continue;
    if (matchForward(inv.forward, buf).length === 0) matches.push({ code: inv.code, prefix: 0, inverse: true });
  }
  matches.sort((a, b) => b.prefix - a.prefix || Number(a.inverse) - Number(b.inverse) || a.code.localeCompare(b.code));
  return { country: chooseCountry(matches), matches };
}

/** @returns {{ categories: string[] }} */
export function lookupDomain(domain, data) {
  const site = resolve(data)?.site;
  if (!site) return { categories: [] };
  const host = normalizeDomain(domain);
  if (!host) return { categories: [] };
  const found = new Set();
  const take = (arr) => {
    if (arr) for (const c of arr) found.add(c);
  };
  take(site.full.get(host));
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) take(site.root.get(labels.slice(i).join(".")));
  for (const [keyword, codes] of site.plain) {
    if (keyword && host.includes(keyword)) take(codes);
  }
  for (const rule of site.regex) {
    if (rule.re.test(host)) found.add(rule.code);
  }
  return { categories: [...found].sort((a, b) => a.localeCompare(b)) };
}

/**
 * One log line for an in-scope domain. Null when the feature flag is off,
 * so callers leave their output unchanged.
 */
export function describeSurface(domain, ips = []) {
  if (!geoEnabled()) return null;
  let data = null;
  let unreadable = false;
  try {
    data = loadGeo();
  } catch {
    unreadable = true;
  }
  if (!data) return unreadable ? "geo: datasets unreadable" : "geo: datasets not loaded; run npm run geo:fetch";
  const cats = lookupDomain(domain, data).categories;
  const addr = [];
  for (const ip of ips) addr.push(`${ip}=${lookupIp(ip, data).country || "-"}`);
  const cat = cats.length ? cats.join(",") : "-";
  return `geo domain=${domain} categories=${cat}${addr.length ? " " + addr.join(" ") : ""}`;
}

/**
 * Copy an audit entry and, only when the flag is on and the entry carries an
 * address or domain, attach a `geo` annotation. Otherwise the same object is returned.
 */
export function attachGeo(entry) {
  if (!entry || !geoEnabled()) return entry;
  const hasIp = typeof entry.ip === "string" && entry.ip.length > 0;
  const hasDomain = typeof entry.domain === "string" && entry.domain.length > 0;
  const hasIps = Array.isArray(entry.ips);
  if (!hasIp && !hasDomain && !hasIps) return entry;
  try {
    const data = loadGeo();
    const geo = { loaded: Boolean(data) };
    if (hasIp) geo.ip = data ? lookupIp(entry.ip, data) : { country: null, matches: [] };
    if (hasDomain) geo.domain = data ? lookupDomain(entry.domain, data) : { categories: [] };
    if (hasIps) geo.ips = entry.ips.map((ip) => ({ ip, ...(data ? lookupIp(ip, data) : { country: null, matches: [] }) }));
    return { ...entry, geo };
  } catch {
    return { ...entry, geo: { loaded: false } };
  }
}

function resolve(data) {
  return data === undefined ? loadGeo() : data;
}

function chooseCountry(matches) {
  const forward = matches.filter((m) => !m.inverse);
  const pool = forward.length ? forward : matches;
  if (!pool.length) return null;
  const best = pool.reduce((n, m) => Math.max(n, m.prefix), -1);
  const top = pool.filter((m) => m.prefix === best);
  const iso = top.filter((m) => /^[A-Za-z]{2}$/.test(m.code)).sort((a, b) => a.code.localeCompare(b.code));
  if (iso.length) return iso[0].code;
  return top.slice().sort((a, b) => a.code.localeCompare(b.code))[0].code;
}

function parseGeoIp(buf) {
  let country = "";
  let code = "";
  let inverse = false;
  const cidrs = [];
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) country = val.toString("utf8");
    else if (field === 2 && wire === 2) cidrs.push(parseCidr(val));
    else if (field === 3 && wire === 0) inverse = val !== 0;
    else if (field === 5 && wire === 2) code = val.toString("utf8");
  });
  return { code: country || code, inverse, cidrs };
}

function parseCidr(buf) {
  let ip = Buffer.alloc(0);
  let prefix = 0;
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) ip = Buffer.from(val);
    else if (field === 2 && wire === 0) prefix = val;
  });
  return { ip, prefix };
}

function addSite(site, buf) {
  let country = "";
  let code = "";
  const domains = [];
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 2) country = val.toString("utf8");
    else if (field === 2 && wire === 2) domains.push(parseDomain(val));
    else if (field === 4 && wire === 2) code = val.toString("utf8");
  });
  const name = country || code;
  if (!name) return;
  for (const d of domains) {
    const value = d.value.trim().toLowerCase();
    if (!value) continue;
    if (d.type === FULL) pushCode(site.full, value, name);
    else if (d.type === ROOT) pushCode(site.root, value, name);
    else if (d.type === PLAIN) pushCode(site.plain, value, name);
    else if (d.type === REGEX) {
      const re = compileRule(d.value);
      if (re) site.regex.push({ code: name, re });
    }
  }
}

function parseDomain(buf) {
  let type = PLAIN;
  let value = "";
  walk(buf, (field, wire, val) => {
    if (field === 1 && wire === 0) type = val;
    else if (field === 2 && wire === 2) value = val.toString("utf8");
  });
  return { type, value };
}

function pushCode(map, key, code) {
  let arr = map.get(key);
  if (!arr) map.set(key, (arr = []));
  if (!arr.includes(code)) arr.push(code);
}

function compileRule(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function addCidr(forward, ip, prefix, code) {
  if (!Buffer.isBuffer(ip) || (ip.length !== 4 && ip.length !== 16)) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.length * 8) return false;
  const masked = mask(ip, prefix);
  let byPrefix = forward.get(ip.length);
  if (!byPrefix) forward.set(ip.length, (byPrefix = new Map()));
  let byHex = byPrefix.get(prefix);
  if (!byHex) byPrefix.set(prefix, (byHex = new Map()));
  const hex = masked.toString("hex");
  let codes = byHex.get(hex);
  if (!codes) byHex.set(hex, (codes = []));
  if (!codes.includes(code)) codes.push(code);
  return true;
}

function matchForward(forward, ipBuf) {
  const byPrefix = forward.get(ipBuf.length);
  if (!byPrefix) return [];
  const hits = [];
  for (const [prefix, byHex] of byPrefix) {
    const codes = byHex.get(mask(ipBuf, prefix).toString("hex"));
    if (!codes) continue;
    for (const code of codes) hits.push({ code, prefix, inverse: false });
  }
  return hits;
}

function mask(ip, prefix) {
  const out = Buffer.from(ip);
  const bytes = Math.floor(prefix / 8);
  const rem = prefix % 8;
  if (rem) {
    out[bytes] &= (0xff << (8 - rem)) & 0xff;
    out.fill(0, bytes + 1);
  } else {
    out.fill(0, bytes);
  }
  return out;
}

export function parseIp(ip) {
  if (typeof ip !== "string") return null;
  let s = ip.trim().toLowerCase();
  if (!s) return null;
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return parseIpv4(mapped[1]);
  if (s.includes(".")) {
    if (s.includes(":")) return parseIpv6(s);
    return parseIpv4(s);
  }
  if (s.includes(":")) return parseIpv6(s);
  return null;
}

function parseIpv4(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(s) {
  let head = s;
  let v4 = null;
  if (s.includes(".")) {
    const last = s.lastIndexOf(":");
    if (last < 0) return null;
    v4 = parseIpv4(s.slice(last + 1));
    if (!v4) return null;
    head = s.slice(0, last);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const read = (part) => {
    if (part === "") return [];
    const groups = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };
  const left = read(halves[0]);
  if (!left) return null;
  let right = [];
  if (halves.length === 2) {
    right = read(halves[1]);
    if (!right) return null;
  }
  const v4groups = v4 ? [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]] : [];
  const total = left.length + right.length + v4groups.length;
  if (halves.length === 1) {
    if (total !== 8) return null;
  } else if (total > 8) return null;
  const groups = [...left, ...Array(8 - total).fill(0), ...right, ...v4groups];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  const mapped4 = ipv4FromMapped(out);
  return mapped4 || out;
}

function ipv4FromMapped(buf) {
  if (buf.length !== 16) return null;
  for (let i = 0; i < 10; i++) if (buf[i] !== 0) return null;
  if (buf[10] !== 0xff || buf[11] !== 0xff) return null;
  return Buffer.from(buf.subarray(12, 16));
}

function walk(buf, onField) {
  if (!Buffer.isBuffer(buf)) throw new Error("protobuf input must be a buffer");
  let pos = 0;
  const len = buf.length;
  while (pos < len) {
    const [tag, afterTag] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    pos = afterTag;
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      pos = next;
      onField(field, wire, value);
    } else if (wire === 2) {
      const [size, next] = readVarint(buf, pos);
      const end = next + size;
      if (!Number.isInteger(size) || end > len) throw new Error("truncated protobuf length-delimited field");
      onField(field, wire, buf.subarray(next, end));
      pos = end;
    } else if (wire === 5) {
      if (pos + 4 > len) throw new Error("truncated protobuf fixed32");
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > len) throw new Error("truncated protobuf fixed64");
      pos += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  while (pos < buf.length && shift <= 28) {
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new Error("protobuf varint out of range");
      return [value, pos];
    }
    shift += 7;
  }
  throw new Error("truncated protobuf varint");
}

function normalizeDomain(input) {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s || s.length > 2048) return "";
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return "";
    }
  }
  const slash = s.indexOf("/");
  if (slash !== -1) s = s.slice(0, slash);
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (!s || s.startsWith("[")) return "";
  const colon = s.indexOf(":");
  if (colon !== -1) s = s.slice(0, colon);
  if (!s || s.length > 253 || /\s/.test(s)) return "";
  if (/[^\x00-\x7f]/.test(s)) {
    try {
      s = new URL(`http://${s}`).hostname;
    } catch {
      return "";
    }
  }
  return s;
}
