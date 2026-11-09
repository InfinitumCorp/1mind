import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DATA, ROOT } from "../src/config.js";
import { GeoIpList, GeoSiteList } from "../src/lib/geodat.js";
import { audit, readAudit } from "../src/lib/store.js";
import { addDomain } from "../src/lib/redteam.js";
import { geoEnabled, getSettings, setGeoRouting, settingsView, geoPolicy, noteGeo, applyGeoCli, resetGeoCache, updateGeoRouting } from "../src/lib/geo.js";
import { fetchGeo, parseOfficialSum } from "../scripts/fetch-geo.mjs";
import { geoipFixture, geositeFixture, sha256 } from "./geo-fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const geoipPath = path.join(here, "fixtures", "geoip.dat");
const geositePath = path.join(here, "fixtures", "geosite.dat");

function useFixtures() {
  process.env.INFINITUM_GEO_DIR = path.join(here, "fixtures");
  resetGeoCache();
}

test("synthetic geoip and geosite fixtures resolve country and category", () => {
  const ipFile = fs.readFileSync(geoipPath);
  const siteFile = fs.readFileSync(geositePath);
  assert.deepEqual(ipFile, geoipFixture());
  assert.deepEqual(siteFile, geositeFixture());

  const ips = GeoIpList.decode(ipFile);
  const sites = GeoSiteList.decode(siteFile);

  assert.deepEqual(ips.lookup("10.1.2.3"), { country: "CA", lists: ["US", "CA"] });
  assert.deepEqual(ips.lookup("10.2.0.1"), { country: "US", lists: ["US"] });
  assert.deepEqual(ips.lookup("11.0.0.1"), { country: null, lists: ["CN"] });
  assert.deepEqual(ips.lookup("192.168.1.5"), { country: null, lists: ["PRIVATE", "CN"] });
  assert.deepEqual(ips.lookup("2001:db8::1"), { country: "JP", lists: ["JP", "CN"] });
  assert.deepEqual(ips.lookup("::ffff:10.1.2.3"), { country: "CA", lists: ["US", "CA"] });
  assert.deepEqual(ips.lookup("8.8.8.8"), { country: null, lists: ["CN"] });
  assert.deepEqual(ips.lookup("not-an-ip"), { country: null, lists: [] });

  assert.deepEqual(sites.lookup("a.ads.example").categories, ["ads"]);
  assert.deepEqual(sites.lookup("https://A.ADS.example/path").categories, ["ads"]);
  assert.deepEqual(sites.lookup("ads.example:443").categories, ["ads"]);
  assert.deepEqual(sites.lookup("exact.cn.example").categories, ["cn"]);
  assert.deepEqual(sites.lookup("sub.exact.cn.example").categories, []);
  assert.deepEqual(sites.lookup("foo-tracker.test").categories, ["keyword"]);
  assert.deepEqual(sites.lookup("tracker.ads.example").categories, ["ads", "keyword"]);
  assert.deepEqual(sites.lookup("re.example").categories, ["re"]);
  assert.deepEqual(sites.lookup("no.re.example").categories, []);
  assert.throws(() => GeoIpList.decode(Buffer.from([0x80])), /truncated varint/);
});

test("lockfile matches the published v2fly checksums", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "geo", "lock.json"), "utf8"));
  assert.deepEqual(
    lock.datasets.map((d) => [d.name, d.upstream, d.asset, d.license, d.sha256]),
    [
      ["geoip.dat", "v2fly/geoip", "geoip.dat", "CC-BY-SA-4.0", "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2"],
      ["geosite.dat", "v2fly/domain-list-community", "dlc.dat", "MIT", "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2"],
    ],
  );
  assert.equal(parseOfficialSum("eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n", "geoip.dat"), lock.datasets[0].sha256);
  assert.equal(parseOfficialSum("dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2  dlc.dat\n", "dlc.dat"), lock.datasets[1].sha256);
  const ignored = execFileSync("git", ["check-ignore", "data/geo/geoip.dat"], { cwd: ROOT, encoding: "utf8" });
  assert.match(ignored, /geoip\.dat/);
});

function fakeFetch(map) {
  return async (url) => {
    const hit = map[url];
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = Buffer.from(hit);
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  };
}

function sampleLock(bytes, name, upstream, asset) {
  const hash = sha256(bytes);
  const tag = "202611080027";
  const sumAsset = `${asset}.sha256sum`;
  return {
    entry: {
      name,
      upstream,
      tag,
      asset,
      sha256sumAsset: sumAsset,
      url: `https://github.com/${upstream}/releases/download/${tag}/${asset}`,
      sha256sumUrl: `https://github.com/${upstream}/releases/download/${tag}/${sumAsset}`,
      sha256: hash,
      license: upstream.endsWith("geoip") ? "CC-BY-SA-4.0" : "MIT",
    },
    sum: `${hash}  ${asset}\n`,
    bytes,
  };
}

test("fetch script verifies checksums and refuses other upstreams", async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "geo-fetch-"));
  const ip = sampleLock(Buffer.from("geoip-bytes"), "geoip.dat", "v2fly/geoip", "geoip.dat");
  const site = sampleLock(Buffer.from("geosite-bytes"), "geosite.dat", "v2fly/domain-list-community", "dlc.dat");
  const map = {
    [ip.entry.sha256sumUrl]: Buffer.from(ip.sum),
    [ip.entry.url]: ip.bytes,
    [site.entry.sha256sumUrl]: Buffer.from(site.sum),
    [site.entry.url]: site.bytes,
  };
  const saved = await fetchGeo({ lock: { datasets: [ip.entry, site.entry] }, destDir: dest, fetchImpl: fakeFetch(map) });
  assert.equal(saved.length, 2);
  assert.equal(fs.readFileSync(path.join(dest, "geosite.dat")).toString(), "geosite-bytes");
  assert.equal(sha256(fs.readFileSync(path.join(dest, "geoip.dat"))), ip.entry.sha256);

  const badMap = { ...map, [ip.entry.url]: Buffer.from("tampered") };
  const destBad = fs.mkdtempSync(path.join(os.tmpdir(), "geo-fetch-bad-"));
  await assert.rejects(
    () => fetchGeo({ lock: { datasets: [ip.entry] }, destDir: destBad, fetchImpl: fakeFetch(badMap) }),
    /checksum mismatch for geoip\.dat: downloaded file/,
  );
  assert.equal(fs.existsSync(path.join(destBad, "geoip.dat")), false);
  assert.equal(fs.existsSync(path.join(destBad, ".geoip.dat.partial")), false);

  const sumMap = { ...map, [ip.entry.sha256sumUrl]: Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  geoip.dat\n") };
  await assert.rejects(
    () => fetchGeo({ lock: { datasets: [ip.entry] }, destDir: destBad, fetchImpl: fakeFetch(sumMap) }),
    /official \.sha256sum .* does not match lockfile/,
  );

  await assert.rejects(
    () =>
      fetchGeo({
        lock: { datasets: [{ ...ip.entry, upstream: "Loyalsoldier/v2ray-rules-dat" }] },
        destDir: destBad,
        fetchImpl: () => {
          throw new Error("should not fetch");
        },
      }),
    /refusing upstream/,
  );
  await assert.rejects(
    () =>
      fetchGeo({
        lock: { datasets: [{ ...site.entry, upstream: "SagerNet/sing-box" }] },
        destDir: destBad,
        fetchImpl: () => {
          throw new Error("should not fetch");
        },
      }),
    /refusing upstream/,
  );
});

test("geo routing stays off until opted in", async (t) => {
  const priorEnabled = process.env.INFINITUM_GEO_ENABLED;
  const priorDir = process.env.INFINITUM_GEO_DIR;
  t.after(() => {
    if (priorEnabled === undefined) delete process.env.INFINITUM_GEO_ENABLED;
    else process.env.INFINITUM_GEO_ENABLED = priorEnabled;
    if (priorDir === undefined) delete process.env.INFINITUM_GEO_DIR;
    else process.env.INFINITUM_GEO_DIR = priorDir;
    setGeoRouting(false);
    resetGeoCache();
  });

  delete process.env.INFINITUM_GEO_ENABLED;
  setGeoRouting(false);
  resetGeoCache();
  assert.equal(getSettings().geoRouting, false);
  assert.equal(geoEnabled(), false);
  assert.equal(geoPolicy({ domain: "a.ads.example", ip: "10.1.2.3" }), null);
  let logged = false;
  assert.equal(noteGeo(() => {
    logged = true;
  }, { domain: "a.ads.example", ips: ["10.1.2.3"] }), null);
  assert.equal(logged, false);

  useFixtures();
  audit("test.geo.off", { domain: "a.ads.example", ip: "10.1.2.3" });
  const off = readAudit(20).find((r) => r.action === "test.geo.off");
  assert.equal(off.domain, "a.ads.example");
  assert.equal(off.ip, "10.1.2.3");
  assert.equal("geo" in off, false);

  setGeoRouting(true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8")).geoRouting, true);
  assert.equal(geoEnabled(), true);
  const onPolicy = geoPolicy({ domain: "tracker.ads.example", ip: "10.1.2.3" });
  assert.equal(onPolicy.country, "CA");
  assert.deepEqual(onPolicy.categories, ["ads", "keyword"]);

  process.env.INFINITUM_GEO_ENABLED = "off";
  assert.equal(settingsView().envLocked, true);
  assert.equal(settingsView().effective, false);
  assert.equal(settingsView().geoRouting, true);
  assert.equal(geoPolicy({ domain: "a.ads.example", ip: "10.1.2.3" }), null);
  delete process.env.INFINITUM_GEO_ENABLED;

  process.env.INFINITUM_GEO_ENABLED = "on";
  audit("test.geo.on", { domain: "a.ads.example", ip: "10.1.2.3" });
  const on = readAudit(20).find((r) => r.action === "test.geo.on");
  assert.deepEqual(on.geo, { country: "CA", lists: ["US", "CA"], categories: ["ads"] });

  let line = "";
  const note = noteGeo((l) => {
    line = l;
  }, { domain: "exact.cn.example", ips: ["2001:db8::1", "192.168.0.9"] });
  assert.equal(line, "geo country=JP lists=JP,CN,PRIVATE categories=cn");
  assert.equal(note.country, "JP");

  addDomain("ads.example", { operator: "tester", attestation: true });
  const scoped = readAudit(20).find((r) => r.action === "scope.add" && r.domain === "ads.example");
  assert.deepEqual(scoped.geo.categories, ["ads"]);

  process.env.INFINITUM_GEO_ENABLED = "off";
  addDomain("exact.cn.example", { operator: "tester", attestation: true });
  const plain = readAudit(20).find((r) => r.action === "scope.add" && r.domain === "exact.cn.example");
  assert.equal(plain.operator, "tester");
  assert.equal("geo" in plain, false);

  delete process.env.INFINITUM_GEO_ENABLED;
  applyGeoCli(["--no-geo", "--geo"]);
  assert.equal(getSettings().geoRouting, true);
  applyGeoCli(["--geo=on", "--no-geo"]);
  assert.equal(getSettings().geoRouting, false);
  assert.equal(applyGeoCli(["--unrelated"]), null);

  process.env.INFINITUM_GEO_ENABLED = "maybe";
  assert.throws(() => geoEnabled(), /INFINITUM_GEO_ENABLED/);
  delete process.env.INFINITUM_GEO_ENABLED;
  assert.equal(updateGeoRouting(false).effective, false);
  assert.throws(() => updateGeoRouting("on"), /boolean/);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

test("console geo switch persists and defaults off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-geo-http-"));
  const port = await freePort();
  const preview = await freePort();
  const env = { ...process.env, ONEMIND_TOKEN: "test-token", ONEMIND_DATA: dir, PORT: String(port), PREVIEW_PORT: String(preview) };
  delete env.INFINITUM_GEO_ENABLED;
  delete env.INFINITUM_GEO_DIR;
  const child = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start\n${out}\n${err}`)), 8000);
      child.stdout.on("data", (d) => {
        out += d;
        if (out.includes("geo routing   off")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}\n${out}\n${err}`));
      });
    });
    const login = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      body: new URLSearchParams({ token: "test-token" }),
      redirect: "manual",
    });
    const cookie = /onemind=([^;]+)/.exec(login.headers.get("set-cookie") || "");
    assert.ok(cookie, "session cookie");
    const headers = { cookie: `onemind=${cookie[1]}` };
    const page = await fetch(`http://127.0.0.1:${port}/`, { headers });
    const html = await page.text();
    assert.match(html, /id="geo-toggle"/);
    assert.match(html, /GEO OFF/);
    const first = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers });
    assert.deepEqual(await first.json(), { geoRouting: false, effective: false, envLocked: false });
    const denied = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "POST", headers, body: JSON.stringify({ geoRouting: true }) });
    assert.equal(denied.status, 403);
    const saved = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-1mind": "1" },
      body: JSON.stringify({ geoRouting: true }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { geoRouting: true, effective: true, envLocked: false });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).geoRouting, true);
    const back = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-1mind": "1" },
      body: JSON.stringify({ geoRouting: false }),
    });
    assert.deepEqual(await back.json(), { geoRouting: false, effective: false, envLocked: false });
  } finally {
    stop();
    await new Promise((resolve) => child.on("exit", resolve));
  }
});

test("real v2fly datasets decode when fetched", () => {
  const geoip = path.join(ROOT, "data", "geo", "geoip.dat");
  const geosite = path.join(ROOT, "data", "geo", "geosite.dat");
  if (!fs.existsSync(geoip) || !fs.existsSync(geosite)) return;
  const ips = GeoIpList.load(geoip);
  const us = ips.lookup("8.8.8.8");
  assert.equal(us.country, "US");
  const priv = ips.lookup("192.168.1.1");
  assert.equal(priv.country, null);
  assert.ok(priv.lists.some((c) => c.toUpperCase() === "PRIVATE"));
  const sites = GeoSiteList.load(geosite);
  const cats = sites.lookup("www.google.com").categories;
  assert.ok(cats.length > 0, "expected at least one geosite category for www.google.com");
});
