#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSocialPostKit, trackedEpisodeLink, writeSocialPostKit } from "./social_post_kit.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-social-post-kit-test-"));
const workDir = join(root, "work", "episode");
const masterPath = join(workDir, "clips", "clip_001.mp4");
mkdirSync(join(workDir, "clips"), { recursive: true });
writeFileSync(masterPath, "synthetic shared vertical master");

const input = {
  episodeId: "ep001",
  episodeTitle: "A Sample Episode About Learning in Public",
  publicEpisodeUrl: "https://example.com/podcast/a-sample-episode",
  clip: { id: "clip_001", title: "The hard part is not the tool", category: "takeaway", review: { status: "approved" } },
  renderedMasterPath: masterPath,
  caption: "Most teams do not need another AI tool. They need a workflow they will actually use.",
  hashtags: ["#ExamplePodcast", "#AtWork", "#PracticalTips"],
  coverNote: "Most teams need a workflow, not another tool.",
  generatedAt: "2026-09-07T12:00:00.000Z",
};

try {
  const kit = buildSocialPostKit(input);
  assert.equal(kit.schema, "eaol-social-packaging-v2");
  assert.deepEqual(kit.source.one_master_for, ["youtube_shorts", "instagram_reels", "tiktok"]);
  assert.match(kit.platforms.tiktok.caption, /^Most teams do not need another AI tool/);
  assert.equal(kit.platforms.tiktok.bio_link, null);
  assert.match(kit.platforms.instagram_reels.bio_link, /utm_source=instagram/);
  assert.match(kit.platforms.youtube_shorts.description, /utm_source=youtube/);
  assert.match(kit.platforms.tiktok.visible_episode_url, /utm_source=tiktok/);
  assert.equal(new Set(Object.values(kit.platforms).map((card) => card.core_copy_fingerprint)).size, 1);
  assert.equal(kit.release_slot, "day_0");
  assert.equal(kit.publication_authorized, false);
  assert.throws(() => buildSocialPostKit({ ...input, clip: { ...input.clip, review: { status: "proposed" } } }), /approve the clip/);
  assert.throws(() => trackedEpisodeLink({ destinationUrl: "http://example.com", source: "tiktok", episodeId: "ep001", clipId: "clip_001" }), /https/);
  console.log("PASS one approved media master creates distinct Shorts, Reels, and TikTok post cards");
  console.log("PASS TikTok receives its own UTM source while all cards retain the same clip content id");
  console.log("PASS post-kit generation refuses unapproved clips and non-HTTPS public destinations");

  const written = writeSocialPostKit(workDir, input);
  assert.equal(written.files.json.sha256.length, 64);
  assert.equal(written.files.markdown.sha256.length, 64);
  assert.equal(statSync(written.files.json.path).mode & 0o777, 0o600);
  assert.throws(() => writeSocialPostKit(workDir, input), /already exists/);
  console.log("PASS post kit writes local, checksum-bound artifacts and never silently overwrites a prior handoff");
} finally {
  rmSync(root, { recursive: true, force: true });
}
