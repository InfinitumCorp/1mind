// Loaded before every test file: tests get a throwaway data dir so they never touch the real audit log.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

if (!process.env.ONEMIND_DATA) {
  process.env.ONEMIND_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "1mind-test-"));
}
