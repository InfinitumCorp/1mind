import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audit, readAudit } from "../src/lib/store.js";
import {
  attachGeo,
  describeSurface,
  geoEnabled,
  lookupDomain,
  lookupIp,
  parseGeoIpDat,
  parseGeoSiteDat,
  parseIp,
  resetGeoCache,
} from "../src/lib/geo.js";
import { noteSurfaceGeo } from "../src/lib/redteam.js";
import { assertLockFile, fetchGeoDatasets, parseSha256Sum, sha256 } from "../scripts/fetch-geo.mjs";

const LOCK_IP = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const LOCK_SITE = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

function varint(n) {
  const bytes = [];
  let v = n;
  while (v > 127) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
const key = (field, wire) => varint((field << 3) | wire);
const ld = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const str = (field, s) => ld(field, Buffer.from(s));
const varField = (field, n) => Buffer.concat([key(field, 0), varint(n)]);
const ipv4 = (a, b, c, d) => Buffer.from([a, b, c, d]);
const cidr = (ip, prefix) => Buffer.concat([ld(1, ip), varField(2, prefix)]);
const geoip = (code, cidrs, inverse = false) => {
  const parts = [str(1, code), ...cidrs.map((c) => ld(2, c))];
  if (inverse) parts.push(varField(3, 1));
  return Buffer.concat(parts);
};
const geoipList = (entries) => Buffer.concat(entries.map((e) => ld(1, e)));
const domain = (type, value) => Buffer.concat([varField(1, type), str(2, value)]);
const geosite = (code, domains) => Buffer.concat([str(1, code), ...domains.map((d) => ld(2, d))]);
const geositeList = (entries) => Buffer.concat(entries.map((e) => ld(1, e)));

function ipv6(groups) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

function fixture() {
  const wide = [];
  for (let i = 0; i < 20; i++) wide.push(cidr(ipv4(203, 0, i, 9), 24));
  const ip = geoipList([
    geoip("CN", [cidr(ipv4(1, 2, 0, 0), 16)]),
    geoip("US", [cidr(ipv4(1, 2, 3, 9), 24), cidr(ipv4(8, 8, 8, 8), 32), ...wide]),
    geoip("PRIVATE", [cidr(ipv4(10, 0, 0, 0), 8)]),
    geoip("INV", [cidr(ipv4(192, 0, 2, 0), 24)], true),
    geoip("EX", [cidr(ipv6([0x2001, 0x0db8, 0xabcd, 0, 0, 0, 0, 0]), 48)]),
  ]);
  const site = geositeList([
    geosite("google", [domain(2, "google.com")]),
    geosite("ads", [domain(0, "doubleclick")]),
    geosite("trackers", [domain(1, "^metrics\\.example\\.com$"), domain(1, "(")]),
    geosite("cdn", [domain(3, "cdn.example.com")]),
    geosite("kw", [domain(0, "google")]),
  ]);
  return {
    ip,
    site,
    data: { ip: parseGeoIpDat(ip), site: parseGeoSiteDat(site) },
  };
}

function withEnv(extra, fn) {
  const prev = {
    INFINITUM_GEO_ENABLED: process.env.INFINITUM_GEO_ENABLED,
    INFINITUM_GEO_DIR: process.env.INFINITUM_GEO_DIR,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  resetGeoCache();
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetGeoCache();
  }
}

const FX = fixture();

describe("v2fly geo datasets", { concurrency: false }, () => {
  test("lockfile pins the verified v2fly release assets", () => {
    const lock = JSON.parse(fs.readFileSync(new URL("../geo.lock.json", import.meta.url), "utf8"));
    const ip = lock.files.find((f) => f.filename === "geoip.dat");
    const site = lock.files.find((f) => f.filename === "geosite.dat");
    assert.equal(ip.sha256, LOCK_IP);
    assert.equal(ip.tag, "202611080027");
    assert.equal(ip.asset, "geoip.dat");
    assert.equal(ip.license, "CC-BY-SA-4.0");
    assert.equal(site.sha256, LOCK_SITE);
    assert.equal(site.tag, "20261108011013");
    assert.equal(site.asset, "dlc.dat");
    assert.equal(site.license, "MIT");
    assert.match(lock.excluded.join(" "), /GPL-3\.0/);
    for (const file of lock.files) {
      assert.match(file.url, /^https:\/\/github\.com\/v2fly\//);
      assert.doesNotMatch(`${file.url} ${file.repo}`, /loyalsoldier|sing-box|singbox/i);
    }
  });

  test("parses synthetic GeoIPList lookups", () => {
    assert.equal(lookupIp("1.2.3.4", FX.data).country, "US");
    assert.equal(lookupIp("1.2.9.9", FX.data).country, "CN");
    assert.equal(lookupIp("8.8.8.8", FX.data).country, "US");
    assert.equal(lookupIp("10.1.2.3", FX.data).country, "PRIVATE");
    assert.equal(lookupIp("203.0.7.15", FX.data).country, "US");
    assert.equal(lookupIp("::ffff:1.2.3.4", FX.data).country, "US");
    assert.equal(lookupIp("2001:db8:abcd::1", FX.data).country, "EX");
    assert.equal(lookupIp("2001:db8:ffff::1", FX.data).country, null);
    assert.equal(lookupIp("198.51.100.10", FX.data).country, "INV");
    assert.equal(lookupIp("192.0.2.10", FX.data).country, null);
    const both = lookupIp("1.2.3.4", FX.data).matches.map((m) => m.code);
    assert.ok(both.includes("US"));
    assert.ok(both.includes("CN"));
    assert.ok(both.includes("INV"));
    assert.equal(lookupIp("not-an-ip", FX.data).country, null);
    assert.equal(parseIp("::1")?.length, 16);
  });

  test("parses synthetic GeoSiteList lookups", () => {
    assert.deepEqual(lookupDomain("mail.google.com", FX.data).categories, ["google", "kw"]);
    assert.deepEqual(lookupDomain("MAIL.GOOGLE.COM.", FX.data).categories, ["google", "kw"]);
    assert.deepEqual(lookupDomain("notgoogle.com", FX.data).categories, ["kw"]);
    assert.deepEqual(lookupDomain("x.doubleclick.net", FX.data).categories, ["ads"]);
    assert.deepEqual(lookupDomain("metrics.example.com", FX.data).categories, ["trackers"]);
    assert.deepEqual(lookupDomain("www.metrics.example.com", FX.data).categories, []);
    assert.deepEqual(lookupDomain("cdn.example.com", FX.data).categories, ["cdn"]);
    assert.deepEqual(lookupDomain("www.cdn.example.com", FX.data).categories, []);
    assert.deepEqual(lookupDomain("https://a.b.google.com/path", FX.data).categories, ["google", "kw"]);
  });

  test("rejects a truncated protobuf", () => {
    assert.throws(() => parseGeoIpDat(Buffer.from([0x0a, 0x7f])), /truncated protobuf/);
    assert.throws(() => parseGeoSiteDat(Buffer.from([0x0f])), /unsupported protobuf wire type/);
  });

  test("feature flag defaults off and accepts the documented on values", () => {
    withEnv({ INFINITUM_GEO_ENABLED: null }, () => {
      assert.equal(geoEnabled(), false);
      assert.equal(describeSurface("example.com", ["1.1.1.1"]), null);
    });
    for (const off of ["", "0", "false", "no", "off"]) {
      withEnv({ INFINITUM_GEO_ENABLED: off }, () => assert.equal(geoEnabled(), false));
    }
    for (const on of ["1", "true", "YES", "on"]) {
      withEnv({ INFINITUM_GEO_ENABLED: on }, () => assert.equal(geoEnabled(), true));
    }
  });

  test("audit and surface notes stay unchanged while the flag is off", () => {
    withEnv({ INFINITUM_GEO_ENABLED: null, INFINITUM_GEO_DIR: null }, () => {
      const entry = audit("auth.ok", { ip: "1.2.3.4" });
      assert.equal("geo" in entry, false);
      assert.equal(readAudit(5)[0].action, "auth.ok");
      assert.equal("geo" in readAudit(5)[0], false);
      const before = readAudit(10000).filter((e) => e.action === "surface.geo").length;
      const line = noteSurfaceGeo("mail.google.com", ["1.2.3.4"], () => {
        throw new Error("log should not run");
      });
      assert.equal(line, null);
      assert.equal(readAudit(10000).filter((e) => e.action === "surface.geo").length, before);
    });
  });

  test("enabled hook annotates address and domain without inventing a target", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-geo-"));
    fs.writeFileSync(path.join(dir, "geoip.dat"), FX.ip);
    fs.writeFileSync(path.join(dir, "geosite.dat"), FX.site);
    withEnv({ INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: dir }, () => {
      const auth = audit("auth.ok", { ip: "8.8.8.8" });
      assert.equal(auth.geo.loaded, true);
      assert.equal(auth.geo.ip.country, "US");
      const plain = audit("job.start", { job: "abc", target: "1mind" });
      assert.equal("geo" in plain, false);
      const lines = [];
      const noted = noteSurfaceGeo("mail.google.com", ["1.2.3.4", "2001:db8:abcd::1"], (l) => lines.push(l));
      assert.match(noted, /categories=google,kw/);
      assert.match(noted, /1\.2\.3\.4=US/);
      assert.match(noted, /2001:db8:abcd::1=EX/);
      assert.equal(lines.length, 1);
      const surface = readAudit(20).find((e) => e.action === "surface.geo" && e.domain === "mail.google.com");
      assert.equal(surface.geo.domain.categories.includes("google"), true);
      assert.equal(surface.geo.ips[0].country, "US");
    });
  });

  test("enabled hook reports a missing dataset and still returns the entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-geo-empty-"));
    withEnv({ INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: dir }, () => {
      const entry = attachGeo({ action: "auth.fail", ip: "1.2.3.4" });
      assert.equal(entry.geo.loaded, false);
      assert.match(describeSurface("example.com", []), /not loaded/);
    });
  });

  test("sha256sum parser accepts coreutils text and binary lines", () => {
    const hash = "ab".repeat(32);
    assert.equal(parseSha256Sum(`${hash}  geoip.dat\n`, "geoip.dat"), hash);
    assert.equal(parseSha256Sum(`${hash.toUpperCase()} *dlc.dat\n`, "dlc.dat"), hash);
    assert.throws(() => parseSha256Sum(`${hash}  other.dat\n`, "dlc.dat"), /no entry for dlc.dat/);
  });

  test("fetch refuses a GPL-3 source and a non-v2fly URL", () => {
    assert.throws(() => assertLockFile({
      filename: "geoip.dat",
      asset: "geoip.dat",
      repo: "Loyalsoldier/geoip",
      tag: "t",
      sha256: LOCK_IP,
      url: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat",
      sha256sumUrl: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat.sha256sum",
    }), /GPL-3/);
    assert.throws(() => assertLockFile({
      filename: "geoip.dat",
      asset: "geoip.dat",
      repo: "v2fly/geoip",
      tag: "t",
      sha256: LOCK_IP,
      url: "https://github.com/SagerNet/sing-box/releases/download/t/geoip.dat",
      sha256sumUrl: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat.sha256sum",
    }), /GPL-3|v2fly/);
  });

  test("fetch stops when the official sha256sum disagrees with the lockfile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-geo-fetch-"));
    const official = "ab".repeat(32);
    let calls = 0;
    const lock = {
      files: [{
        filename: "geoip.dat",
        asset: "geoip.dat",
        repo: "v2fly/geoip",
        tag: "t",
        sha256: "cd".repeat(32),
        url: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat",
        sha256sumUrl: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat.sha256sum",
      }],
    };
    await assert.rejects(
      () => fetchGeoDatasets({
        lock,
        outDir: dir,
        download: async () => {
          calls += 1;
          return Buffer.from(`${official}  geoip.dat\n`);
        },
      }),
      (err) => {
        assert.match(err.message, /checksum mismatch/);
        assert.match(err.message, new RegExp(official));
        assert.match(err.message, new RegExp("cd".repeat(32)));
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(dir, "geoip.dat")), false);
    assert.equal(fs.readdirSync(dir).length, 0);
  });

  test("fetch stops when the downloaded bytes disagree with the lockfile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-geo-fetch-"));
    const expected = "cd".repeat(32);
    const lock = {
      files: [{
        filename: "geosite.dat",
        asset: "dlc.dat",
        repo: "v2fly/domain-list-community",
        tag: "t",
        sha256: expected,
        url: "https://github.com/v2fly/domain-list-community/releases/download/t/dlc.dat",
        sha256sumUrl: "https://github.com/v2fly/domain-list-community/releases/download/t/dlc.dat.sha256sum",
      }],
    };
    await assert.rejects(
      () => fetchGeoDatasets({
        lock,
        outDir: dir,
        download: async (url) => {
          if (url.endsWith(".sha256sum")) return Buffer.from(`${expected}  dlc.dat\n`);
          return Buffer.from("not-the-dataset");
        },
      }),
      /checksum mismatch for geosite\.dat/,
    );
    assert.equal(fs.existsSync(path.join(dir, "geosite.dat")), false);
    assert.equal(fs.existsSync(path.join(dir, "geosite.dat.partial")), false);
  });

  test("fetch writes both datasets only after every checksum matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-geo-fetch-"));
    const ipHash = sha256(FX.ip);
    const siteHash = sha256(FX.site);
    const lock = {
      files: [
        {
          filename: "geoip.dat",
          asset: "geoip.dat",
          repo: "v2fly/geoip",
          tag: "t",
          sha256: ipHash,
          url: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat",
          sha256sumUrl: "https://github.com/v2fly/geoip/releases/download/t/geoip.dat.sha256sum",
        },
        {
          filename: "geosite.dat",
          asset: "dlc.dat",
          repo: "v2fly/domain-list-community",
          tag: "t",
          sha256: siteHash,
          url: "https://github.com/v2fly/domain-list-community/releases/download/t/dlc.dat",
          sha256sumUrl: "https://github.com/v2fly/domain-list-community/releases/download/t/dlc.dat.sha256sum",
        },
      ],
    };
    const blobs = new Map([
      [lock.files[0].sha256sumUrl, Buffer.from(`${ipHash}  geoip.dat\n`)],
      [lock.files[0].url, FX.ip],
      [lock.files[1].sha256sumUrl, Buffer.from(`${siteHash}  dlc.dat\n`)],
      [lock.files[1].url, FX.site],
    ]);
    const written = await fetchGeoDatasets({
      lock,
      outDir: dir,
      download: async (url) => {
        const buf = blobs.get(url);
        if (!buf) throw new Error(`unexpected ${url}`);
        return buf;
      },
    });
    assert.deepEqual(written, [path.join(dir, "geoip.dat"), path.join(dir, "geosite.dat")]);
    assert.equal(sha256(fs.readFileSync(path.join(dir, "geosite.dat"))), siteHash);
    withEnv({ INFINITUM_GEO_DIR: dir }, () => {
      assert.equal(lookupIp("8.8.8.8").country, "US");
      assert.equal(lookupDomain("cdn.example.com").categories.includes("cdn"), true);
    });
  });
});
