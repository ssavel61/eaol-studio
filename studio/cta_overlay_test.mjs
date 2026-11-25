#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCtaOverlay } from "./cta_overlay.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-cta-overlay-test-"));
try {
  const path = join(root, "cta.png");
  const receipt = await renderCtaOverlay({
    eyebrow: "EXPLORE THE PODCAST",
    websiteLabel: "Explore AI Out Loud",
    websiteUrlLabel: "example.com/podcast",
    actions: ["like", "comment", "subscribe"],
    outputPath: path,
  });
  const png = readFileSync(path);
  assert.equal(png.readUInt32BE(16), 760);
  assert.equal(png.readUInt32BE(20), 112);
  assert.ok(receipt.bytes > 10_000);
  assert.equal(receipt.website_label, "Explore AI Out Loud");
  assert.equal(receipt.display_url, "example.com/podcast");
  assert.equal(receipt.secondary_label, "example.com/podcast");

  const youtubePath = join(root, "youtube-cta.png");
  const youtubeReceipt = await renderCtaOverlay({
    websiteLabel: "Explore AI Out Loud",
    websiteUrlLabel: "",
    secondaryLabel: "SUBSCRIBE ON YOUTUBE",
    actions: ["subscribe"],
    outputPath: youtubePath,
  });
  assert.equal(youtubeReceipt.display_url, "");
  assert.equal(youtubeReceipt.secondary_label, "SUBSCRIBE ON YOUTUBE");
  console.log("PASS CTA overlay renders its label and visible URL in the show palette");
} finally {
  rmSync(root, { recursive: true, force: true });
}
