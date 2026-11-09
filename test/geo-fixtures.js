// Tiny synthetic GeoIPList / GeoSiteList protobufs. Not the upstream datasets.
import { createHash } from "node:crypto";

function varint(n) {
  const out = [];
  let x = n;
  while (x > 127) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x);
  return Buffer.from(out);
}
const key = (field, wt) => varint((field << 3) | wt);
const lenField = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const varField = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const strField = (field, s) => lenField(field, Buffer.from(s));

function cidr(ip, prefix, extra = Buffer.alloc(0)) {
  return Buffer.concat([lenField(1, Buffer.from(ip)), varField(2, prefix), extra]);
}

function geoip(code, cidrs, reverse = false) {
  const parts = [strField(1, code), ...cidrs.map((c) => lenField(2, c))];
  if (reverse) parts.push(varField(3, 1));
  return Buffer.concat(parts);
}

function domain(type, value, attrs = []) {
  const parts = [];
  if (type) parts.push(varField(1, type));
  parts.push(strField(2, value));
  for (const a of attrs) parts.push(lenField(3, a));
  return Buffer.concat(parts);
}

function attr(name) {
  return Buffer.concat([strField(1, name), varField(2, 1)]);
}

function geosite(code, domains) {
  return Buffer.concat([strField(1, code), ...domains.map((d) => lenField(2, d))]);
}

export function geoipFixture() {
  const unknown = varField(15, 1);
  const entries = [
    geoip("US", [cidr([10, 0, 0, 0], 8, unknown)]),
    geoip("CA", [cidr([10, 1, 0, 0], 16)]),
    geoip("PRIVATE", [cidr([192, 168, 0, 0], 16)]),
    geoip("JP", [cidr([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32)]),
    geoip("CN", [cidr([10, 0, 0, 0], 8)], true),
  ];
  return Buffer.concat(entries.map((e) => lenField(1, e)));
}

export function geositeFixture() {
  const entries = [
    geosite("ads", [domain(2, "ads.example", [attr("cn")])]),
    geosite("cn", [domain(3, "exact.cn.example")]),
    geosite("keyword", [domain(0, "tracker")]),
    geosite("re", [domain(1, "^re\\.example$")]),
    geosite("skip", [domain(1, "(")]),
  ];
  return Buffer.concat(entries.map((e) => lenField(1, e)));
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
