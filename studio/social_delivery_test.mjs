#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildSocialPostKit } from "./social_post_kit.mjs";
import {
  buildSocialPackageReview,
  buildSocialRenderReview,
  writeSocialDelivery,
} from "./social_delivery.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-social-delivery-test-"));
const workDir = join(root, "work", "demo");
mkdirSync(join(workDir, "clips"), { recursive: true });

try {
  const clips = [];
  const renderReceipts = {};
  const renderReviews = {};
  const packages = {};
  const packageReviews = {};
  for (let index = 0; index < 3; index += 1) {
    const id = `clip_${String(index + 1).padStart(3, "0")}`;
    const path = join(workDir, "clips", `${id}.mp4`);
    writeFileSync(path, `synthetic-master-${id}`);
    const stat = statSync(path);
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    const clip = { id, title: `Clip ${index + 1}`, category: "takeaway", review: { status: "approved" } };
    clips.push(clip);
    const render = {
      status: "complete",
      edit_plan_fingerprint: `plan-${index}`,
      output: { path, bytes: stat.size, modified_ms: Math.round(stat.mtimeMs), sha256 },
    };
    renderReceipts[id] = render;
    renderReviews[id] = buildSocialRenderReview({
      renderReceipt: render,
      status: "approved",
      completeWatch: true,
      checks: { opening: true, captions: true, crop: true, audio: true, ending: true },
      reviewedBy: "host_1",
    });
    const kit = buildSocialPostKit({
      episodeId: "ep001",
      episodeTitle: "A Sample Episode About Learning in Public",
      publicEpisodeUrl: "https://youtube.com/watch?v=episode1",
      clip,
      renderedMasterPath: path,
      caption: "A practical idea from the episode that stands alone.",
      hashtags: ["#ExamplePodcast", "#PracticalTips", "#AtWork"],
      coverNote: `A useful workflow lesson ${index + 1}`,
      releaseSlot: ["day_0", "day_5", "day_10"][index],
      generatedAt: "2026-09-09T12:00:00.000Z",
    });
    packages[id] = kit;
    packageReviews[id] = buildSocialPackageReview({
      kit,
      status: "approved",
      reviewedBy: "host_1",
      checks: { master: true, cover: true, core_copy: true, youtube: true, instagram: true, tiktok: true, release_slot: true },
    });
  }
  const delivery = writeSocialDelivery(workDir, {
    slug: "demo",
    episodeId: "ep001",
    episodeTitle: "A Sample Episode About Learning in Public",
    clips,
    renderReceipts,
    renderReviews,
    packages,
    packageReviews,
    generatedAt: "2026-09-09T12:10:00.000Z",
  });
  assert.equal(delivery.version, "v001");
  assert.equal(delivery.editorial_master_count, 3);
  assert.equal(delivery.destination_count, 9);
  assert.equal(delivery.publication_authorized, false);
  assert.ok(delivery.entries.every((entry) => entry.files.master.sha256 === entry.source_master_sha256));
  assert.ok(delivery.entries.every((entry) => statSync(entry.files.cover_9x16.path).size > 1_000));
  assert.ok(delivery.entries.every((entry) => statSync(entry.files.cover_3x4.path).size > 1_000));
  assert.throws(() => writeSocialDelivery(join(root, "bad"), {
    slug: "demo", episodeId: "ep001", episodeTitle: "Episode", clips: clips.slice(0, 2),
  }), /exactly three/);
  console.log("PASS one approved master per idea creates three platform-ready cards and two safe cover variants");
  console.log("PASS versioned local delivery requires three complete watches and one package approval per clip");
  console.log("PASS delivery reserves platform IDs for later metrics while authorizing no copy, upload, scheduling, or publication action");
} finally {
  rmSync(root, { recursive: true, force: true });
}
