#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShowPackage,
  buildShowPackageReview,
  loadShowPackageState,
  showPackageAssetsAreCurrent,
  showPackagePaths,
  showPackageReviewMatches,
} from "./show_package.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-show-package-test-"));
const visual = join(root, "show.png");
const music = join(root, "theme.wav");
const narration = join(root, "evergreen.wav");
writeFileSync(visual, "visual");
writeFileSync(music, "music");
writeFileSync(narration, "narration");

function asset(path, kind) {
  const stat = statSync(path);
  return { path, file: path.split("/").at(-1), kind, bytes: stat.size, modified_ms: Math.round(stat.mtimeMs) };
}

try {
  const showPackage = buildShowPackage({
    generatedAt: "2026-08-23T12:00:00.000Z",
    draft: {
      name: "Explore AI Out Loud",
      opening: {
        narration_mode: "episode_specific",
        visual: asset(visual, "image"),
        music: asset(music, "audio"),
      },
      closing: {
        narration_mode: "evergreen",
        visual: asset(visual, "image"),
        voiceover: asset(narration, "audio"),
        music: asset(music, "audio"),
      },
      cta_graphic: {
        website_label: "Explore AI Out Loud",
        website_url: "https://example.com/podcast",
        actions: ["like", "comment", "subscribe"],
      },
    },
  });
  assert.equal(showPackage.opening.episode_voiceover_required, true);
  assert.equal(showPackage.opening.voiceover, null);
  assert.equal(showPackage.closing.episode_voiceover_required, false);
  assert.equal(showPackage.cta_graphic.display_url, "example.com/podcast");
  assert.equal(showPackage.ready_for_approval, true);
  assert.equal(showPackageAssetsAreCurrent(showPackage), true);
  console.log("PASS show package supports reusable visuals/music with either evergreen or per-episode narration");

  const review = buildShowPackageReview({
    showPackage,
    status: "approved",
    reviewedAt: "2026-08-23T12:05:00.000Z",
  });
  assert.equal(showPackageReviewMatches(review, showPackage), true);
  assert.equal(review.episode_inheritance_authorized, true);
  assert.equal(review.publication_authorized, false);
  console.log("PASS show-package approval is separate and fingerprint-bound");

  const paths = showPackagePaths(root);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.package, `${JSON.stringify(showPackage, null, 2)}\n`);
  writeFileSync(paths.review, `${JSON.stringify(review, null, 2)}\n`);
  const loaded = loadShowPackageState(root);
  assert.equal(loaded.approved, true);
  assert.equal(loaded.storage.scope, "local_only");
  console.log("PASS approved show package loads from local-only Studio state");

  writeFileSync(music, "changed music");
  const stale = loadShowPackageState(root);
  assert.equal(stale.current, false);
  assert.equal(stale.approved, false);
  assert.equal(stale.review.status, "stale");
  console.log("PASS a changed reusable asset expires package approval");

  const incomplete = buildShowPackage({ draft: { opening: {}, closing: {} } });
  assert.equal(incomplete.ready_for_approval, false);
  assert.throws(() => buildShowPackageReview({ showPackage: incomplete, status: "approved" }), /opening visual/);
  console.log("PASS incomplete placeholder configuration can be saved but not approved");
} finally {
  rmSync(root, { recursive: true, force: true });
}
