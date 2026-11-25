#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { win32 } from "node:path";
import { filePickerCommand, folderOpenCommand, folderPickerCommand, resolveTool, setupHint, toolCandidates } from "./platform_tools.mjs";

const root = win32.join("C:\\", "studio");
const releaseExe = win32.join(root, ".local", "whisper", "Release", "whisper-cli.exe");

assert.equal(toolCandidates("whisper", { platform: "win32", root, env: {} })[0], releaseExe);
assert.equal(resolveTool("whisper", {
  platform: "win32",
  root,
  env: {},
  exists: (candidate) => candidate === releaseExe,
}), releaseExe);
assert.equal(resolveTool("whisper", {
  platform: "win32",
  root,
  env: { EAOL_WHISPER_CLI: "D:\\tools\\whisper-cli.exe" },
  exists: (candidate) => candidate === "D:\\tools\\whisper-cli.exe",
}), "D:\\tools\\whisper-cli.exe");
assert.equal(resolveTool("ffmpeg", { platform: "win32", env: {}, exists: () => false }), "ffmpeg");
assert.equal(
  toolCandidates("ffmpeg", { platform: "darwin", env: {} })[0],
  "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
);
assert.equal(resolveTool("ffmpeg", {
  platform: "darwin",
  env: {},
  exists: (candidate) => candidate === "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
}), "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg");
assert.match(setupHint("win32"), /EAOL_WHISPER_CLI/);
assert.equal(folderOpenCommand("win32"), "explorer");
const picker = filePickerCommand("video", "win32");
assert.equal(picker.command, "powershell.exe");
assert.deepEqual(picker.args.slice(0, 3), ["-NoProfile", "-STA", "-Command"]);
assert.match(picker.args[3], /System\.Windows\.Forms\.OpenFileDialog/);
assert.match(picker.args[3], /\*\.mp4/);
const visualPicker = filePickerCommand("visual", "win32");
assert.match(visualPicker.args[3], /Visual files/);
assert.match(visualPicker.args[3], /\*\.png/);
const csvPicker = filePickerCommand("csv", "win32");
assert.match(csvPicker.args[3], /CSV files/);
assert.match(csvPicker.args[3], /\*\.csv/);
const macCsvPicker = filePickerCommand("csv", "darwin");
assert.match(macCsvPicker.args[1], /comma-separated-values-text/);
const folderPicker = folderPickerCommand("win32");
assert.equal(folderPicker.command, "powershell.exe");
assert.match(folderPicker.args[3], /FolderBrowserDialog/);

console.log("PASS Windows repo-local whisper discovery");
console.log("PASS explicit tool override");
console.log("PASS Windows PATH fallback");
console.log("PASS macOS ffmpeg-full preference");
console.log("PASS platform-specific setup hint");
console.log("PASS Windows Explorer output-folder routing");
console.log("PASS Windows native file-picker routing");
console.log("PASS Windows show-asset file-picker routing");
console.log("PASS Windows and macOS analytics CSV file-picker routing");
console.log("PASS Windows Podcast-root folder-picker routing");
