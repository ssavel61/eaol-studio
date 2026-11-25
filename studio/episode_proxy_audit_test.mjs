#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTool } from "../platform_tools.mjs";
import {
  buildEpisodeProxyAudit,
  episodeProxyAuditMatches,
  parseProxyAuditIntervals,
  proxyAuditDetectionArgs,
} from "./episode_proxy_audit.mjs";

const ffmpeg = resolveTool("ffmpeg");
const root = mkdtempSync(join(tmpdir(), "eaol-proxy-audit-test-"));
const workDir = join(root, "work", "demo");
mkdirSync(workDir, { recursive: true });

try {
  assert.match(proxyAuditDetectionArgs("proxy.mp4", "black").join(" "), /blackdetect=d=1:pix_th=0\.10/);
  assert.match(proxyAuditDetectionArgs("proxy.mp4", "freeze").join(" "), /freezedetect=n=-50dB:d=2/);
  assert.match(proxyAuditDetectionArgs("proxy.mp4", "silence").join(" "), /silencedetect=n=-50dB:d=3/);
  assert.deepEqual(parseProxyAuditIntervals("black", "black_start:1.2 black_end:2.5 black_duration:1.3", 5), [
    { start_sec: 1.2, end_sec: 2.5, duration_sec: 1.3 },
  ]);

  const outputPath = join(workDir, "episode_proxy.mp4");
  const render = spawnSync(ffmpeg, [
    "-hide_banner", "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
    outputPath,
  ], { encoding: "utf8" });
  assert.equal(render.status, 0, render.stderr);
  const stat = statSync(outputPath);
  const proxy = {
    schema: "eaol-episode-proxy-v1",
    status: "complete",
    quality: "proxy",
    generated_at: "2026-09-07T17:00:00.000Z",
    source_slug: "demo",
    assembly_fingerprint: "assembly-a",
    camera_plan_fingerprint: "camera-a",
    camera_plan_review_required: false,
    camera_plan_sample_set_fingerprint: null,
    segments: [
      { type: "opening", duration_sec: 2 },
      { type: "program", duration_sec: 2 },
      { type: "closing", duration_sec: 2 },
    ],
    timeline: {
      duration_sec: 6,
      sections: [
        { type: "opening", start_sec: 0, end_sec: 2 },
        { type: "program", start_sec: 2, end_sec: 4 },
        { type: "closing", start_sec: 4, end_sec: 6 },
      ],
    },
    cta: { in_program_cue_count: 1, closing_overlay: true },
    visual_style: { side_by_side_divider: { enabled: true } },
    audio_balance: { checks: { opening_matches_program: true, opening_true_peak: true } },
    output: {
      path: outputPath,
      bytes: stat.size,
      modified_ms: Math.round(stat.mtimeMs),
      width: 320,
      height: 180,
    },
    checks: { dimensions: true, video_codec: true, audio_codec: true, audio: true, duration: true },
  };
  writeFileSync(join(workDir, "episode_proxy.json"), `${JSON.stringify(proxy, null, 2)}\n`);
  const audit = buildEpisodeProxyAudit(workDir, { generatedAt: "2026-09-07T17:01:00.000Z" });
  assert.equal(audit.status, "passed");
  assert.equal(audit.acceptance_eligible, true);
  assert.equal(audit.checks.full_decode, true);
  assert.equal(audit.checks.av_duration_delta, true);
  assert.equal(audit.checks.opening_program_loudness, true);
  assert.equal(audit.checks.no_unexpected_program_black, true);
  assert.equal(audit.checks.no_unexpected_program_freeze, true);
  assert.equal(audit.checks.no_unexpected_program_silence, true);
  assert.equal(audit.full_render_authorized, false);
  assert.equal(audit.publication_authorized, false);
  assert.equal(episodeProxyAuditMatches(audit, proxy), true);
  assert.equal(episodeProxyAuditMatches({
    ...audit,
    original_status: audit.status,
    stale: false,
  }, {
    ...proxy,
    original_status: proxy.status,
    stale: false,
  }), true);
  writeFileSync(outputPath, "changed-proxy");
  assert.equal(episodeProxyAuditMatches(audit, proxy), false);
  console.log("PASS exact proxy metadata audit verifies decode, A/V drift, streams, timeline, CTAs, loudness, and unexpected black/freeze/silence");
  console.log("PASS runtime-only load annotations do not invalidate exact audit evidence");
  console.log("PASS metadata audit is checksum-bound and never authorizes full render or publication by itself");
} finally {
  rmSync(root, { recursive: true, force: true });
}
