#!/usr/bin/env node
// Download the pinned v2fly geoip.dat and geosite.dat (upstream asset dlc.dat).
// Checks each official .sha256sum asset against geo.lock.json, then checks the
// bytes. A mismatch deletes any partial file and exits non-zero. The .dat files
// stay in a gitignored data directory and are never committed.
// Loyalsoldier and sing-box lists are GPL-3.0 and are refused.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { geoDataDir } from "../src/lib/geo.js";

const BANNED = /loyalsoldier|sing-box|singbox/i;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Parse a coreutils .sha256sum file and return the hex digest for `asset`. */
export function parseSha256Sum(text, asset) {
  const lines = text.toString("utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  throw new Error(`official sha256sum has no entry for ${asset}`);
}

export function assertLockFile(file) {
  for (const key of ["filename", "asset", "url", "sha256sumUrl", "sha256", "tag", "repo"]) {
    if (!file[key] || typeof file[key] !== "string") throw new Error(`lockfile entry missing ${key}`);
  }
  if (!NAME.test(file.filename)) throw new Error(`refusing filename ${file.filename}`);
  if (!/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error(`bad sha256 for ${file.filename}`);
  for (const value of [file.url, file.sha256sumUrl, file.repo, file.asset, file.filename]) {
    if (BANNED.test(value)) throw new Error(`refusing GPL-3 dataset source: ${value}`);
  }
  for (const url of [file.url, file.sha256sumUrl]) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`dataset URL is not absolute: ${url}`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") throw new Error(`dataset URL must be https://github.com: ${url}`);
    if (!parsed.pathname.startsWith("/v2fly/")) throw new Error(`dataset URL must be a v2fly release: ${url}`);
  }
  return { ...file, sha256: file.sha256.toLowerCase() };
}

export async function downloadHttps(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  if (!String(res.url || "").startsWith("https://")) throw new Error(`refusing non-https response for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Verify every lockfile entry against its official .sha256sum and the downloaded
 * bytes, then write filenames from the lock into `outDir`. Throws on mismatch
 * before any destination file is replaced.
 */
export async function fetchGeoDatasets({ lock, outDir, download = downloadHttps }) {
  if (!lock || !Array.isArray(lock.files) || lock.files.length === 0) throw new Error("geo lockfile has no files");
  const ready = [];
  for (const raw of lock.files) {
    const file = assertLockFile(raw);
    const sumText = await download(file.sha256sumUrl);
    const official = parseSha256Sum(sumText, file.asset);
    if (official !== file.sha256) {
      throw new Error(`checksum mismatch for ${file.asset}: official sha256sum ${official} != lockfile ${file.sha256}`);
    }
    const bytes = await download(file.url);
    const got = sha256(bytes);
    if (got !== file.sha256) {
      throw new Error(`checksum mismatch for ${file.filename}: downloaded ${got} != expected ${file.sha256}`);
    }
    ready.push({ file, bytes });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const staged = [];
  try {
    for (const { file, bytes } of ready) {
      const dest = path.join(outDir, file.filename);
      const tmp = `${dest}.partial`;
      const fd = fs.openSync(tmp, "w", 0o644);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      staged.push({ tmp, dest, file });
    }
    for (const item of staged) fs.renameSync(item.tmp, item.dest);
  } catch (err) {
    for (const item of staged) {
      try {
        fs.rmSync(item.tmp, { force: true });
      } catch {}
    }
    throw err;
  }
  return staged.map((item) => item.dest);
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(path.resolve(arg)).href;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(fs.readFileSync(path.join(root, "geo.lock.json"), "utf8"));
  const outDir = geoDataDir();
  const written = await fetchGeoDatasets({ lock, outDir });
  for (const file of written) console.log(`ok ${file}`);
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
