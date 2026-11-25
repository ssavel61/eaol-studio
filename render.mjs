#!/usr/bin/env node
// studio — render lane (deterministic).
//
// Reads work/<slug>/clips.json (written per clip_rubric.md), validates it
// loudly against the v1 contract, then for each clip: slices + re-zeroes the
// transcript SRT to the clip window, and runs one ffmpeg pass that trims,
// center-crops to 9:16, scales to 1080x1920, burns captions, and encodes
// h264+aac — one universal file for Shorts / TikTok / Reels / X.
//
// Usage:
//   node render.mjs --run work/<slug>              # render every clip
//   node render.mjs --run work/<slug> --clip clip_001
//   node render.mjs --run work/<slug> --dry-run    # validate + slice + narrate, cut nothing
//   node render.mjs --self-test                    # offline fixture checks, no ffmpeg
//
// Caption sync note: we trim with input-side -ss/-to (frame-accurate, full
// re-encode) and burn a re-zeroed SRT. If an eyeball check ever shows drift at
// the END of a clip, the documented fallback is output-side seeking (-i first,
// then -ss/-to): slower, unambiguous.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveTool, setupHint } from "./platform_tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Some ffmpeg builds ship without libass and report "Unknown filter
// 'subtitles'". Verify the capability by name; never assume a build has a
// filter because other commands happen to run.
const FFMPEG = resolveTool("ffmpeg");
const FFPROBE = resolveTool("ffprobe");

function assertSubtitlesFilter() {
  const res = spawnSync(FFMPEG, ["-hide_banner", "-h", "filter=subtitles"], { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  if (!out.includes("Filter subtitles")) {
    fail(
      `this ffmpeg build (${FFMPEG}) has no subtitles filter — captions cannot burn.\n` +
        `Fix: ${setupHint()}`,
    );
  }
}

// --- args ---

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function fail(msg) {
  console.error(`\nVALIDATION FAILED: ${msg}`);
  process.exit(1);
}

// --- timestamps ---

const TS_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

function tsToMs(ts) {
  const m = TS_RE.exec(ts);
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
}

function msToSrtTs(ms) {
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(min, 2)}:${p(s, 2)},${p(mm, 3)}`;
}

// --- SRT parse / slice / format (pure; covered by --self-test) ---

export function parseSrt(text) {
  const cues = [];
  // Tolerate \r\n and variable blank-line separators.
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    // lines[0] = index, lines[1] = "HH:MM:SS,mmm --> HH:MM:SS,mmm"
    const tm = /^(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/.exec(lines[1]);
    if (!tm) continue;
    cues.push({
      start_ms: tsToMs(`${tm[1]}.${tm[2]}`),
      end_ms: tsToMs(`${tm[3]}.${tm[4]}`),
      lines: lines.slice(2),
    });
  }
  return cues;
}

// Keep cues overlapping [winStart, winEnd), clamp straddlers to the window
// edges (a cue must never display before 0 or past clip end), re-zero, renumber.
export function sliceSrt(cues, winStartMs, winEndMs) {
  return cues
    .filter((c) => c.end_ms > winStartMs && c.start_ms < winEndMs)
    .map((c) => ({
      start_ms: Math.max(c.start_ms, winStartMs) - winStartMs,
      end_ms: Math.min(c.end_ms, winEndMs) - winStartMs,
      lines: c.lines,
    }));
}

export function formatSrt(cues) {
  return (
    cues
      .map((c, i) => `${i + 1}\n${msToSrtTs(c.start_ms)} --> ${msToSrtTs(c.end_ms)}\n${c.lines.join("\n")}`)
      .join("\n\n") + "\n"
  );
}

// Styled ASS subtitles. The style lives INSIDE the file, so the ffmpeg filter
// is just "subtitles=clip_NNN.ass" — no force_style string, no filtergraph
// quoting/escaping to break (which the SRT+force_style route did). PlayRes matches the output frame, so Fontsize/margins are real
// output pixels. Positions implement a cross-platform safe-zone layout:
// captions bottom-center with
// MarginV=470 so their bottom edge sits ~y=1450 — nothing below y=1550 where
// every platform's bottom chrome lives; hook top-center MarginV=340 clearing
// Reels' official 269px top chrome; side margins 120px (Shorts' right rail is
// the fattest side chrome). Re-measure quarterly — these pixels rot.
//
// COLOURS ARE &HAABBGGRR — blue, green, red, the REVERSE of normal hex. Get the
// order wrong and it does not error, it just renders the wrong colour. Palette:
// slate #2c353c = &H003C352C, teal
// #8abfc5 = &H00C5BF8A, gold #f3e2ae = &H00AEE2F3, white = &H00FFFFFF.
// The hook uses the palette gold.
//
// Fontname is resolved through the system font list, NOT the vendored files in
// fonts/ — those are for tiles.mjs. Naming a font nobody has installed falls
// back silently to a default. Arial is installed on Windows and macOS.
function msToAssTs(ms) {
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${h}:${p(min, 2)}:${p(s, 2)}.${p(cs, 2)}`;
}

export function formatAss(cues, { hookOverlay = null, clipDurMs = 0 } = {}) {
  const esc = (t) => t.replace(/[{}]/g, "").trim(); // {} open libass override tags
  const eventLines = cues.map(
    (c) =>
      `Dialogue: 0,${msToAssTs(c.start_ms)},${msToAssTs(c.end_ms)},Default,,0,0,0,,${c.lines.map(esc).join("\\N")}`,
  );
  // Hook overlay: a headline pinned top-center for the whole clip (the
  // short-form packaging convention). Alignment=8 = top-center; MarginV=200px
  // keeps it clear of platform top chrome. Layer 1 draws over captions if
  // they ever overlap (they shouldn't — opposite thirds).
  if (hookOverlay) {
    eventLines.unshift(
      `Dialogue: 1,${msToAssTs(0)},${msToAssTs(clipDurMs)},Hook,,0,0,0,,${esc(hookOverlay)}`,
    );
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,120,120,470,1
Style: Hook,Arial,72,&H00AEE2F3,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,8,120,120,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${eventLines.join("\n")}
`;
}

// --- contract validation ---

const CLIP_FIELDS_V1 = new Set(["id", "start", "end", "title", "hook", "rationale", "crop_offset_px", "hook_overlay"]);
const CLIP_FIELDS_V2 = new Set([
  ...CLIP_FIELDS_V1,
  "segment_ids", "proposed_by", "proposed_at", "origin", "category", "cluster_id",
  "signals", "flags", "boundary_notes",
  "recommendation", "speaker_balance",
]);
const TOP_FIELDS = new Set(["schema", "source_slug", "selected_by", "clips"]);
// 15–90s hard bounds. The rubric prefers 25–60s; 60–90 must be earned by the idea.
const MIN_S = 15;
const MAX_S = 90;

function validateClips(doc, slug, probe) {
  for (const k of Object.keys(doc)) {
    if (!TOP_FIELDS.has(k)) fail(`unknown top-level field "${k}" in clips.json`);
  }
  if (!["eaol-clips-v1", "eaol-clips-v2"].includes(doc.schema)) {
    fail(`schema must be "eaol-clips-v1" or "eaol-clips-v2", got "${doc.schema}"`);
  }
  if (doc.source_slug !== slug) fail(`source_slug "${doc.source_slug}" != work dir slug "${slug}"`);
  if (!doc.selected_by || !String(doc.selected_by).trim()) fail(`selected_by is empty`);
  if (!Array.isArray(doc.clips) || doc.clips.length === 0) fail(`clips must be a non-empty array`);

  const durationMs = Math.round(parseFloat(probe.format.duration) * 1000);
  const video = (probe.streams || []).find((s) => s.codec_type === "video");
  if (!video) fail(`probe.json has no video stream`);

  const seen = new Set();
  for (const clip of doc.clips) {
    const where = JSON.stringify(clip);
    const allowedFields = doc.schema === "eaol-clips-v2" ? CLIP_FIELDS_V2 : CLIP_FIELDS_V1;
    for (const k of Object.keys(clip)) {
      if (!allowedFields.has(k)) fail(`unknown field "${k}" in ${where}`);
    }
    if (!/^clip_\d{3}$/.test(clip.id || "")) fail(`id must match clip_NNN: ${where}`);
    if (seen.has(clip.id)) fail(`duplicate id ${clip.id}`);
    seen.add(clip.id);
    const startMs = tsToMs(clip.start ?? "");
    const endMs = tsToMs(clip.end ?? "");
    if (startMs === null) fail(`bad start timestamp (want HH:MM:SS.mmm): ${where}`);
    if (endMs === null) fail(`bad end timestamp (want HH:MM:SS.mmm): ${where}`);
    if (endMs <= startMs) fail(`end must be after start: ${where}`);
    const durS = (endMs - startMs) / 1000;
    if (durS < MIN_S || durS > MAX_S) fail(`clip duration ${durS.toFixed(1)}s outside ${MIN_S}-${MAX_S}s: ${where}`);
    if (endMs > durationMs) fail(`end ${clip.end} past video end (${(durationMs / 1000).toFixed(1)}s): ${where}`);
    for (const field of ["title", "hook", "rationale"]) {
      if (!clip[field] || !String(clip[field]).trim()) fail(`empty ${field}: ${where}`);
    }
    const off = clip.crop_offset_px ?? 0;
    if (!Number.isInteger(off)) fail(`crop_offset_px must be an integer: ${where}`);
    if ("hook_overlay" in clip && (!clip.hook_overlay || !String(clip.hook_overlay).trim())) {
      fail(`hook_overlay present but empty (omit the field or give it text): ${where}`);
    }
    // The 9:16 crop window at full height, shifted by off, must stay in frame.
    const cropW = Math.floor((video.height * 9) / 16 / 2) * 2;
    const x = Math.round((video.width - cropW) / 2) + off;
    if (x < 0 || x + cropW > video.width) {
      fail(`crop_offset_px ${off} pushes the crop window out of frame (source ${video.width}x${video.height}, window ${cropW}px): ${where}`);
    }
  }
  return { durationMs, video };
}

// --- self-test (offline) ---

function selfTest() {
  const fx = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");
  const checks = [];

  // 1. parse -> format round-trip is byte-stable.
  const sample = fx("sample.srt");
  checks.push(["srt round-trip byte-stable", formatSrt(parseSrt(sample)) === sample]);

  // 2. slice with straddling cues at both edges matches the expected fixture.
  const sliced = formatSrt(sliceSrt(parseSrt(sample), tsToMs("00:00:02.500"), tsToMs("00:00:08.500")));
  checks.push(["slice+re-zero matches expected", sliced === fx("sample_sliced.expected.srt")]);

  // 3. contract: the valid fixture passes; every invalid fixture is rejected
  // with the right named violation. validateClips fails via process.exit, so
  // run each case in a child process.
  const probe = JSON.parse(fx("probe_sample.json"));
  const runCase = (file) => {
    const res = spawnSync(
      process.execPath,
      ["--input-type=module", "-e",
        `import { validateOnly } from ${JSON.stringify(fileURLToPath(import.meta.url))};` +
        `validateOnly(${JSON.stringify(join(HERE, "fixtures", file))});`],
      { encoding: "utf8" },
    );
    return { ok: res.status === 0, err: res.stderr };
  };
  checks.push(["clips_valid.json passes", runCase("clips_valid.json").ok]);
  checks.push(["clips_valid_v2.json passes", runCase("clips_valid_v2.json").ok]);
  const invalidCases = [
    ["clips_invalid_timestamp.json", "bad start timestamp"],
    ["clips_invalid_order.json", "end must be after start"],
    ["clips_invalid_toolong.json", "outside 15-90s"],
    ["clips_invalid_unknownfield.json", 'unknown field'],
    ["clips_invalid_croprange.json", "out of frame"],
    ["clips_invalid_dupid.json", "duplicate id"],
    ["clips_invalid_emptyhook.json", "hook_overlay present but empty"],
  ];
  for (const [file, needle] of invalidCases) {
    const res = runCase(file);
    checks.push([`${file} rejected (${needle})`, !res.ok && res.err.includes(needle)]);
  }

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  }
  if (failed) {
    console.error(`\nself-test FAILED (${failed} checks)`);
    process.exit(1);
  }
  console.log("\nself-test passed");
}

// Child-process entry for self-test contract cases: validate a clips fixture
// against fixtures/probe_sample.json and exit 0/1.
export function validateOnly(clipsPath) {
  const doc = JSON.parse(readFileSync(clipsPath, "utf8"));
  const probe = JSON.parse(readFileSync(join(HERE, "fixtures", "probe_sample.json"), "utf8"));
  validateClips(doc, doc.source_slug, probe); // slug check self-satisfied on purpose
  process.exit(0);
}

// --- render ---

function main() {
  if (flag("--self-test")) return selfTest();

  const runArg = opt("--run");
  if (!runArg) {
    console.error("Usage: node render.mjs --run work/<slug> [--clip clip_NNN] [--dry-run]");
    process.exit(1);
  }
  const workDir = existsSync(runArg) ? resolve(runArg) : join(HERE, runArg);
  if (!existsSync(workDir)) fail(`work dir not found: ${runArg}`);
  const slug = basename(workDir);
  const need = (name) => {
    const p = join(workDir, name);
    if (!existsSync(p)) fail(`missing ${p}`);
    return readFileSync(p, "utf8");
  };
  const meta = JSON.parse(need("meta.json"));
  const probe = JSON.parse(need("probe.json"));
  const doc = JSON.parse(need("clips.json"));
  const srtCues = parseSrt(need("transcript.srt"));
  if (!existsSync(meta.source)) fail(`source video not found: ${meta.source}`);

  const { video } = validateClips(doc, slug, probe);
  console.log(`Contract valid: ${doc.clips.length} clip(s), source ${video.width}x${video.height}.`);
  if (!flag("--dry-run")) assertSubtitlesFilter();

  const only = opt("--clip");
  const clips = only ? doc.clips.filter((c) => c.id === only) : doc.clips;
  if (clips.length === 0) fail(`no clip matches --clip ${only}`);

  const clipsDir = join(workDir, "clips");
  const dryRun = flag("--dry-run");
  mkdirSync(clipsDir, { recursive: true });

  for (const clip of clips) {
    const startMs = tsToMs(clip.start);
    const endMs = tsToMs(clip.end);
    const assName = `${clip.id}.ass`;
    writeFileSync(
      join(clipsDir, assName),
      formatAss(sliceSrt(srtCues, startMs, endMs), {
        hookOverlay: clip.hook_overlay ?? null,
        clipDurMs: endMs - startMs,
      }),
    );

    const cropW = Math.floor((video.height * 9) / 16 / 2) * 2;
    const off = clip.crop_offset_px ?? 0;
    const vf =
      `crop=${cropW}:ih:(iw-ow)/2+(${off}):0,` +
      `scale=1080:1920:flags=lanczos,setsar=1,` +
      `subtitles=${assName}`;
    const ffArgs = [
      "-y", "-v", "error",
      "-ss", clip.start, "-to", clip.end,
      "-i", meta.source,
      "-vf", vf,
      "-c:v", "libx264", "-profile:v", "high", "-level", "4.0",
      "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      "-movflags", "+faststart",
      `${clip.id}.mp4`,
    ];

    console.log(`\n${clip.id}  "${clip.title}"  ${clip.start} → ${clip.end}`);
    if (dryRun) {
      console.log(`  [dry-run] cwd=${clipsDir}`);
      console.log(`  [dry-run] ffmpeg ${ffArgs.map((a) => (/[\s']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
      continue;
    }
    // cwd = clips dir so the subtitles filter gets a bare relative filename —
    // no libass path escaping, no trouble with spaces in the source path
    // (which only ever appears as a spawn-array argument).
    const res = spawnSync(FFMPEG, ffArgs, { cwd: clipsDir, encoding: "utf8" });
    if (res.status !== 0) fail(`ffmpeg exited ${res.status}:\n${res.stderr}`);

    // Receipt: probe the output and enforce the MVP bar.
    const out = spawnSync(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt", "-of", "json", join(clipsDir, `${clip.id}.mp4`)],
      { encoding: "utf8" },
    );
    const oj = JSON.parse(out.stdout);
    const ov = (oj.streams || []).find((s) => s.codec_type === "video");
    const oa = (oj.streams || []).find((s) => s.codec_type === "audio");
    const outDur = parseFloat(oj.format.duration);
    const wantDur = (endMs - startMs) / 1000;
    const sizeMb = (statSync(join(clipsDir, `${clip.id}.mp4`)).size / 1e6).toFixed(1);
    console.log(
      `  receipt: ${ov?.width}x${ov?.height} ${ov?.codec_name}/${oa?.codec_name} ${ov?.pix_fmt} | ` +
        `${outDur.toFixed(2)}s (want ${wantDur.toFixed(2)}s) | ${sizeMb}MB`,
    );
    const bad =
      ov?.width !== 1080 || ov?.height !== 1920 || ov?.codec_name !== "h264" ||
      oa?.codec_name !== "aac" || Math.abs(outDur - wantDur) > 0.5 || outDur > MAX_S + 0.5;
    if (bad) fail(`output receipt violates the MVP bar for ${clip.id} (see line above)`);
  }
  console.log(dryRun ? "\n--dry-run: contract valid, SRTs sliced, nothing rendered." : `\nDone → ${clipsDir}`);
}

// Run main only when executed directly — the self-test imports this file in a
// child process to reach validateOnly() without triggering a render.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
