import { createHash } from "node:crypto";
import { loadShowConfig } from "./show_config.mjs";
import { existsSync, statSync } from "node:fs";

const SCHEMA = "eaol-episode-assembly-v6";
const REVIEW_SCHEMA = "eaol-episode-assembly-review-v1";
const CAMERA_TRANSITIONS = new Set(["cut", "dissolve"]);
const CAMERA_LAYOUTS = new Set(["isolated", "side_by_side"]);
const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const CTA_ACTIONS = new Set(["like", "comment", "subscribe"]);
const DEFAULT_WEBSITE_URL = loadShowConfig().links.website;
const DEFAULT_WEBSITE_LABEL = loadShowConfig().show_name;
const DEFAULT_NEWSLETTER_LABEL = loadShowConfig().links.newsletter_name || "Newsletter";
const CTA_LEAD_MS = 250;
const CTA_TAIL_MS = 1_000;
const CTA_MIN_DISPLAY_MS = 10_000;
const DIVIDER_COLORS = new Set(["#23333a", "#0e171b", "#f3e2ae"]);

function signaturesMatch(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function assemblyTimestampToMs(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(String(value || ""));
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

export function formatAssemblyTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function assetIdentity(asset) {
  if (!asset) return null;
  return {
    path: asset.path,
    bytes: Number(asset.bytes || 0),
    modified_ms: Number(asset.modified_ms || 0),
    kind: asset.kind,
  };
}

export function assemblyAssetsAreCurrent(assembly) {
  const assets = [
    assembly?.opening?.visual,
    assembly?.opening?.voiceover,
    assembly?.opening?.music,
    assembly?.closing?.visual,
    assembly?.closing?.voiceover,
    assembly?.closing?.music,
    assembly?.cta_graphic?.asset,
    assembly?.newsletter_cta?.asset,
  ].filter(Boolean);
  return assets.every((asset) => {
    try {
      const stat = statSync(asset.path);
      return existsSync(asset.path)
        && stat.isFile()
        && stat.size === Number(asset.bytes)
        && Math.round(stat.mtimeMs) === Number(asset.modified_ms);
    } catch {
      return false;
    }
  });
}

function planFingerprint(plan) {
  const stable = {
    source_slug: plan.source_slug,
    timeline_generated_at: plan.timeline_generated_at,
    timeline_preview_reviewed_at: plan.timeline_preview_reviewed_at,
    input_signatures: plan.input_signatures,
    title: plan.title,
    naming: plan.naming,
    camera_direction: plan.camera_direction,
    show_package: plan.show_package,
    program: plan.program,
    opening: plan.opening,
    closing: plan.closing,
    cta_graphic: plan.cta_graphic,
    newsletter_cta: plan.newsletter_cta,
    visual_style: plan.visual_style,
    program_graphics: plan.program_graphics,
    output: plan.output,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function normalizeVisualStyle(value = {}) {
  const fadeInMs = Math.round(Number(value.program_fade_in_ms ?? 0));
  if (!Number.isFinite(fadeInMs) || fadeInMs < 0 || fadeInMs > 1_000) throw new Error("program fade-in must be 0-1000ms");
  const divider = value.side_by_side_divider || {};
  const color = String(divider.color || "#23333a").toLowerCase();
  if (!DIVIDER_COLORS.has(color)) throw new Error("the two-shot divider must use an approved show color");
  const widthFullPx = Math.round(Number(divider.width_full_px ?? 4));
  if (!Number.isFinite(widthFullPx) || widthFullPx < 2 || widthFullPx > 12 || widthFullPx % 2 !== 0) {
    throw new Error("the full-resolution two-shot divider must be an even width from 2 to 12 pixels");
  }
  return {
    program_fade_in_ms: fadeInMs,
    side_by_side_divider: {
      enabled: divider.enabled === true,
      width_full_px: widthFullPx,
      color,
      behavior: "static_center_separator",
    },
    camera_balance: {
      enabled: value.camera_balance?.enabled === true,
      mode: value.camera_balance?.enabled === true ? "gentle_auto_v1" : "off",
      behavior: "source_measured_hue_preserving_adjustment",
    },
    camera_framing: {
      enabled: value.camera_framing?.enabled === true,
      mode: value.camera_framing?.enabled === true ? "per_camera_manual_v1" : "off",
      sources: Object.fromEntries(["primary_camera", "secondary_camera"].map((sourceId) => {
        const source = value.camera_framing?.sources?.[sourceId] || {};
        const zoom = Number(source.zoom ?? 1);
        const horizontal = Number(source.horizontal ?? 0);
        const vertical = Number(source.vertical ?? 0);
        const temperature = Number(source.temperature ?? 0);
        if (!Number.isFinite(zoom) || zoom < 1 || zoom > 1.35) throw new Error(`${sourceId} framing zoom must be from 1.00 to 1.35`);
        if (!Number.isFinite(horizontal) || horizontal < -100 || horizontal > 100) throw new Error(`${sourceId} horizontal framing must be from -100 to 100`);
        if (!Number.isFinite(vertical) || vertical < -100 || vertical > 100) throw new Error(`${sourceId} vertical framing must be from -100 to 100`);
        if (!Number.isFinite(temperature) || temperature < -1 || temperature > 1) throw new Error(`${sourceId} temperature must be from -1 to 1`);
        return [sourceId, {
          zoom: Number(zoom.toFixed(3)),
          horizontal: Number(horizontal.toFixed(1)),
          vertical: Number(vertical.toFixed(1)),
          temperature: Number(temperature.toFixed(2)),
        }];
      })),
      behavior: "non_destructive_scale_and_crop",
    },
  };
}

function normalizeProgramGraphics(value = {}, programStartMs, programEndMs) {
  const durationMs = programEndMs - programStartMs;
  const cue = (item, index, type) => {
    const startMs = assemblyTimestampToMs(item.start_ms ?? item.start);
    const displayDurationMs = Math.round(Number(item.duration_ms ?? 6_000));
    if (startMs === null || startMs < programStartMs || startMs >= programEndMs) {
      throw new Error(`${type} ${index + 1} must begin inside the selected program`);
    }
    const maximumMs = type === "topic_bar" ? 60_000 : 12_000;
    if (!Number.isFinite(displayDurationMs) || displayDurationMs < 2_000 || displayDurationMs > maximumMs) {
      throw new Error(`${type} ${index + 1} duration must be 2-${maximumMs / 1_000} seconds`);
    }
    return {
      id: `${type}_${String(index + 1).padStart(3, "0")}`,
      start_ms: startMs,
      end_ms: Math.min(programEndMs, startMs + displayDurationMs),
      start: formatAssemblyTimestamp(startMs),
      duration_ms: Math.min(displayDurationMs, programEndMs - startMs),
    };
  };
  const lowerThirds = (value.lower_thirds || []).map((item, index) => ({
    ...cue(item, index, "lower_third"),
    host_1_name: String(item.host_1_name || "Host 1").trim().slice(0, 80) || "Host 1",
    host_2_name: String(item.host_2_name || "Host 2").trim().slice(0, 80) || "Host 2",
  }));
  const topicBars = (value.topic_bars || []).map((item, index) => ({
    ...cue(item, index, "topic_bar"),
    title: String(item.title || "").trim().slice(0, 120),
    position: String(item.position ?? "top"),
  }));
  if (topicBars.some((item) => !item.title)) throw new Error("every topic bar needs a title");
  if (topicBars.some((item) => !["top", "bottom"].includes(item.position))) throw new Error("topic-bar position must be top or bottom");
  const bottomCues = [...lowerThirds, ...topicBars.filter((item) => item.position === "bottom")].sort((a, b) => a.start_ms - b.start_ms);
  for (let index = 1; index < bottomCues.length; index++) {
    if (bottomCues[index].start_ms < bottomCues[index - 1].end_ms) throw new Error("bottom topic bars and names must not overlap");
  }
  return {
    enabled: value.enabled === true,
    lower_thirds: lowerThirds,
    topic_bars: topicBars,
    cue_count: lowerThirds.length + topicBars.length,
    duration_ms: durationMs,
    review_behavior: "exact_timestamp_queue",
  };
}

function normalizedTransition(value, shotDurationMs) {
  const type = String(value?.type || "cut");
  if (!CAMERA_TRANSITIONS.has(type)) throw new Error("camera transitions must be cut or dissolve");
  const durationMs = type === "dissolve" ? Math.round(Number(value?.duration_ms || 350)) : 0;
  if (type === "dissolve" && (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > 1_000)) {
    throw new Error("dissolve transitions must run 100–1000ms");
  }
  if (durationMs * 2 >= shotDurationMs) throw new Error("a dissolve must be shorter than half of its camera shot");
  return { type, duration_ms: durationMs };
}

function normalizeShots(shots, videoTracks, programStartMs, programEndMs) {
  const trackById = new Map(videoTracks.map((track) => [track.source_id, track]));
  const raw = Array.isArray(shots) && shots.length
    ? shots
    : [{
      start_ms: programStartMs,
      end_ms: programEndMs,
      layout: videoTracks.length >= 2 ? "side_by_side" : "isolated",
      camera_source_id: videoTracks[0]?.source_id,
    }];
  const normalized = raw.map((shot, index) => {
    const startMs = assemblyTimestampToMs(shot.start_ms ?? shot.start);
    const endMs = assemblyTimestampToMs(shot.end_ms ?? shot.end);
    if (startMs === null || endMs === null || endMs <= startMs) {
      throw new Error(`camera shot ${index + 1} needs a valid start before its end`);
    }
    const layout = String(shot.layout || "isolated");
    if (!CAMERA_LAYOUTS.has(layout)) {
      throw new Error(`camera shot ${index + 1} must use an isolated or side-by-side view`);
    }
    const cameraSourceId = String(shot.camera_source_id || videoTracks[0]?.source_id || "");
    const selectedTracks = layout === "side_by_side"
      ? videoTracks.slice(0, 2)
      : [trackById.get(cameraSourceId)].filter(Boolean);
    if (layout === "side_by_side" && selectedTracks.length < 2) {
      throw new Error(`camera shot ${index + 1} needs two current camera sources for side-by-side`);
    }
    if (!selectedTracks.length) throw new Error(`camera shot ${index + 1} does not name a current camera source`);
    for (const track of selectedTracks) {
      if (startMs < Number(track.timeline_start_ms) || endMs > Number(track.timeline_end_ms)) {
        throw new Error(`camera shot ${index + 1} extends beyond ${track.label}'s aligned coverage`);
      }
    }
    return {
      id: `shot_${String(index + 1).padStart(3, "0")}`,
      start_ms: startMs,
      end_ms: endMs,
      start: formatAssemblyTimestamp(startMs),
      end: formatAssemblyTimestamp(endMs),
      layout,
      camera_source_id: layout === "isolated" ? selectedTracks[0].source_id : null,
      camera_source_ids: selectedTracks.map((track) => track.source_id),
      camera_label: layout === "side_by_side" ? "Host 1 + Host 2 side by side" : selectedTracks[0].label,
      camera_labels: selectedTracks.map((track) => track.label),
      transition_in: normalizedTransition(index === 0 ? { type: "cut" } : shot.transition_in, endMs - startMs),
      source_camera_plan_shot_ids: [...new Set(shot.source_camera_plan_shot_ids || (shot.id ? [shot.id] : []))],
      reason_codes: [...new Set(shot.reason_codes || (shot.reason_code ? [shot.reason_code] : []))],
      activity_ids: [...new Set(shot.activity_ids || [])],
      confidence: Number.isFinite(Number(shot.confidence)) ? Number(shot.confidence) : null,
    };
  }).sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms);

  if (normalized[0].start_ms !== programStartMs || normalized.at(-1).end_ms !== programEndMs) {
    throw new Error("camera shots must cover the complete program from its start through its end");
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].end_ms !== normalized[index].start_ms) {
      throw new Error("camera shots must meet exactly with no gap or overlap");
    }
  }
  return normalized;
}

export function cameraPlanShotsForProgram(cameraPlan, programStartMs, programEndMs) {
  if (!cameraPlan?.fingerprint || !Array.isArray(cameraPlan.shots) || !cameraPlan.shots.length) {
    throw new Error("build the current automatic camera plan before applying it to assembly");
  }
  const clipped = cameraPlan.shots.flatMap((shot) => {
    const startMs = Math.max(programStartMs, Number(shot.start_ms));
    const endMs = Math.min(programEndMs, Number(shot.end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    return [{
      ...shot,
      start_ms: startMs,
      end_ms: endMs,
      source_camera_plan_shot_ids: [shot.id],
      reason_codes: shot.reason_codes || [shot.reason_code].filter(Boolean),
      transition_in: { type: "cut", duration_ms: 0 },
    }];
  });
  if (!clipped.length || clipped[0].start_ms !== programStartMs || clipped.at(-1).end_ms !== programEndMs) {
    throw new Error("the automatic camera plan does not cover the selected program");
  }
  for (let index = 1; index < clipped.length; index++) {
    if (clipped[index - 1].end_ms !== clipped[index].start_ms) {
      throw new Error("the automatic camera plan contains a gap or overlap inside the selected program");
    }
  }
  return clipped;
}

function packageSection(label, value) {
  const visual = value?.visual || null;
  const voiceover = value?.voiceover || null;
  const music = value?.music || null;
  if ((voiceover || music) && !visual) throw new Error(`${label} audio requires a ${label} visual`);
  const audioLeadMs = label === "closing" ? Math.round(Number(value?.audio_lead_ms || 0)) : 0;
  if (!Number.isFinite(audioLeadMs) || audioLeadMs < 0 || audioLeadMs > 30_000) {
    throw new Error("closing music lead must be from 0 to 30 seconds");
  }
  const trimEndMs = Math.round(Number(value?.trim_end_ms ?? 0));
  const audioGainDb = Number(value?.audio_gain_db ?? 0);
  if (!Number.isFinite(trimEndMs) || trimEndMs < 0 || trimEndMs > 10_000) throw new Error(`${label} tail trim must be 0-10 seconds`);
  if (!Number.isFinite(audioGainDb) || audioGainDb < -24 || audioGainDb > 0) throw new Error(`${label} audio gain must be -24 to 0 dB`);
  return {
    trim_end_ms: trimEndMs,
    audio_gain_db: audioGainDb,
    enabled: Boolean(visual),
    visual: assetIdentity(visual),
    voiceover: assetIdentity(voiceover),
    music: assetIdentity(music),
    duration_source: voiceover ? "voiceover" : music ? "music" : visual ? "visual" : "none",
    audio_behavior: voiceover && music
      ? "recorded voiceover with lowered background music"
      : voiceover
        ? "recorded voiceover"
        : music
          ? "selected music"
          : visual
            ? "use visual asset audio when present"
            : "none",
    audio_lead_ms: audioLeadMs,
  };
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || DEFAULT_WEBSITE_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CTA website must be a complete https URL");
  }
  if (parsed.protocol !== "https:") throw new Error("CTA website must use https");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeOptionalWebsiteUrl(value) {
  const raw = String(value || "").trim();
  return raw ? normalizeWebsiteUrl(raw) : null;
}

function visibleUrl(value) {
  return String(value || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function normalizeCtaConfiguration(value, cues) {
  const actions = [...new Set((Array.isArray(value?.actions) ? value.actions : ["like", "comment", "subscribe"])
    .map((action) => String(action || "").toLowerCase())
    .filter((action) => CTA_ACTIONS.has(action)))];
  const websiteUrl = normalizeWebsiteUrl(value?.website_url);
  const websiteLabel = String(value?.website_label || DEFAULT_WEBSITE_LABEL).trim().slice(0, 80) || DEFAULT_WEBSITE_LABEL;
  return {
    asset: assetIdentity(value?.asset),
    website_url: websiteUrl,
    website_label: websiteLabel,
    display_url: visibleUrl(websiteUrl),
    visual_destination: "youtube",
    visual_secondary_label: "SUBSCRIBE ON YOUTUBE",
    actions,
    show_during_closing: value?.show_during_closing !== false,
    manifest_fingerprint: value?.manifest_fingerprint || null,
    cue_review_updated_at: value?.cue_review_updated_at || null,
    cues,
  };
}

function normalizeNewsletterConfiguration(value, cues) {
  const websiteUrl = normalizeOptionalWebsiteUrl(value?.website_url);
  if (cues.some((cue) => cue.cta_type === "newsletter") && !websiteUrl) {
    throw new Error("add the approved newsletter short URL before using a newsletter CTA cue");
  }
  return {
    asset: assetIdentity(value?.asset),
    website_url: websiteUrl,
    website_label: String(value?.website_label || DEFAULT_NEWSLETTER_LABEL).trim().slice(0, 80) || DEFAULT_NEWSLETTER_LABEL,
    display_url: visibleUrl(websiteUrl),
    actions: ["subscribe"],
  };
}

export function episodePlatformCopy(assembly) {
  if (!assembly?.cta_graphic) throw new Error("save the CTA configuration before generating platform copy");
  const { website_url: websiteUrl, website_label: websiteLabel, actions } = assembly.cta_graphic;
  const actionText = actions.length
    ? `${actions.map((action) => action[0].toUpperCase() + action.slice(1)).join(", ")} and help more people find the show.`
    : "Help more people find the show.";
  const htmlLabel = websiteLabel.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
  return {
    schema: "eaol-episode-platform-copy-v1",
    generated_at: assembly.generated_at,
    source_slug: assembly.source_slug,
    assembly_fingerprint: assembly.plan_fingerprint,
    episode_number: assembly.naming?.episode_number || null,
    production_id: assembly.naming?.production_id || null,
    titles: assembly.naming ? {
      canonical: assembly.title,
      podcast_rss: assembly.naming.platform_titles?.podcast_rss || assembly.title,
      youtube: assembly.naming.platform_titles?.youtube || assembly.title,
      website: assembly.naming.platform_titles?.website || assembly.title,
    } : null,
    website: { label: websiteLabel, url: websiteUrl },
    podcast: { label: websiteLabel, url: websiteUrl },
    newsletter: assembly.newsletter_cta?.website_url
      ? { label: assembly.newsletter_cta.website_label, url: assembly.newsletter_cta.website_url }
      : null,
    youtube: {
      description_lines: [`Explore the podcast at ${websiteUrl}`, actionText],
      pinned_comment: `What stood out to you? Tell us below, then explore the podcast at ${websiteUrl}`,
    },
    spotify: {
      show_notes_html: `<p>Explore the podcast at <a href="${websiteUrl}">${htmlLabel}</a>.</p><p>${actionText}</p>`,
    },
    publication_authorized: false,
  };
}

export function currentCtaCues(ctaGraphicManifest, programStartMs, programEndMs) {
  return (ctaGraphicManifest?.cues || []).flatMap((cue) => {
    const spokenStartMs = assemblyTimestampToMs(cue.transcript_segment_start);
    const spokenEndMs = assemblyTimestampToMs(cue.transcript_segment_end);
    if (spokenStartMs === null || spokenEndMs === null || spokenEndMs <= programStartMs || spokenStartMs >= programEndMs) return [];
    let displayStartMs = Math.max(programStartMs, spokenStartMs - CTA_LEAD_MS);
    let displayEndMs = Math.min(programEndMs, Math.max(spokenEndMs + CTA_TAIL_MS, displayStartMs + CTA_MIN_DISPLAY_MS));
    if (displayEndMs - displayStartMs < CTA_MIN_DISPLAY_MS && programEndMs - programStartMs >= CTA_MIN_DISPLAY_MS) {
      displayStartMs = Math.max(programStartMs, displayEndMs - CTA_MIN_DISPLAY_MS);
    }
    if (displayEndMs - displayStartMs < CTA_MIN_DISPLAY_MS) {
      throw new Error(`CTA ${cue.id} needs ten seconds at full opacity inside the program`);
    }
    return [{
      id: cue.id,
      cta_type: cue.cta_type === "newsletter" ? "newsletter" : "podcast_growth",
      actions: cue.actions || [],
      spoken_start_ms: Math.max(programStartMs, spokenStartMs),
      spoken_end_ms: Math.min(programEndMs, spokenEndMs),
      start_ms: displayStartMs,
      end_ms: displayEndMs,
      display_duration_ms: displayEndMs - displayStartMs,
      start: formatAssemblyTimestamp(displayStartMs),
      end: formatAssemblyTimestamp(displayEndMs),
      matched_text: String(cue.matched_text || ""),
    }];
  });
}

export function buildEpisodeAssembly({
  slug,
  timeline,
  timelinePreviewReview,
  inputSignatures,
  ctaGraphicManifest = null,
  cameraPlan = null,
  draft = {},
  generatedAt = new Date().toISOString(),
}) {
  if (!timeline || timeline.stale) throw new Error("build the current aligned timeline before assembling the episode");
  if (!timelinePreviewReview || timelinePreviewReview.status !== "approved" || timelinePreviewReview.stale) {
    throw new Error("confirm the current aligned camera preview before assembling the episode");
  }
  const videoTracks = (timeline.tracks || []).filter((track) => track.media_kind === "video");
  if (!videoTracks.length) throw new Error("the aligned timeline has no camera track");
  const programStartMs = assemblyTimestampToMs(draft.program_start ?? draft.program?.start_ms ?? 0);
  const programEndMs = assemblyTimestampToMs(draft.program_end ?? draft.program?.end_ms ?? timeline.reference_duration_ms);
  if (programStartMs === null || programEndMs === null || programEndMs <= programStartMs) {
    throw new Error("the program needs a valid start before its end");
  }
  if (programEndMs > Number(timeline.reference_duration_ms || 0)) {
    throw new Error("the program ends after the aligned timeline");
  }
  if (programEndMs - programStartMs < 1_000) throw new Error("the program must be at least one second long");
  const applyCameraPlan = draft.apply_camera_plan === true;
  if (applyCameraPlan && draft.camera_plan_fingerprint !== cameraPlan?.fingerprint) {
    throw new Error("the selected automatic camera plan changed; apply the current plan again");
  }
  const shotInput = applyCameraPlan
    ? cameraPlanShotsForProgram(cameraPlan, programStartMs, programEndMs)
    : draft.shots;
  const shots = normalizeShots(shotInput, videoTracks, programStartMs, programEndMs);
  const opening = packageSection("opening", draft.opening);
  const closing = packageSection("closing", draft.closing);
  const cues = currentCtaCues(ctaGraphicManifest, programStartMs, programEndMs);
  const ctaGraphic = normalizeCtaConfiguration({
    ...(draft.cta_graphic || {}),
    manifest_fingerprint: ctaGraphicManifest?.transcript_fingerprint || null,
    cue_review_updated_at: ctaGraphicManifest?.cue_review_updated_at || null,
  }, cues);
  const newsletterCta = normalizeNewsletterConfiguration(draft.newsletter_cta || {}, cues);
  const visualStyle = normalizeVisualStyle(draft.visual_style || {});
  const programGraphics = normalizeProgramGraphics(draft.program_graphics || {}, programStartMs, programEndMs);
  const warnings = [];
  if (videoTracks.length > 1 && !shots.some((shot) => shot.layout === "side_by_side")) {
    warnings.push("The current view plan never shows both hosts side by side.");
  }
  if (videoTracks.length > 1 && !shots.some((shot) => shot.layout === "isolated")) {
    warnings.push("The current view plan uses only side-by-side shots. Add isolated host views if that is not intentional.");
  }
  if (cues.some((cue) => cue.cta_type !== "newsletter") && !ctaGraphic.asset) {
    warnings.push("Confirmed podcast-growth cues will use Studio's generated show graphic because no custom podcast CTA asset is attached.");
  }
  if (cues.some((cue) => cue.cta_type === "newsletter") && !newsletterCta.asset) {
    warnings.push("Confirmed newsletter cues will use Studio's generated newsletter graphic because no custom newsletter CTA asset is attached.");
  }
  if (!opening.enabled) warnings.push("No opening visual is attached.");
  if (!closing.enabled) warnings.push("No closing visual is attached.");
  if (opening.enabled && !opening.voiceover) warnings.push("The opening package has no recorded intro voiceover; its visual or music will determine the duration.");
  if (closing.enabled && !closing.voiceover) warnings.push("The closing package has no recorded outro voiceover; its visual or music will determine the duration.");
  const plan = {
    schema: SCHEMA,
    status: "review_required",
    source_slug: slug,
    generated_at: generatedAt,
    timeline_generated_at: timeline.generated_at,
    timeline_preview_reviewed_at: timelinePreviewReview.reviewed_at,
    input_signatures: [...(inputSignatures || [])],
    title: String(draft.title || slug).trim().slice(0, 160),
    naming: draft.naming?.approval_fingerprint ? {
      episode_number: Number(draft.naming.episode_number),
      production_id: String(draft.naming.production_id),
      approval_fingerprint: String(draft.naming.approval_fingerprint),
      approved_at: draft.naming.approved_at || null,
      approved_by: draft.naming.approved_by || null,
      platform_titles: { ...(draft.naming.platform_titles || {}) },
    } : null,
    show_package: draft.show_package?.fingerprint ? {
      fingerprint: String(draft.show_package.fingerprint),
      reviewed_at: draft.show_package.reviewed_at || null,
      sections: {
        opening: String(draft.show_package.sections?.opening || "episode_override"),
        closing: String(draft.show_package.sections?.closing || "episode_override"),
        cta_graphic: String(draft.show_package.sections?.cta_graphic || "episode_override"),
        newsletter_cta: String(draft.show_package.sections?.newsletter_cta || "episode_override"),
      },
      refresh_behavior: "explicit",
    } : null,
    camera_direction: applyCameraPlan ? {
      mode: "automatic_source_bound",
      camera_plan_fingerprint: cameraPlan.fingerprint,
      camera_plan_generated_at: cameraPlan.generated_at,
      policy: cameraPlan.policy,
      shot_count_before_program_trim: cameraPlan.shots.length,
      shot_count_in_program: shots.length,
      exact_internal_boundaries_preserved: true,
      render_authorized: false,
    } : {
      mode: "manual",
      camera_plan_fingerprint: null,
      render_authorized: false,
    },
    program: {
      start_ms: programStartMs,
      end_ms: programEndMs,
      start: formatAssemblyTimestamp(programStartMs),
      end: formatAssemblyTimestamp(programEndMs),
      duration_ms: programEndMs - programStartMs,
      shots,
    },
    opening,
    closing,
    cta_graphic: ctaGraphic,
    newsletter_cta: newsletterCta,
    visual_style: visualStyle,
    program_graphics: programGraphics,
    output: {
      layout: "landscape",
      width: 3840,
      height: 2160,
      frame_rate: 30,
      video_codec: "h264",
      audio_codec: "aac",
    },
    warnings,
    editable: true,
    render_authorized: false,
  };
  plan.plan_fingerprint = planFingerprint(plan);
  return plan;
}

export function episodeAssemblyMatchesInputs(
  assembly,
  timeline,
  timelinePreviewReview,
  inputSignatures,
  ctaGraphicManifest = null,
  cameraPlan = null,
  approvedShowPackageFingerprint = null,
  approvedNamingFingerprint = null,
) {
  if (!assembly || !timeline || !timelinePreviewReview || timeline.stale || timelinePreviewReview.stale) return false;
  const ctaMatches = !assembly.cta_graphic?.manifest_fingerprint
    || (assembly.cta_graphic.manifest_fingerprint === ctaGraphicManifest?.transcript_fingerprint
      && assembly.cta_graphic.cue_review_updated_at === ctaGraphicManifest?.cue_review_updated_at);
  const cameraPlanMatches = assembly.camera_direction?.mode !== "automatic_source_bound"
    || assembly.camera_direction.camera_plan_fingerprint === cameraPlan?.fingerprint;
  const showPackageMatches = !assembly.show_package?.fingerprint
    || assembly.show_package.fingerprint === approvedShowPackageFingerprint;
  const namingMatches = approvedNamingFingerprint
    ? assembly.naming?.approval_fingerprint === approvedNamingFingerprint
    : !assembly.naming?.approval_fingerprint;
  return assembly.timeline_generated_at === timeline.generated_at
    && assembly.timeline_preview_reviewed_at === timelinePreviewReview.reviewed_at
    && timelinePreviewReview.status === "approved"
    && signaturesMatch(assembly.input_signatures, inputSignatures)
    && ctaMatches
    && cameraPlanMatches
    && showPackageMatches
    && namingMatches
    && assemblyAssetsAreCurrent(assembly)
    && assembly.plan_fingerprint === planFingerprint(assembly);
}

export function buildEpisodeAssemblyReview({ assembly, status, notes = "", reviewedAt = new Date().toISOString() }) {
  if (!assembly) throw new Error("save the current episode assembly before reviewing it");
  if (!REVIEW_STATUSES.has(status)) throw new Error("episode assembly review must be pending, approved, or rejected");
  return {
    schema: REVIEW_SCHEMA,
    status,
    notes: String(notes || "").trim().slice(0, 2_000),
    reviewed_at: reviewedAt,
    plan_fingerprint: assembly.plan_fingerprint,
    render_authorized: false,
  };
}

export function episodeAssemblyReviewMatchesPlan(review, assembly) {
  return Boolean(review && assembly && review.plan_fingerprint === assembly.plan_fingerprint);
}
