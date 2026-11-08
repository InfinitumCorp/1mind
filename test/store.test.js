import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../src/config.js";
import { load, save, audit, readAudit } from "../src/lib/store.js";

test("save/load round-trips and leaves no temp file", () => {
  save("_t_roundtrip", { a: [1, 2], b: "x" });
  assert.deepEqual(load("_t_roundtrip", null), { a: [1, 2], b: "x" });
  assert.equal(fs.existsSync(path.join(DATA, "_t_roundtrip.json.tmp")), false);
  fs.rmSync(path.join(DATA, "_t_roundtrip.json"));
});

test("a NUL-filled file (crash residue) is quarantined, not trusted", () => {
  const f = path.join(DATA, "_t_crash.json");
  fs.writeFileSync(f, Buffer.alloc(64));
  assert.deepEqual(load("_t_crash", []), []);
  assert.equal(fs.existsSync(f), false);
  const kept = fs.readdirSync(DATA).filter((n) => n.startsWith("_t_crash.json.corrupt-"));
  assert.equal(kept.length, 1);
  for (const n of kept) fs.rmSync(path.join(DATA, n));
});

test("readAudit skips a torn line and keeps the rest", () => {
  const before = readAudit(10000).length;
  audit("test.one");
  fs.appendFileSync(path.join(DATA, "audit.jsonl"), Buffer.alloc(20));
  fs.appendFileSync(path.join(DATA, "audit.jsonl"), "\n");
  audit("test.two");
  const after = readAudit(10000);
  assert.equal(after.length, before + 2);
  assert.equal(after[0].action, "test.two");
});
