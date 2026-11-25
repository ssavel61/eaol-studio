#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTool, setupHint } from "../platform_tools.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tools = {
  ffmpeg: resolveTool("ffmpeg"),
  ffprobe: resolveTool("ffprobe"),
  whisper: resolveTool("whisper"),
};

function run(name, args) {
  const command = tools[name];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) return { ok: false, detail: `${command}: ${result.error.message}`, output: "" };
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return { ok: result.status === 0, detail: output.split(/\r?\n/).find(Boolean) || `${command} exited ${result.status}`, output };
}

const checks = [
  ["Node.js 20+", Number(process.versions.node.split(".")[0]) >= 20, `v${process.versions.node}`],
];
for (const [name, args] of [
  ["ffmpeg", ["-version"]],
  ["ffprobe", ["-version"]],
  ["whisper", ["--version"]],
]) {
  const result = run(name, args);
  checks.push([name, result.ok, result.detail, name === "whisper"]);
}
const subtitles = run("ffmpeg", ["-hide_banner", "-h", "filter=subtitles"]);
checks.push(["ffmpeg subtitles filter", subtitles.ok && /Filter subtitles/i.test(subtitles.output), subtitles.detail]);
const model = join(ROOT, "models", "ggml-small.en.bin");
checks.push(["small.en model", existsSync(model), "models/ggml-small.en.bin", true]);

let failed = 0;
let optionalMissing = 0;
for (const [name, ok, detail, optional] of checks) {
  console.log(`${ok ? "PASS" : optional ? "SKIP" : "FAIL"}  ${name}: ${detail}`);
  if (!ok && optional) optionalMissing += 1;
  else if (!ok) failed += 1;
}
if (failed) {
  console.error(`\nSetup check failed (${failed}). ${setupHint()}`);
  process.exit(1);
}
console.log(optionalMissing
  ? "\nSetup check passed. Transcription is unavailable until whisper.cpp and the small.en model are installed; the synthetic tests and the demo episode do not need them."
  : "\nSetup check passed. Studio's local runtime is ready.");
