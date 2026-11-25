// Runs the offline self-tests of the command-line path (no whisper, no media).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
for (const script of ["transcribe.mjs", "render.mjs", "tiles.mjs"]) {
  test(`${script} --self-test`, () => {
    const result = spawnSync(process.execPath, [join(ROOT, script), "--self-test"], { encoding: "utf8", cwd: ROOT });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
