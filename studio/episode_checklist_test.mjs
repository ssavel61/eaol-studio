#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addEpisodeChecklistItem,
  checklistSummary,
  createEpisodeChecklist,
  loadEpisodeChecklist,
  saveEpisodeChecklist,
  updateEpisodeChecklistItem,
} from "./episode_checklist.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-checklist-"));
try {
  let checklist = createEpisodeChecklist({ slug: "ep001", title: "Episode 1", createdAt: "2026-08-30T12:00:00.000Z" });
  assert.ok(checklist.items.some((item) => item.id === "recording_part_count"));
  assert.ok(checklist.items.some((item) => item.id === "production_seams"));
  checklist = updateEpisodeChecklistItem(checklist, "recording_part_count", {
    status: "complete",
    notes: "Two Host 1 parts and two Host 2 parts preserved.",
  }, { updatedAt: "2026-08-30T12:05:00.000Z" });
  assert.equal(checklist.items.find((item) => item.id === "recording_part_count").completed_at, "2026-08-30T12:05:00.000Z");
  checklist = addEpisodeChecklistItem(checklist, {
    phase: "recording",
    title: "Check the new table microphone mount",
    owner: "Host 2",
  }, { id: "custom_mount", createdAt: "2026-08-30T12:06:00.000Z" });
  assert.equal(checklist.items.find((item) => item.id === "custom_mount").status, "todo");
  assert.throws(() => updateEpisodeChecklistItem(checklist, "planning_rundown", { status: "unknown" }), /checklist status/);
  saveEpisodeChecklist(root, checklist);
  const loaded = loadEpisodeChecklist(root, { slug: "ep001", title: "Episode 1" });
  assert.equal(loaded.items.find((item) => item.id === "custom_mount").owner, "Host 2");
  assert.equal(checklistSummary(loaded).complete, 1);
  console.log("PASS episode checklist preserves durable defaults and per-episode learning additions");
  console.log("PASS checklist status, notes, ownership, completion time, and summary remain editable and receipted");
} finally {
  rmSync(root, { recursive: true, force: true });
}
