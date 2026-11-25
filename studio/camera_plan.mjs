#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { manifestSourceSignature, sourceReceiptsAreCurrent } from "./sync.mjs";
import { channelPreflightMatchesInputs } from "./channel_preflight.mjs";
import { speakerActivityMatchesInputs } from "./speaker_activity.mjs";

const FULL_EPISODE_CAMERA_MODE = "side_by_side_only_v1";

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function signaturesMatch(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function twoShot(activity, cameraIds, reasonCode) {
  return {
    start_ms: activity.start_ms,
    end_ms: activity.end_ms,
    layout: "side_by_side",
    camera_source_ids: cameraIds,
    reason_code: reasonCode,
    activity_ids: [activity.id],
    confidence: activity.confidence,
    transition_in: { type: "cut", duration_ms: 0 },
  };
}

function mergeShots(shots) {
  const merged = [];
  for (const shot of shots.filter((item) => item.end_ms > item.start_ms)) {
    const prior = merged.at(-1);
    const sameView = prior
      && prior.end_ms === shot.start_ms
      && prior.layout === shot.layout
      && prior.camera_source_id === shot.camera_source_id
      && JSON.stringify(prior.camera_source_ids || []) === JSON.stringify(shot.camera_source_ids || []);
    if (sameView) {
      prior.end_ms = shot.end_ms;
      prior.duration_ms = prior.end_ms - prior.start_ms;
      prior.activity_ids.push(...shot.activity_ids);
      prior.reason_codes = [...new Set([...(prior.reason_codes || [prior.reason_code]), shot.reason_code])];
      prior.confidence = Math.min(prior.confidence, shot.confidence);
    } else {
      merged.push({ ...shot, duration_ms: shot.end_ms - shot.start_ms });
    }
  }
  return merged.map((shot, index) => ({ id: `shot_${String(index + 1).padStart(5, "0")}`, ...shot }));
}

export function buildCameraDecisions({ speakerActivity, host1CameraId = "primary_camera", host2CameraId = "secondary_camera" }) {
  const cameraIds = [host1CameraId, host2CameraId];
  return mergeShots((speakerActivity.segments || []).map((activity) => twoShot(
    activity,
    cameraIds,
    "full_episode_side_by_side_only",
  )));
}

export function buildCameraPlan({ manifest, timeline, channelPreflight, speakerActivity, generatedAt = new Date().toISOString() }) {
  if (!sourceReceiptsAreCurrent(manifest?.sources || [])) throw new Error("source files changed after intake; run source checks again");
  if (!channelPreflightMatchesInputs(channelPreflight, manifest) || channelPreflight.status !== "passed") {
    throw new Error("the current microphone channel preflight has not passed");
  }
  if (!speakerActivityMatchesInputs(speakerActivity, manifest, timeline, channelPreflight)) {
    throw new Error("build current source-bound speaker activity before camera direction");
  }
  const cameraTracks = (timeline.tracks || []).filter((track) => track.media_kind === "video");
  const host1 = cameraTracks.find((track) => track.source_id === "primary_camera");
  const host2 = cameraTracks.find((track) => track.source_id === "secondary_camera");
  if (!host1 || !host2) throw new Error("Host 1 and Host 2 camera tracks are required for automatic camera direction");
  const shots = buildCameraDecisions({ speakerActivity, host1CameraId: host1.source_id, host2CameraId: host2.source_id });
  if (!shots.length) throw new Error("speaker activity produced no camera decisions");
  const unsafe = shots.filter((shot) => shot.layout === "isolated" && ![
    ["primary_camera", "host_1"], ["secondary_camera", "host_2"],
  ].some(([camera, state]) => shot.camera_source_id === camera
    && shot.activity_ids.every((id) => speakerActivity.segments.find((segment) => segment.id === id)?.state === state)));
  if (unsafe.length) throw new Error("camera plan safety invariant failed: an isolated shot does not match its active speaker");
  const inputSignatures = (manifest.sources || []).map(manifestSourceSignature);
  const plan = {
    schema: "eaol-camera-decision-manifest-v1",
    status: "review_required",
    generated_at: generatedAt,
    timeline_generated_at: timeline.generated_at,
    channel_preflight_fingerprint: channelPreflight.fingerprint,
    speaker_activity_fingerprint: speakerActivity.fingerprint,
    input_signatures: inputSignatures,
    policy: {
      mode: FULL_EPISODE_CAMERA_MODE,
      opening_view: "side_by_side",
      solo_views: "disabled_for_full_episode",
      strategic_solo_views: "explicit_human_editorial_choice_required",
      clip_framing: "isolated_allowed_in_clip_workflow",
      overlap: "side_by_side",
      uncertain: "side_by_side",
      silence: "side_by_side",
      brief_turn_or_backchannel: "side_by_side",
      reaction_shots: "disabled",
      conversation_transition: "cut",
    },
    safety_checks: {
      isolated_shots_match_active_speaker: unsafe.length === 0,
      overlap_never_isolated: shots.every((shot) => shot.layout !== "isolated"
        || shot.activity_ids.every((id) => !["both", "uncertain"].includes(speakerActivity.segments.find((segment) => segment.id === id)?.state))),
      straight_cuts_only: shots.every((shot) => shot.transition_in.type === "cut"),
    },
    shots,
    render_authorized: false,
    next_step: "Review the decision reasons and representative cuts. Rendering stays locked until a separate plan-bound approval exists.",
  };
  plan.fingerprint = createHash("sha256").update(JSON.stringify([
    plan.timeline_generated_at, plan.channel_preflight_fingerprint, plan.speaker_activity_fingerprint, plan.input_signatures, plan.policy, plan.shots,
  ])).digest("hex");
  return plan;
}

export function cameraPlanMatchesInputs(plan, manifest, timeline, channelPreflight, speakerActivity) {
  if (!plan || !manifest || !timeline || !channelPreflight || !speakerActivity) return false;
  return plan.timeline_generated_at === timeline.generated_at
    && plan.channel_preflight_fingerprint === channelPreflight.fingerprint
    && plan.speaker_activity_fingerprint === speakerActivity.fingerprint
    && signaturesMatch(plan.input_signatures, (manifest.sources || []).map(manifestSourceSignature));
}

function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  if (runIndex < 0 || !args[runIndex + 1]) fail("Usage: node studio/camera_plan.mjs --run work/<episode>");
  const workDir = resolve(args[runIndex + 1]);
  try {
    const plan = buildCameraPlan({
      manifest: JSON.parse(readFileSync(join(workDir, "episode.json"), "utf8")),
      timeline: JSON.parse(readFileSync(join(workDir, "timeline.json"), "utf8")),
      channelPreflight: JSON.parse(readFileSync(join(workDir, "channel_preflight.json"), "utf8")),
      speakerActivity: JSON.parse(readFileSync(join(workDir, "speaker_activity.json"), "utf8")),
    });
    writeFileSync(join(workDir, "camera_decision_manifest.json"), `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`Camera plan: ${plan.shots.length} shots · review required · render locked`);
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
