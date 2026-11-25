#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEpisodeProxyReview,
  episodeProxyEndToEndFindings,
  episodeProxyReviewMatches,
} from "./episode_proxy_review.mjs";
import { episodeProxyAuditFingerprint } from "./episode_proxy_audit.mjs";
import { episodeProxyFingerprint } from "./episode_proxy_identity.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-proxy-review-"));
try {
  const outputPath = join(root, "episode_proxy.mp4");
  writeFileSync(outputPath, "proxy-bytes");
  const stat = statSync(outputPath);
  const proxy = {
    schema: "eaol-episode-proxy-v1",
    status: "complete",
    quality: "proxy",
    generated_at: "2026-08-30T16:00:00.000Z",
    assembly_fingerprint: "assembly-a",
    camera_plan_fingerprint: "camera-a",
    camera_plan_sample_set_fingerprint: "samples-a",
    segments: [{ type: "opening" }, { type: "program" }, { type: "closing" }],
    cta: { in_program_cue_count: 1, closing_overlay: true },
    visual_style: { side_by_side_divider: { enabled: true, width_full_px: 4, color: "#23333a" } },
    output: { path: outputPath, bytes: stat.size, modified_ms: Math.round(stat.mtimeMs) },
    checks: { dimensions: true, video_codec: true, audio_codec: true, audio: true, duration: true },
  };
  assert.deepEqual(episodeProxyEndToEndFindings(proxy), {
    opening: true,
    program: true,
    in_program_cta: true,
    closing: true,
    closing_cta: true,
    divider: true,
    camera_balance: true,
    technical_checks: true,
  });
  assert.throws(() => buildEpisodeProxyReview({ proxy, status: "approved", checks: {} }), /complete every proxy review check/);
  assert.throws(() => buildEpisodeProxyReview({
    proxy: { ...proxy, cta: { in_program_cue_count: 0, closing_overlay: true } },
    status: "approved",
    checks: Object.fromEntries(["complete_watch", "opening", "program_sync", "cta", "closing", "divider", "camera_balance"].map((name) => [name, true])),
  }), /not an end-to-end package proof/);
  const review = buildEpisodeProxyReview({
    proxy,
    status: "approved",
    checks: Object.fromEntries(["complete_watch", "opening", "program_sync", "cta", "closing", "divider", "camera_balance"].map((name) => [name, true])),
    reviewedAt: "2026-08-30T16:10:00.000Z",
  });
  assert.equal(review.full_render_authorized, true);
  assert.equal(review.review_mode, "complete_watch");
  assert.equal(review.publication_authorized, false);
  assert.equal(episodeProxyReviewMatches(review, proxy), true);
  const audit = {
    schema: "eaol-episode-proxy-audit-v1",
    status: "passed",
    generated_at: "2026-08-30T16:05:00.000Z",
    proxy_fingerprint: episodeProxyFingerprint(proxy),
    output: { ...proxy.output, sha256: "test-sha" },
    checks: { full_decode: true },
    acceptance_eligible: true,
    full_render_authorized: false,
    publication_authorized: false,
  };
  audit.fingerprint = episodeProxyAuditFingerprint(audit);
  assert.throws(() => buildEpisodeProxyReview({
    proxy,
    status: "approved",
    reviewMode: "metadata_assisted",
    checks: Object.fromEntries(["opening", "program_sync", "cta", "closing", "divider", "camera_balance"].map((name) => [name, true])),
  }), /run and pass the metadata audit/);
  const metadataReview = buildEpisodeProxyReview({
    proxy,
    audit: { ...audit, original_status: audit.status, stale: false },
    status: "approved",
    reviewMode: "metadata_assisted",
    checks: Object.fromEntries(["opening", "program_sync", "cta", "closing", "divider", "camera_balance"].map((name) => [name, true])),
  });
  assert.equal(metadataReview.review_mode, "metadata_assisted");
  assert.equal(metadataReview.checks.complete_watch, false);
  assert.equal(metadataReview.audit_fingerprint, audit.fingerprint);
  assert.equal(metadataReview.full_render_authorized, true);
  assert.equal(episodeProxyReviewMatches(metadataReview, proxy, audit), true);
  writeFileSync(outputPath, "changed-proxy-bytes");
  assert.equal(episodeProxyReviewMatches(review, proxy), false);
  console.log("PASS complete package proxy approval requires every human check and exact output binding");
  console.log("PASS metadata-assisted approval requires a current passed audit and preserves complete_watch false");
  console.log("PASS changed proxy bytes expire full-render authorization");
} finally {
  rmSync(root, { recursive: true, force: true });
}
