// Tiny JSON-file persistence + append-only audit log. Single process, so writes are serialized per file.
// Writes are fsync'd before the atomic rename: on Windows/NTFS a crash between rename and flush otherwise
// leaves a file of NUL bytes (seen after an unexpected reboot on 2026-11-08).
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../config.js";
import { attachGeo } from "./geo.js";

export function load(name, fallback) {
  const f = path.join(DATA, name + ".json");
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch {
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Keep the damaged file for inspection rather than silently overwriting it on the next save.
    const bad = `${f}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(f, bad);
    } catch {}
    console.error(`[store] ${name}.json was unreadable; moved to ${path.basename(bad)} and starting fresh`);
    return structuredClone(fallback);
  }
}

export function save(name, value) {
  const f = path.join(DATA, name + ".json");
  const tmp = f + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
}

const AUDIT = path.join(DATA, "audit.jsonl");

/** Every state-changing action in 1MIND lands here. */
export function audit(action, detail = {}) {
  const entry = attachGeo({ ts: new Date().toISOString(), action, ...detail });
  const fd = fs.openSync(AUDIT, "a");
  try {
    fs.writeSync(fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return entry;
}

export function readAudit(limit = 200) {
  let text;
  try {
    text = fs.readFileSync(AUDIT, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const l = line.replace(/\0/g, "").trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {} // a line torn by a crash; skip it, keep the rest
  }
  return out.slice(-limit).reverse();
}
