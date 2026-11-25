import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EPISODE_CHECKLIST_SCHEMA = "eaol-episode-checklist-v1";
export const EPISODE_CHECKLIST_TEMPLATE_VERSION = "generic-v1";
export const CHECKLIST_STATUSES = new Set(["todo", "complete", "blocked", "not_applicable"]);
export const CHECKLIST_PHASES = ["planning", "recording", "transfer", "production", "delivery", "learning"];

const DEFAULT_ITEMS = [
  ["planning_rundown", "planning", "Approve the episode rundown", "Both", "Confirm topic, sequence, calls to action, owners, and the recording-ready version."],
  ["planning_assets", "planning", "Confirm episode-specific assets", "Host 1", "Identify artwork, links, disclosures, and any episode-specific opening or closing narration."],
  ["recording_storage", "recording", "Verify storage and power", "Both", "Confirm camera cards, microphone recorder space, batteries, and local recording are ready."],
  ["recording_microphone_settings", "recording", "Verify microphone recording settings", "Both", "48 kHz recording, one channel or file per host as set in show.config.json, and no raw-file renaming."],
  ["recording_slate", "recording", "Record the channel slate", "Both", "Capture room tone, Host 1 alone, Host 2 alone, both together, and closing room tone."],
  ["recording_start_clap", "recording", "Record the start clap", "Both", "Make the clap visible and audible on both cameras and on the microphone recording."],
  ["recording_growth_cues", "recording", "Record the audience invitations", "Both", "Choose natural moments for each spoken call to action. Say the destinations clearly; graphics are reviewed later."],
  ["recording_end_clap", "recording", "Record the ending clap", "Both", "Capture an end reference before stopping any recorder."],
  ["recording_part_count", "recording", "Count every microphone recording part", "Both", "Some recorders split long takes into several files; preserve every part from both hosts."],
  ["recording_part_edges", "recording", "Check adjacent microphone part edges", "Both", "Listen to the first and last seconds of every adjacent file pair without renaming the originals."],
  ["transfer_local_playback", "transfer", "Confirm every raw file plays locally", "Both", "Verify all camera and microphone parts are fully copied before clearing any device or card."],
  ["transfer_raw_immutable", "transfer", "Confirm raw originals are unchanged", "Host 1", "Original file names and bytes stay as recorded."],
  ["transfer_source_inventory", "transfer", "Match the source inventory", "Host 1", "Two camera roles plus all ordered Host 1 and Host 2 isolated-audio parts are present."],
  ["production_intake", "production", "Approve Studio source intake", "Host 1", "Review file roles, ordered part metadata, coverage, and blocking findings."],
  ["production_seams", "production", "Approve every split-audio seam", "Host 1", "Play uncertain seams and confirm any measured gap, overlap, or discontinuity before downstream work."],
  ["production_sync", "production", "Approve synchronization and aligned playback", "Host 1", "Confirm waveform evidence and playback near the beginning and end."],
  ["production_transcript", "production", "Correct and approve the transcript", "Host 1", "Verify wording, speaker roles, and that continuation-part timestamps remain on the episode timeline."],
  ["production_camera_restarts", "production", "Review every camera restart", "Both", "For each interruption, compare words and room tone separately from the picture. Keep each answer with its question; remove accidental pauses without clipping speech."],
  ["production_framing", "production", "Match two-shot and solo framing", "Both", "Match eye level, headroom and face size across hosts and recording parts. Check natural returns to the two-shot and balanced coverage."],
  ["production_bookends", "production", "Check the opening and closing", "Both", "Review the opening transition, music under the final speaker, the outro cut and a clean ending."],
  ["production_graphics", "production", "Review names, topics and divider", "Both", "Confirm each host's wording. Check topic meaning, legibility and safe placement at actual viewing size."],
  ["production_cta_early", "production", "Place the early call to action", "Both", "Choose a natural early moment and preview the actual graphic. Transcript detection alone does not prove a graphic was included."],
  ["production_cta_secondary", "production", "Place the secondary call to action", "Both", "Match the spoken mention, check the destination, and confirm placement in the assembled episode."],
  ["production_cta_closing", "production", "Check the closing call to action", "Both", "Preview it near the closing without covering the speaker or colliding with the outro. Record a reason if omitted."],
  ["production_proxy", "production", "Watch and approve the complete proxy", "Both", "Check opening, program sync, calls to action, divider, camera balance, closing, and the complete watch."],
  ["production_render", "production", "Watch the full local render", "Host 1", "Review the exact full-resolution output before delivery."],
  ["production_revisions", "production", "Recheck revisions and the assembled cut", "Both", "Return timestamped must-fix and optional notes against the exact review version, then check the changed result."],
  ["delivery_companions", "delivery", "Verify audio, transcript, captions and chapters", "Both", "Use the accepted final timeline. Listen to the audio file; resolve uncertain words and overlaps; check caption timing and chapter starts."],
  ["delivery_release_copy", "delivery", "Select the title and edit the show notes", "Both", "Keep proposed titles as drafts until selected. Check every link."],
  ["delivery_platform_copy", "delivery", "Check the platform descriptions", "Both", "The video title ends with the episode number; the feed title has no number. Feed HTML stays within 4,000 characters."],
  ["delivery_segment_chapters", "delivery", "Check the shared chapter set", "Both", "The first chapter starts at 00:00. Apply any recurring-segment rules set in show.config.json."],
  ["delivery_artwork_settings", "delivery", "Confirm artwork and platform settings", "Both", "Review the thumbnail, pinned comment, end screen, playlist, captions and disclosure answers."],
  ["delivery_publish", "delivery", "Record separate publication approval", "Both", "Upload and publication happen outside Studio and need their own explicit approval."],
  ["delivery_social", "delivery", "Review social clips from the exact final cut", "Both", "For each clip record selection, opening, framing, captions, sound and ending. Watch each rendered clip in full."],
  ["learning_results", "learning", "Add what you learned", "Host 1", "Record what should change for the next episode."],
  ["learning_checklist", "learning", "Update the checklist from this episode", "Both", "Add durable lessons without rewriting completed item receipts."],
].map(([id, phase, title, owner, description], order) => ({
  id,
  phase,
  title,
  owner,
  description,
  order: order + 1,
  template_item: true,
}));

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function defaultState(item) {
  return {
    ...item,
    status: "todo",
    notes: "",
    updated_at: null,
    completed_at: null,
    archived: false,
  };
}

export function createEpisodeChecklist({ slug, title = "", createdAt = new Date().toISOString() } = {}) {
  return {
    schema: EPISODE_CHECKLIST_SCHEMA,
    template_version: EPISODE_CHECKLIST_TEMPLATE_VERSION,
    source_slug: cleanText(slug, 160),
    episode_title: cleanText(title, 200),
    created_at: createdAt,
    updated_at: createdAt,
    items: DEFAULT_ITEMS.map(defaultState),
  };
}

export function mergeEpisodeChecklist(checklist, { slug, title = "" } = {}) {
  const base = checklist?.schema === EPISODE_CHECKLIST_SCHEMA
    ? { ...checklist, items: Array.isArray(checklist.items) ? checklist.items.map((item) => ({ ...item })) : [] }
    : createEpisodeChecklist({ slug, title });
  const byId = new Map(base.items.map((item) => [item.id, item]));
  for (const template of DEFAULT_ITEMS) {
    if (!byId.has(template.id)) base.items.push(defaultState(template));
    else Object.assign(byId.get(template.id), {
      title: template.title, description: template.description, phase: template.phase, order: template.order,
    });
  }
  base.template_version = EPISODE_CHECKLIST_TEMPLATE_VERSION;
  base.source_slug = cleanText(slug || base.source_slug, 160);
  base.episode_title = cleanText(title || base.episode_title, 200);
  base.items = base.items.map((item, index) => ({
    id: cleanText(item.id, 160) || `custom_${randomUUID()}`,
    phase: CHECKLIST_PHASES.includes(item.phase) ? item.phase : "learning",
    title: cleanText(item.title, 240) || "Untitled checklist item",
    description: cleanText(item.description, 2_000),
    owner: cleanText(item.owner, 100),
    status: CHECKLIST_STATUSES.has(item.status) ? item.status : "todo",
    notes: cleanText(item.notes, 4_000),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index + 1,
    template_item: item.template_item === true,
    recorded_by: cleanText(item.recorded_by, 100),
    updated_at: item.updated_at || null,
    completed_at: item.completed_at || null,
    archived: item.archived === true,
  })).sort((left, right) => CHECKLIST_PHASES.indexOf(left.phase) - CHECKLIST_PHASES.indexOf(right.phase)
    || left.order - right.order || left.title.localeCompare(right.title));
  return base;
}

export function loadEpisodeChecklist(workDir, context = {}) {
  const path = join(workDir, "episode_checklist.json");
  let value = null;
  if (existsSync(path)) {
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch { value = null; }
  }
  return mergeEpisodeChecklist(value, context);
}

export function checklistSummary(checklist) {
  const active = (checklist?.items || []).filter((item) => !item.archived && item.status !== "not_applicable");
  const complete = active.filter((item) => item.status === "complete").length;
  const blocked = active.filter((item) => item.status === "blocked").length;
  return {
    complete,
    total: active.length,
    blocked,
    percent: active.length ? Math.round(complete / active.length * 100) : 0,
  };
}

export function updateEpisodeChecklistItem(checklist, itemId, patch, { updatedAt = new Date().toISOString() } = {}) {
  const next = mergeEpisodeChecklist(checklist, { slug: checklist?.source_slug, title: checklist?.episode_title });
  const item = next.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("the episode checklist item was not found");
  if (patch.status != null) {
    if (!CHECKLIST_STATUSES.has(patch.status)) throw new Error("checklist status must be todo, complete, blocked, or not applicable");
    item.status = patch.status;
  }
  if (patch.notes != null) item.notes = cleanText(patch.notes, 4_000);
  if (patch.owner != null) item.owner = cleanText(patch.owner, 100);
  if (patch.title != null && item.template_item !== true) item.title = cleanText(patch.title, 240) || item.title;
  if (patch.description != null && item.template_item !== true) item.description = cleanText(patch.description, 2_000);
  if (patch.archived != null && item.template_item !== true) item.archived = patch.archived === true;
  item.updated_at = updatedAt;
  item.completed_at = item.status === "complete" ? item.completed_at || updatedAt : null;
  next.updated_at = updatedAt;
  return next;
}

export function addEpisodeChecklistItem(checklist, {
  title,
  phase = "learning",
  owner = "",
  description = "",
} = {}, { createdAt = new Date().toISOString(), id = `custom_${randomUUID()}` } = {}) {
  const next = mergeEpisodeChecklist(checklist, { slug: checklist?.source_slug, title: checklist?.episode_title });
  const cleanTitle = cleanText(title, 240);
  if (!cleanTitle) throw new Error("checklist item title is required");
  if (!CHECKLIST_PHASES.includes(phase)) throw new Error("choose a valid checklist phase");
  const maxOrder = Math.max(0, ...next.items.filter((item) => item.phase === phase).map((item) => Number(item.order || 0)));
  next.items.push({
    id,
    phase,
    title: cleanTitle,
    description: cleanText(description, 2_000),
    owner: cleanText(owner, 100),
    status: "todo",
    notes: "",
    order: maxOrder + 1,
    template_item: false,
    updated_at: createdAt,
    completed_at: null,
    archived: false,
  });
  next.updated_at = createdAt;
  return mergeEpisodeChecklist(next, { slug: next.source_slug, title: next.episode_title });
}

export function saveEpisodeChecklist(workDir, checklist) {
  const path = join(workDir, "episode_checklist.json");
  writeFileSync(path, `${JSON.stringify(checklist, null, 2)}\n`);
  return checklist;
}
