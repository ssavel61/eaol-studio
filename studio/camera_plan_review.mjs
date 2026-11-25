import { createHash } from "node:crypto";

const SAMPLE_DEFINITIONS = [
  { id: "full_episode_two_shot", label: "Program two-shot sample", reasons: ["full_episode_side_by_side_only"] },
  { id: "host_1_sustained", label: "Sustained Host 1", reasons: ["confirmed_host_1_sustained"] },
  { id: "host_2_sustained", label: "Sustained Host 2", reasons: ["confirmed_host_2_sustained"] },
  { id: "overlap_or_rapid_exchange", label: "Overlap or rapid exchange", reasons: ["overlap_requires_two_shot", "brief_turn_or_backchannel_requires_two_shot"] },
  { id: "silence_or_uncertainty", label: "Silence or uncertainty", reasons: ["silence_or_pause_requires_two_shot", "uncertain_speaker_requires_two_shot"] },
];

function reasons(shot) {
  return [...new Set(shot?.reason_codes || (shot?.reason_code ? [shot.reason_code] : []))];
}

export function requiresRepresentativeCameraReview(assembly) {
  const shots = assembly?.program?.shots || [];
  return shots.length !== 1 || shots.some((shot) => shot.layout !== "side_by_side");
}

function contextForShot(shot, assembly) {
  const startMs = Math.max(Number(assembly.program.start_ms), Number(shot.start_ms) - 2_000);
  const endMs = Math.min(Number(assembly.program.end_ms), Math.max(Number(shot.end_ms), Number(shot.start_ms) + 5_000));
  return { start_ms: startMs, end_ms: endMs };
}

export function buildCameraPlanSamples({ assembly, cameraPlan }) {
  if (assembly?.camera_direction?.mode !== "automatic_source_bound") {
    throw new Error("apply the automatic camera plan to assembly before building review samples");
  }
  if (assembly.camera_direction.camera_plan_fingerprint !== cameraPlan?.fingerprint) {
    throw new Error("the assembly and camera plan fingerprints do not match");
  }
  const shots = assembly.program?.shots || [];
  const samples = SAMPLE_DEFINITIONS.map((definition) => {
    const shot = shots.find((item) => definition.reasons.some((reason) => reasons(item).includes(reason)));
    return shot ? {
      id: definition.id,
      label: definition.label,
      available: true,
      ...contextForShot(shot, assembly),
      focus_shot_id: shot.id,
      source_camera_plan_shot_ids: shot.source_camera_plan_shot_ids,
      reason_codes: reasons(shot),
      activity_ids: shot.activity_ids || [],
    } : {
      id: definition.id,
      label: definition.label,
      available: false,
      unavailable_reason: "This state does not occur inside the selected program.",
    };
  });
  const ctaCue = (assembly.cta_graphic?.cues || [])[0];
  const ctaShot = ctaCue
    ? shots.find((shot) => Number(ctaCue.start_ms) >= Number(shot.start_ms) && Number(ctaCue.start_ms) < Number(shot.end_ms))
    : null;
  samples.push(ctaCue && ctaShot ? {
    id: "cta_placement",
    label: "CTA camera context",
    available: true,
    start_ms: Math.max(Number(assembly.program.start_ms), Number(ctaCue.start_ms) - 2_000),
    end_ms: Math.min(Number(assembly.program.end_ms), Number(ctaCue.end_ms) + 2_000),
    focus_shot_id: ctaShot.id,
    source_camera_plan_shot_ids: ctaShot.source_camera_plan_shot_ids,
    reason_codes: reasons(ctaShot),
    activity_ids: ctaShot.activity_ids || [],
    cta_cue_id: ctaCue.id,
    cta_type: ctaCue.cta_type,
  } : {
    id: "cta_placement",
    label: "CTA camera context",
    available: false,
    unavailable_reason: "No confirmed CTA cue occurs inside the selected program.",
  });
  const fingerprint = createHash("sha256").update(JSON.stringify([
    assembly.plan_fingerprint, cameraPlan.fingerprint, samples,
  ])).digest("hex");
  return { schema: "eaol-camera-plan-samples-v1", fingerprint, samples };
}

export function buildCameraPlanReview({
  assembly,
  cameraPlan,
  sampleSet,
  status,
  checks = {},
  previewedSampleIds = [],
  notes = "",
  reviewedAt = new Date().toISOString(),
}) {
  if (!assembly || !cameraPlan || !sampleSet) throw new Error("save the current plan-bound assembly before camera review");
  if (!["pending", "approved", "rejected"].includes(status)) throw new Error("camera plan review must be pending, approved, or rejected");
  const previewed = [...new Set(previewedSampleIds.map(String))];
  const normalizedChecks = Object.fromEntries(sampleSet.samples.map((sample) => [sample.id, checks[sample.id] === true]));
  if (status === "approved") {
    const unchecked = sampleSet.samples.filter((sample) => !normalizedChecks[sample.id]);
    if (unchecked.length) throw new Error(`review every camera sample before approval: ${unchecked.map((sample) => sample.label).join(", ")}`);
    const unpreviewed = sampleSet.samples.filter((sample) => sample.available && !previewed.includes(sample.id));
    if (unpreviewed.length) throw new Error(`preview every available camera sample before approval: ${unpreviewed.map((sample) => sample.label).join(", ")}`);
  }
  return {
    schema: "eaol-camera-plan-review-v1",
    status,
    reviewed_at: reviewedAt,
    assembly_fingerprint: assembly.plan_fingerprint,
    camera_plan_fingerprint: cameraPlan.fingerprint,
    sample_set_fingerprint: sampleSet.fingerprint,
    checks: normalizedChecks,
    previewed_sample_ids: previewed,
    notes: String(notes || "").trim().slice(0, 2_000),
    proxy_authorized: status === "approved",
    full_render_authorized: false,
  };
}

export function cameraPlanReviewMatchesInputs(review, assembly, cameraPlan, sampleSet) {
  return Boolean(review && assembly && cameraPlan && sampleSet
    && review.assembly_fingerprint === assembly.plan_fingerprint
    && review.camera_plan_fingerprint === cameraPlan.fingerprint
    && review.sample_set_fingerprint === sampleSet.fingerprint);
}
