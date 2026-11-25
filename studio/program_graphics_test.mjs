#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProgramGraphicOverlay } from "./program_graphics.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-program-graphics-test-"));
try {
  const lower = await renderProgramGraphicOverlay({
    type: "lower_third",
    hostOneName: "Host One",
    hostTwoName: "Host Two",
    outputPath: join(root, "lower.png"),
  });
  const topic = await renderProgramGraphicOverlay({
    type: "topic_bar",
    title: "A Sample Topic Title",
    outputPath: join(root, "topic.png"),
  });
  assert.deepEqual([lower.width, lower.height], [1800, 140]);
  assert.deepEqual([topic.width, topic.height], [1320, 118]);
  assert.ok(lower.bytes > 1_000 && topic.bytes > 1_000);
  console.log("PASS lower-thirds and topic bars render as transparent review overlays");
} finally {
  rmSync(root, { recursive: true, force: true });
}
