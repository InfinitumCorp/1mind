// Tiny JSON-file persistence + append-only audit log. Single process, so writes are serialized per file.
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../config.js";

export function load(name, fallback) {
  const f = path.join(DATA, name + ".json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

export function save(name, value) {
  const f = path.join(DATA, name + ".json");
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, f);
}

const AUDIT = path.join(DATA, "audit.jsonl");

/** Every state-changing action in 1MIND lands here. */
export function audit(action, detail = {}) {
  const entry = { ts: new Date().toISOString(), action, ...detail };
  fs.appendFileSync(AUDIT, JSON.stringify(entry) + "\n");
  return entry;
}

export function readAudit(limit = 200) {
  try {
    const lines = fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
