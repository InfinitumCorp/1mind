#!/usr/bin/env node
// Download v2fly geoip.dat and geosite.dat (published as dlc.dat) into data/geo/.
// Checks each file against the official .sha256sum asset and data/geo/lock.json.
// Stops on any mismatch. Does not commit the binaries.
//
// Allowed upstreams are v2fly/geoip and v2fly/domain-list-community only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAT_MAX = 64 * 1024 * 1024;
const SUM_MAX = 4096;
const ALLOWED = new Map([
  ["v2fly/geoip", "geoip.dat"],
  ["v2fly/domain-list-community", "geosite.dat"],
]);

export function parseOfficialSum(text, assetName) {
  const lines = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line);
    if (!m) continue;
    const file = m[2].replace(/^.*\//, "");
    if (file === assetName) return m[1].toLowerCase();
  }
  throw new Error(`official checksum file has no entry for ${assetName}`);
}

export function assertChecksums({ name, actual, official, locked }) {
  const a = String(actual).toLowerCase();
  const o = String(official).toLowerCase();
  const l = String(locked).toLowerCase();
  if (o !== l) {
    throw new Error(`checksum mismatch for ${name}: official .sha256sum ${o} does not match lockfile ${l}`);
  }
  if (a !== l) {
    throw new Error(`checksum mismatch for ${name}: downloaded file ${a} does not match lockfile ${l}`);
  }
}

function assertEntry(entry) {
  const saveAs = ALLOWED.get(entry.upstream);
  if (!saveAs) throw new Error(`refusing upstream ${entry.upstream}; only v2fly geoip and domain-list-community are allowed`);
  if (entry.name !== saveAs) throw new Error(`refusing output name ${entry.name} for ${entry.upstream}`);
  if (entry.upstream === "v2fly/domain-list-community" && entry.asset !== "dlc.dat") {
    throw new Error(`refusing asset ${entry.asset}; geosite.dat must be the v2fly dlc.dat asset`);
  }
  if (entry.upstream === "v2fly/geoip" && entry.asset !== "geoip.dat") {
    throw new Error(`refusing asset ${entry.asset}; expected geoip.dat`);
  }
  for (const key of ["tag", "asset", "sha256sumAsset"]) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(entry[key] || ""))) throw new Error(`bad ${key} in lockfile`);
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) throw new Error(`bad sha256 for ${entry.name}`);
  const base = `https://github.com/${entry.upstream}/releases/download/${entry.tag}`;
  if (entry.url !== `${base}/${entry.asset}`) throw new Error(`refusing URL ${entry.url}`);
  if (entry.sha256sumUrl !== `${base}/${entry.sha256sumAsset}`) throw new Error(`refusing checksum URL ${entry.sha256sumUrl}`);
}

async function readBody(res, maxBytes, label) {
  if (!res.ok) throw new Error(`GET ${label} -> ${res.status}`);
  if (res.body && typeof res.body.getReader === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(res.body)) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(part);
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return buf;
}

async function getBuf(fetchImpl, url, maxBytes) {
  const res = await fetchImpl(url, {
    redirect: "follow",
    headers: { "user-agent": "1MIND-geo-fetch" },
  });
  return readBody(res, maxBytes, url);
}

export async function fetchGeo({ lock, destDir, fetchImpl = globalThis.fetch } = {}) {
  if (!lock?.datasets?.length) throw new Error("lockfile has no datasets");
  fs.mkdirSync(destDir, { recursive: true });
  const saved = [];
  for (const entry of lock.datasets) {
    assertEntry(entry);
    const sumBuf = await getBuf(fetchImpl, entry.sha256sumUrl, SUM_MAX);
    const official = parseOfficialSum(sumBuf.toString("utf8"), entry.asset);
    if (official !== entry.sha256.toLowerCase()) {
      throw new Error(`checksum mismatch for ${entry.name}: official .sha256sum ${official} does not match lockfile ${entry.sha256.toLowerCase()}`);
    }
    const tmp = path.join(destDir, `.${entry.name}.partial`);
    const finalPath = path.join(destDir, entry.name);
    try {
      const buf = await getBuf(fetchImpl, entry.url, DAT_MAX);
      const actual = crypto.createHash("sha256").update(buf).digest("hex");
      assertChecksums({ name: entry.name, actual, official, locked: entry.sha256 });
      fs.writeFileSync(tmp, buf);
      const onDisk = crypto.createHash("sha256").update(fs.readFileSync(tmp)).digest("hex");
      if (onDisk !== actual) throw new Error(`checksum mismatch for ${entry.name}: disk write changed bytes`);
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    saved.push({ name: entry.name, sha256: entry.sha256.toLowerCase(), path: finalPath });
    console.log(`${entry.name}  ${entry.sha256.toLowerCase()}  ok`);
  }
  return saved;
}

async function main() {
  const lockPath = path.join(ROOT, "data", "geo", "lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  await fetchGeo({ lock, destDir: path.join(ROOT, "data", "geo") });
  console.log("geo datasets verified");
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
