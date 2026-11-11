// Minimal decoder for v2fly GeoIPList / GeoSiteList (.dat) files.
// Schema matches v2ray-core routercommon: GeoIPList, GeoSiteList, CIDR, Domain.
// No protobuf dependency. Unknown fields are skipped.
import fs from "node:fs";
import net from "node:net";

const MAX_BYTES = 64 * 1024 * 1024;

function asBuffer(buf) {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new Error("geo dataset must be a byte buffer");
}

function readVarint(buf, i) {
  let x = 0n;
  let shift = 0n;
  while (i < buf.length) {
    const b = buf[i++];
    x |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [x, i];
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

function readLen(buf, i) {
  const [len, j] = readVarint(buf, i);
  const n = Number(len);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("bad length");
  const end = j + n;
  if (end > buf.length) throw new Error("truncated field");
  return [buf.subarray(j, end), end];
}

/** Walk a protobuf message. Calls onField(fieldNumber, wireType, value). */
export function walkProto(buf, onField) {
  let i = 0;
  while (i < buf.length) {
    const [key, j] = readVarint(buf, i);
    const field = Number(key >> 3n);
    const wt = Number(key & 7n);
    if (!Number.isInteger(field) || field <= 0) throw new Error("bad protobuf field");
    if (wt === 0) {
      const [val, next] = readVarint(buf, j);
      onField(field, wt, val);
      i = next;
    } else if (wt === 2) {
      const [slice, next] = readLen(buf, j);
      onField(field, wt, slice);
      i = next;
    } else if (wt === 1) {
      i = j + 8;
      if (i > buf.length) throw new Error("truncated field");
    } else if (wt === 5) {
      i = j + 4;
      if (i > buf.length) throw new Error("truncated field");
    } else {
      throw new Error(`unsupported wire type ${wt}`);
    }
  }
}

function text(buf, max = 2048) {
  return Buffer.from(buf).toString("utf8").replace(/[\r\n\t]/g, "").slice(0, max);
}

function decodeCidr(buf) {
  let ip = new Uint8Array();
  let prefix = 0;
  walkProto(buf, (field, wt, val) => {
    if (field === 1 && wt === 2) ip = Uint8Array.from(val);
    else if (field === 2 && wt === 0) prefix = Number(val);
  });
  return { ip, prefix };
}

function decodeGeoIp(buf) {
  let countryCode = "";
  const cidrs = [];
  let reverseMatch = false;
  walkProto(buf, (field, wt, val) => {
    if (field === 1 && wt === 2) countryCode = text(val, 64);
    else if (field === 2 && wt === 2) cidrs.push(decodeCidr(val));
    else if (field === 3 && wt === 0) reverseMatch = val !== 0n;
  });
  return { countryCode, cidrs, reverseMatch };
}

function decodeDomain(buf) {
  let type = 0;
  let value = "";
  walkProto(buf, (field, wt, val) => {
    if (field === 1 && wt === 0) type = Number(val);
    else if (field === 2 && wt === 2) value = text(val);
  });
  if (type !== 1) value = value.toLowerCase();
  return { type, value };
}

function decodeGeoSite(buf) {
  let category = "";
  const domains = [];
  walkProto(buf, (field, wt, val) => {
    if (field === 1 && wt === 2) category = text(val, 64);
    else if (field === 2 && wt === 2) domains.push(decodeDomain(val));
  });
  return { category, domains };
}

function cidrContains(cidr, ip) {
  if (!cidr.ip?.length || cidr.ip.length !== ip.length) return false;
  const bits = ip.length * 8;
  if (!Number.isInteger(cidr.prefix) || cidr.prefix < 0 || cidr.prefix > bits) return false;
  const full = Math.floor(cidr.prefix / 8);
  const rem = cidr.prefix % 8;
  for (let i = 0; i < full; i++) if (cidr.ip[i] !== ip[i]) return false;
  if (!rem) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (cidr.ip[full] & mask) === (ip[full] & mask);
}

function ipv6Bytes(s) {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => {
    if (!part) return [];
    return part.split(":").map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN));
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left.some((n) => Number.isNaN(n)) || right.some((n) => Number.isNaN(n))) return null;
  let groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill(0), ...right];
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((n, i) => {
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

/** Parse an IP string to 4 or 16 bytes. IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4. */
export function parseIp(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  const kind = net.isIP(s);
  if (kind === 4) {
    const parts = s.split(".").map((p) => Number(p));
    if (parts.some((n) => !Number.isInteger(n) || n > 255)) return null;
    return Uint8Array.from(parts);
  }
  if (kind === 6) return ipv6Bytes(s.toLowerCase());
  return null;
}

export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s || s.length > 512) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  if (s.startsWith("*.")) s = s.slice(2);
  s = s.replace(/\.$/, "");
  if (s.includes(":") && !s.includes("]")) s = s.split(":")[0];
  if (!s || s.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(s) || s.startsWith(".") || s.endsWith(".") || s.includes("..")) return null;
  return s;
}

function compileRegex(pattern) {
  if (!pattern || pattern.length > 200) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export class GeoIpList {
  constructor(entries) {
    this.entries = entries;
  }

  static decode(buf) {
    const raw = asBuffer(buf);
    if (raw.length > MAX_BYTES) throw new Error("geoip dataset exceeds 64MB");
    const entries = [];
    walkProto(raw, (field, wt, val) => {
      if (field === 1 && wt === 2) entries.push(decodeGeoIp(val));
    });
    return new GeoIpList(entries);
  }

  static load(file) {
    return GeoIpList.decode(fs.readFileSync(file));
  }

  /**
   * @returns {{ country: string|null, lists: string[] }}
   * country is the longest-prefix ISO 3166-1 alpha-2 code. reverse_match lists are routing tags only.
   */
  lookup(ip) {
    const bytes = parseIp(ip);
    if (!bytes) return { country: null, lists: [] };
    const lists = [];
    let country = null;
    let best = -1;
    for (const entry of this.entries) {
      let matched = false;
      let longest = -1;
      for (const cidr of entry.cidrs) {
        if (!cidrContains(cidr, bytes)) continue;
        matched = true;
        if (cidr.prefix > longest) longest = cidr.prefix;
      }
      const hit = entry.reverseMatch ? !matched : matched;
      if (!hit) continue;
      if (entry.countryCode) lists.push(entry.countryCode);
      if (entry.reverseMatch) continue;
      const code = entry.countryCode.toUpperCase();
      if (/^[A-Z]{2}$/.test(code) && longest > best) {
        best = longest;
        country = code;
      }
    }
    return { country, lists };
  }
}

export class GeoSiteList {
  constructor(full, suffix, plain, regex) {
    this.full = full;
    this.suffix = suffix;
    this.plain = plain;
    this.regex = regex;
  }

  static decode(buf) {
    const raw = asBuffer(buf);
    if (raw.length > MAX_BYTES) throw new Error("geosite dataset exceeds 64MB");
    const full = new Map();
    const suffix = new Map();
    const plain = [];
    const regex = [];
    const add = (map, key, category) => {
      const cur = map.get(key);
      if (cur) cur.push(category);
      else map.set(key, [category]);
    };
    walkProto(raw, (field, wt, val) => {
      if (field !== 1 || wt !== 2) return;
      const site = decodeGeoSite(val);
      if (!site.category) return;
      for (const domain of site.domains) {
        if (!domain.value) continue;
        if (domain.type === 3) add(full, domain.value, site.category);
        else if (domain.type === 2) add(suffix, domain.value, site.category);
        else if (domain.type === 1) {
          const re = compileRegex(domain.value);
          if (re) regex.push({ re, category: site.category });
        } else if (domain.type === 0) plain.push({ value: domain.value, category: site.category });
      }
    });
    return new GeoSiteList(full, suffix, plain, regex);
  }

  static load(file) {
    return GeoSiteList.decode(fs.readFileSync(file));
  }

  /** @returns {{ categories: string[] }} category codes in dataset order. */
  lookup(domain) {
    const host = normalizeDomain(domain);
    if (!host) return { categories: [] };
    const seen = new Set();
    const categories = [];
    const add = (list) => {
      for (const cat of list || []) {
        if (seen.has(cat)) continue;
        seen.add(cat);
        categories.push(cat);
      }
    };
    add(this.full.get(host));
    let rest = host;
    while (rest) {
      add(this.suffix.get(rest));
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      rest = rest.slice(dot + 1);
    }
    for (const rule of this.plain) {
      if (host.includes(rule.value)) add([rule.category]);
    }
    for (const rule of this.regex) {
      if (rule.re.test(host)) add([rule.category]);
    }
    return { categories };
  }
}
