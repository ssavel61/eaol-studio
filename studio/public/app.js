const state = {
  episodes: [],
  episode: null,
  activeSlug: null,
  editingId: null,
  reviewingCandidateId: null,
  reviewingSocialRenderId: null,
  socialRenderCompleteWatch: false,
  packagingCandidateId: null,
  editingTranscriptSegmentId: null,
  editingChecklistItemId: null,
  transcriptSelection: null,
  pollingJobId: null,
  toastTimer: null,
  previewTimer: null,
  assemblyDraftShots: [],
  assemblyDirty: false,
  assemblyUsesCameraPlan: false,
  cameraPlanPreviewedSampleIds: new Set(),
  cameraPlanPreviewTimer: null,
  activeCameraPlanSampleId: null,
  cameraPlanPreviewPositionMs: null,
  cameraPlanChecks: {},
  showPackageState: null,
  workflowNextAction: null,
  workflowView: "focus",
  workflowBranch: "episode",
  focusedStage: null,
  recommendedStage: null,
  operator: null,
  show: null,
  bleedReviewQueuedKey: null,
  bleedReviewQueueWaitingKey: null,
  assemblyInheritance: {
    opening: false,
    closing: false,
    cta_graphic: false,
    newsletter_cta: false,
  },
};

import { renderProductionWorkflow } from './production-workflow.js';
import { renderOpeningTransitionControl } from './opening-transition.js';
import { renderClosingTransitionControl } from './closing-transition.js';
import { renderNumberedOpeningControl } from './numbered-opening.js';
import { renderRecoveryWorkspace, bindRecoveryImport } from './recovery.js';

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function summarizeEvidenceIds(ids = []) {
  return ids.length <= 4
    ? ids.join(", ") || "n/a"
    : `${ids[0]} → ${ids.at(-1)} (${ids.length} segments)`;
}

function reviewRotationStorageKey(sourceId) {
  return `eaol-review-rotation:${state.activeSlug || "episode"}:${sourceId}`;
}

function reviewRotationForSource(sourceId) {
  try {
    return ((Number(localStorage.getItem(reviewRotationStorageKey(sourceId)) || 0) % 360) + 360) % 360;
  } catch {
    return 0;
  }
}

function applyReviewRotation(video, sourceId) {
  if (!video || !sourceId) return;
  const rotation = reviewRotationForSource(sourceId);
  video.dataset.reviewSource = sourceId;
  video.classList.toggle("review-video-rotated", rotation !== 0);
  video.style.setProperty("--review-rotation", `${rotation}deg`);
  const width = Math.max(1, video.clientWidth);
  const height = Math.max(1, video.clientHeight);
  const quarterTurn = rotation % 180 !== 0;
  video.style.setProperty("--review-rotation-scale", String(quarterTurn ? Math.min(width / height, height / width) : 1));
}

function applySavedReviewRotations() {
  document.querySelectorAll("video[data-review-source]").forEach((video) => applyReviewRotation(video, video.dataset.reviewSource));
}

function updateCameraPlanRotationControls(tracks = []) {
  ["primary", "secondary"].forEach((slot, index) => {
    const button = $(`#rotate-camera-plan-${slot}-button`);
    const track = tracks[index];
    if (!button) return;
    button.classList.toggle("hidden", !track);
    button.dataset.sourceId = track?.source_id || "";
    button.textContent = track
      ? `Rotate ${track.label} clockwise${reviewRotationForSource(track.source_id) ? ` (${reviewRotationForSource(track.source_id)}°)` : ""}`
      : `Rotate camera ${index + 1} clockwise`;
  });
}

function rotateReviewSource(sourceId) {
  if (!sourceId) return;
  const rotation = (reviewRotationForSource(sourceId) + 90) % 360;
  try { localStorage.setItem(reviewRotationStorageKey(sourceId), String(rotation)); } catch {}
  document.querySelectorAll(`video[data-review-source="${CSS.escape(sourceId)}"]`).forEach((video) => applyReviewRotation(video, sourceId));
  const tracks = (state.episode?.timeline?.tracks || []).filter((track) => track.media_kind === "video").slice(0, 2);
  updateCameraPlanRotationControls(tracks);
  toast(rotation ? `Review display rotated ${rotation}°. Source media and renders are unchanged.` : "Review display returned to its original orientation.");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(message, kind = "ok") {
  const element = $("#toast");
  clearTimeout(state.toastTimer);
  element.textContent = message;
  element.className = `toast${kind === "error" ? " error" : ""}`;
  element.setAttribute("role", kind === "error" ? "alert" : "status");
  state.toastTimer = setTimeout(() => element.classList.add("hidden"), 4200);
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return "Unknown length";
  const total = Math.round(Number(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatFileBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "size unavailable";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1024; index += 1) {
    scaled /= 1024;
    unit = units[index];
  }
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${unit}`;
}

function timestampSeconds(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(value || ""));
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function assemblyTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const milliseconds = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function assemblyTimestampMs(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(String(value || ""));
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function reviewTimestampSeconds(value) {
  const parts = String(value || "").trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return 0;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

function renderEpisodeNav() {
  const list = $("#episode-list");
  if (!state.episodes.length) {
    list.innerHTML = '<p class="muted empty-nav">No episodes yet.</p>';
    return;
  }
  list.innerHTML = state.episodes.map((episode) => `
    <button class="episode-nav-item ${episode.slug === state.activeSlug ? "active" : ""}" data-slug="${escapeHtml(episode.slug)}" type="button">
      <strong>${escapeHtml(episode.display_name || episode.source_name)}</strong>
      <small>${escapeHtml(episode.workflow_status || "Sources added")} · ${formatDuration(episode.duration_sec)} · ${episode.candidate_count} clip${episode.candidate_count === 1 ? "" : "s"}</small>
      <span class="nav-count">${episode.approved_count}</span>
    </button>
  `).join("");
  list.querySelectorAll("[data-slug]").forEach((button) => {
    button.addEventListener("click", () => openEpisode(button.dataset.slug));
  });
}

async function loadEpisodes() {
  const data = await api("/api/episodes");
  state.episodes = data.episodes;
  renderEpisodeNav();
}

async function loadShowConfig() {
  const data = await api("/api/show-config");
  state.show = data.show;
  $("#show-name-eyebrow").textContent = state.show.show_name;
  for (const id of ["host_1", "host_2"]) {
    const option = $(`#social-operator-select option[value="${id}"]`);
    if (option) option.textContent = state.show.hosts[id];
  }
  return state.show;
}

function hostName(id) {
  return state.show?.hosts?.[id] || (id === "host_2" ? "Host 2" : "Host 1");
}

async function loadShowPackage() {
  state.showPackageState = await api("/api/show-package");
  return state.showPackageState;
}

function contributorLabel(value) {
  return ({ host_1: "Host 1", host_2: "Host 2", studio: "Studio" })[value] || "Legacy candidate";
}

function candidateStatusLabel(value) {
  return ({ suggested: "Suggested", proposed: "Proposed", needs_discussion: "Needs discussion", approved: "Approved", rejected: "Rejected" })[value] || "Proposed";
}

function categoryLabel(value) {
  return String(value || "Uncategorized").replaceAll("_", " ");
}

function candidateContributionReady() {
  return reviewContextReady() && Boolean(state.operator?.operator_id);
}

function candidateBody(candidate) {
  const output = candidate.output;
  const canContribute = candidateContributionReady();
  const canRender = reviewContextReady();
  const discussion = candidate.review.discussion || [];
  const renderCurrent = candidate.social_render && !candidate.social_render.stale;
  const watched = candidate.social_render_review?.status === "approved" && !candidate.social_render_review.stale;
  const packaged = candidate.social_package_review?.status === "approved" && !candidate.social_package_review.stale;
  const receipt = output?.stale || candidate.social_render?.stale
    ? '<div class="receipt stale">Prior render expired because its source, transcript, candidate instructions, or quality checks changed. Review and render this candidate again.</div>'
    : output
      ? candidate.review.status === "approved"
        ? `<div class="receipt">Rendered: ${escapeHtml(output.width)}×${escapeHtml(output.height)} · ${escapeHtml(output.video_codec)}/${escapeHtml(output.audio_codec)} · ${Number(output.duration_sec || 0).toFixed(1)}s · ${(Number(output.bytes || 0) / 1e6).toFixed(1)}MB</div>`
        : '<div class="receipt pending">Existing render found, but this candidate is not currently approved. Review it before treating the file as deliverable.</div>'
      : "";
  return `
    <article class="candidate-card ${escapeHtml(candidate.review.status)}" data-candidate-id="${escapeHtml(candidate.id)}">
      <div class="candidate-topline">
        <div>
          <span class="candidate-number">${escapeHtml(candidate.id.replace("_", " "))}</span>
          <h4>${escapeHtml(candidate.title)}</h4>
          <span class="candidate-time">${escapeHtml(candidate.start)} → ${escapeHtml(candidate.end)}</span>
        </div>
        <span class="status-badge ${escapeHtml(candidate.review.status)}">${escapeHtml(candidateStatusLabel(candidate.review.status))}</span>
      </div>
      <div class="candidate-meta">
        <span class="candidate-contributor ${escapeHtml(candidate.proposed_by || "legacy")}">${escapeHtml(contributorLabel(candidate.proposed_by))}</span>
        <span>${escapeHtml(categoryLabel(candidate.category))}</span>
        <span>${formatDuration(timestampSeconds(candidate.end) - timestampSeconds(candidate.start))}</span>
        ${candidate.segment_ids?.length ? `<span>${candidate.segment_ids.length} transcript line${candidate.segment_ids.length === 1 ? "" : "s"}</span>` : ""}
      </div>
      <p class="candidate-hook">${escapeHtml(candidate.hook_overlay || candidate.hook)}</p>
      <p class="candidate-rationale">${escapeHtml(candidate.rationale)}</p>
      ${candidate.signals?.length ? `<div class="candidate-signal-list">${candidate.signals.map((signal) => `<span>${escapeHtml(signal)}</span>`).join("")}</div>` : ""}
      ${candidate.flags?.length ? `<p class="candidate-warning"><strong>Check:</strong> ${candidate.flags.map(escapeHtml).join(" · ")}</p>` : ""}
      ${candidate.boundary_notes?.length ? `<details class="candidate-boundaries"><summary>Opening, ending, and surrounding context</summary>${candidate.boundary_notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}</details>` : ""}
      ${candidate.recommendation ? `<p class="field-help">${escapeHtml(candidate.recommendation === "recommended" ? "Studio recommendation" : "Alternate")} · ${escapeHtml((candidate.speaker_balance || []).map((speaker) => speaker === "host_1" ? "Host 1" : speaker === "host_2" ? "Host 2" : speaker).join(" + ") || "speaker evidence attached")}</p>` : ""}
      ${discussion.length ? `<div class="candidate-discussion"><strong>Discussion</strong>${discussion.map((item) => `<span><b>${escapeHtml(contributorLabel(item.by))}</b> · ${escapeHtml(item.note)}</span>`).join("")}</div>` : ""}
      <div class="candidate-actions">
        <button class="ghost-button preview-candidate" type="button">Preview</button>
        <button class="ghost-button edit-candidate" type="button" ${canContribute ? "" : 'disabled title="Choose this machine’s operator and confirm the current transcript first"'}>Edit</button>
        <button class="secondary-button review-candidate" type="button" ${canContribute ? "" : 'disabled title="Choose this machine’s operator and confirm the current transcript first"'}>Review</button>
        ${candidate.review.status === "approved" && canRender ? `<button class="primary-button render-candidate" type="button">${renderCurrent ? "Render replacement" : "Render"}</button>` : ""}
        ${renderCurrent ? `<button class="${watched ? "ghost-button" : "primary-button"} watch-social-render" type="button">${watched ? "Watched master approved" : "Watch complete render"}</button>` : ""}
        ${watched ? `<button class="${packaged ? "ghost-button" : "primary-button"} package-social-clip" type="button">${packaged ? "Package approved" : "Prepare 3-platform package"}</button>` : ""}
      </div>
      ${receipt}
    </article>
  `;
}

function reviewContextReady() {
  const episode = state.episode;
  if (!episode || episode.intake_stale || episode.intake?.compatibility?.status === "blocked") return false;
  if (!episode.transcript_review_ready) return false;
  return !["blocked", "failed", "not_run", "pending"].includes(episode.intake?.transcription?.status);
}

function renderCandidates() {
  const candidates = state.episode.candidates || [];
  renderStages();
  renderSocialWorkflow();
  const approved = candidates.filter((candidate) => candidate.review.status === "approved").length;
  const discussion = candidates.filter((candidate) => candidate.review.status === "needs_discussion").length;
  $("#candidate-summary").textContent = `${approved} approved · ${discussion} to discuss · ${candidates.length} total`;
  const list = $("#candidate-list");
  if (!candidates.length) {
    const emptyMessage = reviewContextReady()
      ? "Read the transcript, then add the first complete thought for review."
      : "Finish and confirm the current transcript review to unlock clip selection.";
    list.innerHTML = `
      <div class="empty-card">
        <strong>No candidates yet</strong>
        ${emptyMessage}
      </div>
    `;
    return;
  }
  const active = candidates.filter((candidate) => candidate.review.status !== "rejected");
  const rejected = candidates.filter((candidate) => candidate.review.status === "rejected");
  list.innerHTML = `${active.map(candidateBody).join("")}${rejected.length ? `<details class="rejected-candidates"><summary>${rejected.length} rejected idea${rejected.length === 1 ? "" : "s"} · preserved</summary>${rejected.map(candidateBody).join("")}</details>` : ""}`;
  list.querySelectorAll(".candidate-card").forEach((card) => {
    const id = card.dataset.candidateId;
    card.querySelector(".preview-candidate").addEventListener("click", () => previewCandidate(id));
    card.querySelector(".edit-candidate").addEventListener("click", () => openCandidateDialog(id));
    card.querySelector(".review-candidate").addEventListener("click", () => openCandidateReview(id));
    card.querySelector(".render-candidate")?.addEventListener("click", () => renderCandidate(id));
    card.querySelector(".watch-social-render")?.addEventListener("click", () => openSocialRenderReview(id));
    card.querySelector(".package-social-clip")?.addEventListener("click", () => openSocialPackage(id));
  });
}

function renderTranscript() {
  const cues = state.episode.transcript || [];
  const activeCues = cues.filter((cue) => !cue.dismissed_as_bleed);
  const dismissedCues = cues.filter((cue) => cue.dismissed_as_bleed);
  const speakerMode = state.episode.transcript_mode === "speaker";
  const reviewReady = state.episode.transcript_review_ready;
  const canSelect = candidateContributionReady();
  renderBleedReviewAssistant();
  $("#transcript-heading").textContent = speakerMode
    ? reviewReady ? "Speaker transcript reviewed" : "Review the speaker transcript"
    : "Choose a complete thought";
  $("#transcript-hint").textContent = speakerMode
    ? reviewReady
      ? "Review confirmed. Choose Start on the first line, then End on the last line of a complete thought."
      : "Use the Studio assistant for likely cross-mic duplicates. Review ordinary wording only when something sounds wrong, then confirm the transcript."
    : "Choose Start on the first line, then End on the last line. The clip editor opens with both times.";
  $("#transcript-count").textContent = `${activeCues.length} lines${dismissedCues.length ? ` · ${dismissedCues.length} bleed dismissed` : ""}`;
  const cueRow = (cue, index) => `
    <div class="transcript-cue ${cue.corrected ? "corrected" : ""} ${cue.dismissed_as_bleed ? "dismissed-bleed" : ""}" data-time="${escapeHtml(cue.start)}" data-index="${index}">
      <span class="cue-time">${escapeHtml(cue.start.slice(3, -4))}</span>
      <span class="cue-text">${cue.speaker_label ? `<strong class="speaker-label">${escapeHtml(cue.speaker_label)}</strong>` : ""}${escapeHtml(cue.text)}</span>
      <span class="cue-actions">
        ${speakerMode ? `<button class="edit-transcript-line" type="button" data-segment-id="${escapeHtml(cue.segment_id)}" aria-label="Review this transcript line">${cue.dismissed_as_bleed ? "Restore / review" : "Review"}</button>` : ""}
        ${reviewReady && !cue.dismissed_as_bleed ? `<button class="cue-action-cta" type="button" data-cta-segment-index="${index + 1}" aria-label="Confirm a CTA graphic cue on this transcript line" ${canSelect ? 'title="Confirm CTA graphic cue here"' : "disabled"}>CTA</button>
        <button class="cue-action-boundary" type="button" data-cue-start="${escapeHtml(cue.start)}" data-cue-text="${escapeHtml(cue.text)}" aria-label="Use as clip start" ${canSelect ? "" : "disabled"}>Start</button>
        <button class="cue-action-boundary" type="button" data-cue-end="${escapeHtml(cue.end)}" aria-label="Use as clip end" ${canSelect ? "" : "disabled"}>End</button>` : ""}
      </span>
    </div>
  `;
  $("#transcript-list").innerHTML = `${cues.map(cueRow).filter((_, index) => !cues[index].dismissed_as_bleed).join("")}${dismissedCues.length ? `<details class="rejected-candidates"><summary>${dismissedCues.length} microphone-bleed line${dismissedCues.length === 1 ? "" : "s"} dismissed · preserved</summary>${cues.map(cueRow).filter((_, index) => cues[index].dismissed_as_bleed).join("")}</details>` : ""}`;
  $("#transcript-list").querySelectorAll(".transcript-cue").forEach((row) => {
    row.addEventListener("dblclick", () => seekVideo(row.dataset.time));
  });
  $("#transcript-list").querySelectorAll("[data-segment-id]").forEach((button) => {
    button.addEventListener("click", () => openTranscriptEdit(button.dataset.segmentId));
  });
  $("#transcript-list").querySelectorAll("[data-cta-segment-index]").forEach((button) => {
    button.addEventListener("click", () => saveCtaCue({
      segmentIndex: Number(button.dataset.ctaSegmentIndex),
      status: "confirmed",
    }));
  });
  $("#transcript-list").querySelectorAll("[data-cue-start]").forEach((button) => {
    button.addEventListener("click", () => {
      state.transcriptSelection = {
        start: button.dataset.cueStart,
        hook: button.dataset.cueText,
        startIndex: Number(button.closest(".transcript-cue")?.dataset.index || 0),
      };
      toast("Clip start selected. Choose End on the transcript line where the clip should finish.");
    });
  });
  $("#transcript-list").querySelectorAll("[data-cue-end]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.transcriptSelection?.start) {
        return toast("Choose a clip Start line first.", "error");
      }
      const seed = {
        ...defaultCandidate(),
        start: state.transcriptSelection.start,
        end: button.dataset.cueEnd,
        hook: state.transcriptSelection.hook,
        segment_ids: candidateSegmentIds(state.transcriptSelection.start, button.dataset.cueEnd),
      };
      state.transcriptSelection = null;
      openCandidateDialog(null, seed);
    });
  });
}

function renderBleedReviewAssistant() {
  const root = $("#bleed-review-assistant");
  const assistant = state.episode.bleed_review_assistant;
  if (state.episode.transcript_mode !== "speaker" || !assistant) {
    state.bleedReviewQueuedKey = null;
    state.bleedReviewQueueWaitingKey = null;
    root.classList.add("hidden");
    root.innerHTML = "";
    return;
  }
  root.classList.remove("hidden");
  const pending = (assistant.pairs || []).filter((pair) => pair.status === "pending");
  if (!pending.length) {
    state.bleedReviewQueuedKey = null;
    state.bleedReviewQueueWaitingKey = null;
    root.innerHTML = `
      <div class="bleed-assistant-heading">
        <div><p class="section-kicker">Studio assistant · local</p><h4>Likely duplicate review complete</h4></div>
        <span class="status-badge approved">${Number(assistant.resolved_count || 0)} resolved</span>
      </div>
      <p class="bleed-assistant-copy">No likely cross-mic duplicate pairs remain. Nothing was dismissed automatically, and every decision remains reversible.</p>
    `;
    return;
  }
  const pair = pending[0];
  const recommended = pair.recommended_dismiss_segment_id;
  const rows = pair.segments.map((segment) => `
    <div class="bleed-assistant-line ${segment.segment_id === recommended ? "recommended-dismiss" : ""}">
      <div>
        <strong>${escapeHtml(speakerRoleDisplay(segment.speaker_id))} · ${escapeHtml(segment.start)}</strong>
        <span>${escapeHtml(segment.text)}</span>
      </div>
      <button class="ghost-button" type="button" data-bleed-dismiss="${escapeHtml(segment.segment_id)}" data-bleed-pair="${escapeHtml(pair.id)}">Dismiss this copy</button>
    </div>
  `).join("");
  const recommendation = recommended
    ? pair.segments.find((segment) => segment.segment_id === recommended)
    : null;
  root.innerHTML = `
    <div class="bleed-assistant-heading">
      <div><p class="section-kicker">Studio assistant · local</p><h4>Possible microphone bleed</h4></div>
      <span class="count-pill">${pending.length} decision${pending.length === 1 ? "" : "s"} left</span>
    </div>
    <p class="bleed-assistant-copy">${escapeHtml(pair.reason)} ${escapeHtml(pair.recommendation)}</p>
    <div class="bleed-assistant-lines">${rows}</div>
    <div class="bleed-assistant-actions">
      <button class="secondary-button" id="bleed-assistant-listen" type="button">Listen near these lines</button>
      ${recommendation ? `<button class="primary-button" id="bleed-assistant-accept" type="button" data-bleed-dismiss="${escapeHtml(recommendation.segment_id)}" data-bleed-pair="${escapeHtml(pair.id)}">Accept: dismiss ${escapeHtml(speakerRoleDisplay(recommendation.speaker_id))} copy</button>` : ""}
      <button class="ghost-button" id="bleed-assistant-keep-both" type="button" data-bleed-pair="${escapeHtml(pair.id)}">Keep both — real overlap</button>
    </div>
    <div class="bleed-assistant-role-key" aria-label="Assigned microphone roles">
      <strong>Who is who</strong>
      <span>${escapeHtml(speakerRoleDescription("host_1"))}</span>
      <span>${escapeHtml(speakerRoleDescription("host_2"))}</span>
      <small>These names come from the assigned isolated-audio files, not voice recognition.</small>
    </div>
    <small id="bleed-assistant-queue-status" class="bleed-assistant-queue-status" role="status">Queueing the local video at ${escapeHtml(bleedReviewQueueTimestamp(pair))}. Playback remains paused until you press play.</small>
    <small class="bleed-assistant-method">Evidence: transcript similarity, aligned timing, and isolated-microphone dominance. No provider is connected; Studio never dismisses a line without your click.</small>
  `;
  queueBleedReviewPair(pair);
  root.querySelector("#bleed-assistant-listen").addEventListener("click", () => {
    const earliest = Math.max(0, Math.min(...pair.segments.map((segment) => Number(segment.start_ms || 0))) - 2_000);
    seekVideo(assemblyTimestamp(earliest));
  });
  root.querySelectorAll("[data-bleed-dismiss]").forEach((button) => {
    button.addEventListener("click", () => resolveBleedReviewPair(button.dataset.bleedPair, { dismissSegmentId: button.dataset.bleedDismiss }));
  });
  root.querySelector("#bleed-assistant-keep-both").addEventListener("click", () => resolveBleedReviewPair(pair.id, { keepBoth: true }));
}

function speakerRoleName(speakerId) {
  const sourceId = `${speakerId}_audio`;
  const source = state.episode?.intake?.audio_sequences?.[sourceId]
    || state.episode?.audio_sequences?.[sourceId];
  const label = String(source?.label || "").trim();
  return label.replace(/\s+isolated\s+audio$/i, "").trim() || null;
}

function speakerRoleDisplay(speakerId) {
  const role = speakerId === "host_1" ? "Host 1" : speakerId === "host_2" ? "Host 2" : String(speakerId || "Speaker");
  const name = speakerRoleName(speakerId);
  return name && name.toLowerCase() !== role.toLowerCase() ? `${name} · ${role}` : role;
}

function speakerRoleDescription(speakerId) {
  const role = speakerId === "host_1" ? "Host 1" : speakerId === "host_2" ? "Host 2" : String(speakerId || "Speaker");
  return `${role} = ${speakerRoleName(speakerId) || "assigned audio role"}`;
}

function bleedReviewQueueStartMs(pair) {
  return Math.max(0, Math.min(...(pair?.segments || []).map((segment) => Number(segment.start_ms || 0))) - 2_000);
}

function bleedReviewQueueTimestamp(pair) {
  return assemblyTimestamp(bleedReviewQueueStartMs(pair));
}

function queueBleedReviewPair(pair) {
  const video = $("#source-video");
  const key = `${state.activeSlug || "episode"}:${pair.id}`;
  const status = $("#bleed-assistant-queue-status");
  const applyQueue = () => {
    state.bleedReviewQueueWaitingKey = null;
    const activePair = (state.episode?.bleed_review_assistant?.pairs || [])
      .find((candidate) => candidate.status === "pending");
    if (!activePair || activePair.id !== pair.id || !video.src) return;
    const target = bleedReviewQueueStartMs(pair) / 1_000;
    const boundedTarget = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(target, Math.max(0, video.duration - 0.05))
      : target;
    video.pause();
    try { video.currentTime = boundedTarget; } catch { return; }
    state.bleedReviewQueuedKey = key;
    if (status) status.textContent = `Video queued at ${bleedReviewQueueTimestamp(pair)}. Press play when you are ready.`;
  };
  if (!video.src) {
    if (status) status.textContent = "Video preview is unavailable, so this pair could not be queued.";
    return;
  }
  if (state.bleedReviewQueuedKey === key && video.readyState >= 1) return;
  if (video.readyState >= 1) return applyQueue();
  if (state.bleedReviewQueueWaitingKey === key) return;
  state.bleedReviewQueueWaitingKey = key;
  video.addEventListener("loadedmetadata", applyQueue, { once: true });
}

function ctaActionLabel(actions) {
  return (actions || []).join(" / ") || "graphic";
}

function renderCtaCues() {
  const stateCues = state.episode.cta_cues || { cues: [], detected_count: 0, confirmed_count: 0 };
  const status = $("#cta-cue-status");
  const list = $("#cta-cue-list");
  const output = $("#cta-cue-output");
  const canReview = reviewContextReady();
  const pendingCount = (stateCues.cues || []).filter((cue) => cue.status === "pending").length;

  if (stateCues.review_stale) {
    status.textContent = "Review expired";
    status.className = "status-badge stale";
  } else if (stateCues.confirmed_count) {
    status.textContent = `${stateCues.confirmed_count} confirmed${pendingCount ? ` · ${pendingCount} pending` : ""}`;
    status.className = `status-badge ${pendingCount ? "attention" : "ready"}`;
  } else if ((stateCues.cues || []).length && pendingCount === 0) {
    status.textContent = "Reviewed · no cues";
    status.className = "status-badge ready";
  } else if (stateCues.detected_count) {
    status.textContent = `${pendingCount} to review`;
    status.className = "status-badge pending";
  } else {
    status.textContent = "No automatic cues";
    status.className = "status-badge pending";
  }

  if (!(stateCues.cues || []).length) {
    list.innerHTML = `<div class="cta-cue-empty">${canReview
      ? "No CTA wording was detected. If you hear one, use G beside that transcript line to create and confirm a cue."
      : "Confirm the current transcript review before marking graphic cues."}</div>`;
  } else {
    list.innerHTML = stateCues.cues.map((cue) => `
      <article class="cta-cue-card ${escapeHtml(cue.status)}">
        <div class="cta-cue-topline">
          <div>
            <strong>${escapeHtml(cue.start)} · ${escapeHtml(cue.cta_type === "newsletter" ? "Newsletter" : "Podcast growth")} · ${escapeHtml(ctaActionLabel(cue.actions))}</strong>
            <span>${cue.source === "manual" ? "Manual transcript cue" : "Detected from spoken wording"}</span>
          </div>
          <span class="status-badge ${cue.status === "confirmed" ? "approved" : cue.status === "dismissed" ? "rejected" : "pending"}">${escapeHtml(cue.status)}</span>
        </div>
        <p>“${escapeHtml(cue.matched_text)}”</p>
        <div class="cta-cue-actions">
          <button class="ghost-button preview-cta-cue" type="button" data-cta-start="${escapeHtml(cue.start)}">Preview</button>
          <button class="primary-button confirm-podcast-cta-cue" type="button" data-cta-id="${escapeHtml(cue.id)}" ${canReview ? "" : "disabled"}>Podcast CTA</button>
          <button class="secondary-button confirm-newsletter-cta-cue" type="button" data-cta-id="${escapeHtml(cue.id)}" ${canReview ? "" : "disabled"}>Newsletter CTA</button>
          <button class="ghost-button dismiss-cta-cue" type="button" data-cta-id="${escapeHtml(cue.id)}" ${canReview ? "" : "disabled"}>Dismiss</button>
        </div>
      </article>
    `).join("");
  }

  if (stateCues.manifest_current) {
    output.innerHTML = stateCues.confirmed_count
      ? `<strong>CTA cues ready.</strong> ${escapeHtml(stateCues.cue_sheet_file)} and ${escapeHtml(stateCues.manifest_file)} are in this episode’s work folder. The full-episode renderer will use these confirmed transcript segments; watch the result for exact visual placement.`
      : `<strong>Review saved.</strong> The cue sheet currently has no confirmed in-program insertion. The separately configured closing CTA can still play over the recorded outro.`;
  } else {
    output.innerHTML = "Confirm or dismiss each cue to create the current render instructions. Nothing is composited until the full episode recipe is separately approved and rendered.";
  }

  list.querySelectorAll(".preview-cta-cue").forEach((button) => {
    button.addEventListener("click", () => seekVideo(button.dataset.ctaStart));
  });
  list.querySelectorAll(".confirm-podcast-cta-cue").forEach((button) => {
    button.addEventListener("click", () => saveCtaCue({ cueId: button.dataset.ctaId, status: "confirmed", ctaType: "podcast_growth" }));
  });
  list.querySelectorAll(".confirm-newsletter-cta-cue").forEach((button) => {
    button.addEventListener("click", () => saveCtaCue({ cueId: button.dataset.ctaId, status: "confirmed", ctaType: "newsletter" }));
  });
  list.querySelectorAll(".dismiss-cta-cue").forEach((button) => {
    button.addEventListener("click", () => saveCtaCue({ cueId: button.dataset.ctaId, status: "dismissed" }));
  });
}

function setPathValue(id, asset) {
  $(`#${id}`).value = asset?.path || "";
}

function renderShowPackageDialog() {
  const packageState = state.showPackageState || {};
  const showPackage = packageState.show_package;
  const review = packageState.review || { status: "unavailable" };
  const status = $("#show-package-status");
  status.className = `status-badge ${showPackage?.stale ? "stale" : review.status === "approved" ? "approved" : review.status === "rejected" ? "rejected" : "pending"}`;
  status.textContent = !showPackage
    ? "Not configured"
    : showPackage.stale
      ? "Assets changed"
      : review.status === "approved"
        ? "Defaults approved"
        : review.status === "rejected"
          ? "Defaults rejected"
          : "Review required";
  $("#show-package-name").value = showPackage?.name || state.show?.show_name || "";
  for (const section of ["opening", "closing"]) {
    const value = showPackage?.[section];
    $(`#show-${section}-narration-mode`).value = value?.narration_mode || "episode_specific";
    setPathValue(`show-${section}-visual`, value?.visual);
    setPathValue(`show-${section}-voiceover`, value?.voiceover);
    setPathValue(`show-${section}-music`, value?.music);
    $(`#show-${section}-voiceover-row`).classList.toggle("hidden", (value?.narration_mode || "episode_specific") !== "evergreen");
  }
  setPathValue("show-cta-asset", showPackage?.cta_graphic?.asset);
  $("#show-cta-label").value = showPackage?.cta_graphic?.website_label || state.show?.show_name || "";
  $("#show-cta-url").value = showPackage?.cta_graphic?.website_url || state.show?.links?.website || "";
  for (const action of ["like", "comment", "subscribe"]) {
    $(`#show-cta-${action}`).checked = !showPackage || (showPackage.cta_graphic?.actions || []).includes(action);
  }
  $("#show-cta-closing").checked = showPackage?.cta_graphic?.show_during_closing !== false;
  setPathValue("show-newsletter-asset", showPackage?.newsletter_cta?.asset);
  $("#show-newsletter-label").value = showPackage?.newsletter_cta?.website_label || state.show?.links?.newsletter_name || "";
  $("#show-newsletter-url").value = showPackage?.newsletter_cta?.website_url || "";
  $("#show-package-review-notes").value = review.stale ? "" : review.notes || "";
  const findings = [
    ...(showPackage?.blocking || []).map((message) => `<div class="assembly-warning">${escapeHtml(message)}</div>`),
    ...(showPackage?.warnings || []).map((message) => `<span>${escapeHtml(message)}</span>`),
  ];
  $("#show-package-findings").innerHTML = showPackage
    ? `${findings.join("") || "<strong>Package is ready for review.</strong>"}<span>Fingerprint ${escapeHtml(String(showPackage.fingerprint || "").slice(0, 12))}… · local-only configuration · publication not authorized</span>`
    : "Save the reusable graphics, music, narration policy, and CTA defaults. You can save placeholders now; approval remains blocked until both visuals are attached.";
  const previews = packageState.previews || {};
  $("#show-package-preview").innerHTML = ["opening", "closing"].map((section) => {
    const preview = previews[section];
    return preview && !preview.stale
      ? `<section class="episode-render-result"><video controls preload="metadata" src="/api/show-package/preview/${section}"></video><span>${section} preview · ${formatDuration(preview.output.duration_sec)} · ${escapeHtml(preview.output.video_codec)}/${escapeHtml(preview.output.audio_codec)}</span></section>`
      : "";
  }).join("");
  const previewsCurrent = Boolean(previews.opening && !previews.opening.stale && previews.closing && !previews.closing.stale);
  $("#approve-show-package-button").disabled = !packageState.current || !showPackage?.ready_for_approval || !previewsCurrent || review.status === "approved";
  $("#reject-show-package-button").disabled = !packageState.current;
  for (const section of ["opening", "closing"]) {
    $(`#preview-show-${section}-button`).disabled = !packageState.current || !showPackage?.[section]?.enabled;
  }
}

async function openShowPackage() {
  try {
    await loadShowPackage();
    renderShowPackageDialog();
    $("#show-package-dialog").showModal();
  } catch (error) {
    toast(error.message, "error");
  }
}

function showPackageRequestBody() {
  const section = (name) => ({
    narration_mode: $(`#show-${name}-narration-mode`).value,
    visual_path: $(`#show-${name}-visual`).value.trim(),
    voiceover_path: $(`#show-${name}-voiceover`).value.trim(),
    music_path: $(`#show-${name}-music`).value.trim(),
  });
  return {
    name: $("#show-package-name").value.trim(),
    opening: section("opening"),
    closing: section("closing"),
    cta_graphic: {
      asset_path: $("#show-cta-asset").value.trim(),
      website_label: $("#show-cta-label").value.trim(),
      website_url: $("#show-cta-url").value.trim(),
      actions: ["like", "comment", "subscribe"].filter((action) => $(`#show-cta-${action}`).checked),
      show_during_closing: $("#show-cta-closing").checked,
    },
    newsletter_cta: {
      asset_path: $("#show-newsletter-asset").value.trim(),
      website_label: $("#show-newsletter-label").value.trim(),
      website_url: $("#show-newsletter-url").value.trim(),
    },
  };
}

async function saveShowPackage() {
  try {
    state.showPackageState = await api("/api/show-package", {
      method: "PUT",
      body: JSON.stringify(showPackageRequestBody()),
    });
    renderShowPackageDialog();
    if (state.episode) renderEpisodeAssembly();
    toast("Show package saved locally. Approve it separately before episodes can inherit it.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function reviewShowPackage(status) {
  try {
    state.showPackageState = await api("/api/show-package-review", {
      method: "PUT",
      body: JSON.stringify({ status, notes: $("#show-package-review-notes").value.trim() }),
    });
    renderShowPackageDialog();
    if (state.episode) renderEpisodeAssembly();
    toast(status === "approved"
      ? "Show package approved for explicit episode inheritance. Publication remains separate."
      : "Show package rejected. Existing episode recipes remain unchanged.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function previewShowPackage(section) {
  try {
    const data = await api("/api/show-package/preview", {
      method: "POST",
      body: JSON.stringify({ section }),
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

function applyShowPackageSectionToAssembly(section) {
  const showPackage = state.showPackageState?.show_package;
  if (!showPackage) return;
  if (["opening", "closing"].includes(section)) {
    const value = showPackage[section];
    state.assemblyInheritance[section] = true;
    $(`#assembly-${section}-inherit`).checked = true;
    setPathValue(`assembly-${section}-visual`, value.visual);
    setPathValue(`assembly-${section}-music`, value.music);
    setPathValue(`assembly-${section}-voiceover`, value.narration_mode === "evergreen" ? value.voiceover : null);
    return;
  }
  if (section === "cta_graphic") {
    state.assemblyInheritance.cta_graphic = true;
    $("#assembly-cta-inherit").checked = true;
    setPathValue("assembly-cta-asset", showPackage.cta_graphic.asset);
    $("#assembly-cta-label").value = showPackage.cta_graphic.website_label;
    $("#assembly-cta-url").value = showPackage.cta_graphic.website_url;
    for (const action of ["like", "comment", "subscribe"]) {
      $(`#assembly-cta-${action}`).checked = showPackage.cta_graphic.actions.includes(action);
    }
    $("#assembly-cta-closing").checked = showPackage.cta_graphic.show_during_closing;
    return;
  }
  if (section === "newsletter_cta") {
    state.assemblyInheritance.newsletter_cta = true;
    $("#assembly-newsletter-inherit").checked = true;
    setPathValue("assembly-newsletter-asset", showPackage.newsletter_cta.asset);
    $("#assembly-newsletter-label").value = showPackage.newsletter_cta.website_label;
    $("#assembly-newsletter-url").value = showPackage.newsletter_cta.website_url || "";
  }
}

function applyShowPackageToAssembly({ markDirty = true } = {}) {
  const packageState = state.showPackageState;
  const showPackage = packageState?.show_package;
  if (!packageState?.approved || !showPackage) {
    if (markDirty) toast("Approve the current show package before using its defaults.", "error");
    return false;
  }
  for (const section of ["opening", "closing", "cta_graphic"]) applyShowPackageSectionToAssembly(section);
  const hasNewsletterDefault = Boolean(showPackage.newsletter_cta.asset || showPackage.newsletter_cta.website_url);
  if (hasNewsletterDefault) applyShowPackageSectionToAssembly("newsletter_cta");
  else {
    state.assemblyInheritance.newsletter_cta = false;
    $("#assembly-newsletter-inherit").checked = false;
  }
  updateAssemblyInheritanceControls();
  if (markDirty) {
    state.assemblyDirty = true;
    renderEpisodeAssemblyStatus();
    toast("Current approved show defaults copied into this draft. Save and approve the episode recipe separately.");
  }
  return true;
}

function toggleAssemblyInheritance(section, checked) {
  if (checked) {
    if (!state.showPackageState?.approved) {
      const checkboxId = section === "cta_graphic" ? "assembly-cta-inherit" : section === "newsletter_cta" ? "assembly-newsletter-inherit" : `assembly-${section}-inherit`;
      $(`#${checkboxId}`).checked = false;
      return toast("Approve the current show package before using this default.", "error");
    }
    applyShowPackageSectionToAssembly(section);
  } else {
    state.assemblyInheritance[section] = false;
  }
  updateAssemblyInheritanceControls();
  state.assemblyDirty = true;
  renderEpisodeAssemblyStatus();
}

function setAssemblyFieldsDisabled(ids, disabled, exceptions = new Set()) {
  ids.forEach((id) => {
    const input = $(`#${id}`);
    if (input) input.disabled = disabled && !exceptions.has(id);
    const browse = document.querySelector(`.source-browse[data-target="${id}"]`);
    if (browse) browse.disabled = disabled && !exceptions.has(id);
  });
}

function updateAssemblyInheritanceControls() {
  const showPackage = state.showPackageState?.show_package;
  for (const section of ["opening", "closing"]) {
    const inherited = state.assemblyInheritance[section];
    const voiceoverId = `assembly-${section}-voiceover`;
    const exceptions = showPackage?.[section]?.narration_mode === "episode_specific" ? new Set([voiceoverId]) : new Set();
    setAssemblyFieldsDisabled([
      `assembly-${section}-visual`,
      voiceoverId,
      `assembly-${section}-music`,
    ], inherited, exceptions);
  }
  setAssemblyFieldsDisabled([
    "assembly-cta-asset", "assembly-cta-label", "assembly-cta-url",
    "assembly-cta-like", "assembly-cta-comment", "assembly-cta-subscribe", "assembly-cta-closing",
  ], state.assemblyInheritance.cta_graphic);
  setAssemblyFieldsDisabled([
    "assembly-newsletter-asset", "assembly-newsletter-label", "assembly-newsletter-url",
  ], state.assemblyInheritance.newsletter_cta);
  $("#refresh-show-package-button").disabled = !state.showPackageState?.approved;
}

function episodeNamingNumberMatchesRequest() {
  const requested = Number(state.episode?.episode_naming?.request?.episode_number || 0);
  const entered = Number($("#episode-number").value || 0);
  return requested > 0 && requested === entered;
}

function renderEpisodeNaming() {
  const naming = state.episode?.episode_naming || {};
  const input = $("#episode-number");
  const suggested = naming.request?.episode_number || naming.suggested_episode_number || "";
  if (document.activeElement !== input) input.value = suggested;
  const numberMatches = episodeNamingNumberMatchesRequest();
  const transcriptReady = Boolean(state.episode?.transcript_review_ready && state.episode?.transcript?.length);
  const requestCurrent = Boolean(naming.request_current && numberMatches);
  const proposalCurrent = Boolean(naming.proposal_current && requestCurrent);
  const approved = Boolean(naming.approved && proposalCurrent);
  const status = $("#episode-naming-status");
  if (approved) {
    status.className = "status-badge approved";
    status.textContent = `Episode ${naming.approval.episode_number} title approved`;
  } else if (!transcriptReady) {
    status.className = "status-badge blocked";
    status.textContent = "Transcript required";
  } else if (naming.request?.stale) {
    status.className = "status-badge stale";
    status.textContent = "Request expired";
  } else if (naming.request && !numberMatches) {
    status.className = "status-badge pending";
    status.textContent = "Refresh request";
  } else if (proposalCurrent) {
    status.className = "status-badge pending";
    status.textContent = "Choose a title";
  } else if (requestCurrent) {
    status.className = "status-badge pending";
    status.textContent = "Options needed";
  } else {
    status.className = "status-badge pending";
    status.textContent = "Not started";
  }

  $("#prepare-naming-request-button").disabled = !transcriptReady || !Number(input.value);
  $("#prepare-naming-request-button").textContent = naming.request ? "Refresh naming request" : "Prepare naming request";
  $("#copy-naming-request-button").disabled = !requestCurrent;
  $("#add-human-naming-option-button").disabled = !requestCurrent;
  $("#import-naming-options-button").disabled = !requestCurrent;

  const requestReceipt = $("#episode-naming-request-receipt");
  requestReceipt.innerHTML = naming.request ? `
    <strong>${escapeHtml(naming.request.production_id)} · ${naming.request.transcript_count} approved transcript lines</strong>
    <span>Request ${escapeHtml(naming.request.request_fingerprint.slice(0, 12))}… · policy ${escapeHtml(naming.request.policy.fingerprint.slice(0, 12))}…</span>
    <span>${naming.request.stale ? "Transcript or naming policy changed. Refresh before using these options." : numberMatches ? "Ready for a human option or a separately generated structured proposal." : "The episode number changed. Refresh the request before continuing."}</span>`
    : `<span>${transcriptReady ? "Enter the confirmed episode number, then prepare the transcript-bound request." : "Confirm the transcript before naming the episode."}</span>`;

  const candidates = proposalCurrent ? naming.proposal?.candidates || [] : [];
  const approvedId = approved ? naming.approval.selected_candidate_id : null;
  $("#episode-naming-candidates").innerHTML = candidates.length ? candidates.map((candidate) => `
    <article class="episode-naming-candidate ${candidate.id === approvedId ? "approved" : ""}">
      <small>${escapeHtml(candidate.lane.replaceAll("_", " "))}${candidate.id === approvedId ? " · approved" : ""}</small>
      <h4>${escapeHtml(candidate.canonical_title)}</h4>
      <p>${escapeHtml(candidate.rationale)}</p>
      <button class="${candidate.id === approvedId ? "ghost-button" : "primary-button"} approve-episode-title" data-candidate-id="${escapeHtml(candidate.id)}" type="button" ${candidate.id === approvedId || !state.operator?.operator_id ? "disabled" : ""}>${candidate.id === approvedId ? "Approved title" : "Approve this title"}</button>
    </article>`).join("") : `<div class="cta-cue-empty">${requestCurrent ? "No title options yet. Add a human option or import structured options." : "Prepare a current naming request first."}</div>`;
  document.querySelectorAll(".approve-episode-title").forEach((button) => button.addEventListener("click", () => approveEpisodeTitle(button.dataset.candidateId)));

  $("#episode-naming-approval-receipt").innerHTML = naming.approval ? naming.approval.stale
    ? '<div class="assembly-warning">The previous title approval expired because its transcript, episode number, naming policy, or proposal changed.</div>'
    : `<strong>Approved canonical title: ${escapeHtml(naming.approval.canonical_title)}</strong>
      <span>Podcast/RSS: ${escapeHtml(naming.approval.platform_titles.podcast_rss)} · episode number metadata: ${naming.approval.episode_number}</span>
      <span>YouTube: ${escapeHtml(naming.approval.platform_titles.youtube)}</span>
      <span>Website: ${escapeHtml(naming.approval.platform_titles.website)}</span>
      <span>Approval ${escapeHtml(naming.approval.approval_fingerprint.slice(0, 12))}… · assembly, rendering, and publication remain unapproved.</span>`
    : "";
}

async function prepareEpisodeNamingRequest() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-naming/request`, {
      method: "POST",
      body: JSON.stringify({ episode_number: Number($("#episode-number").value) }),
    });
    state.episode = data.episode;
    renderEpisode();
    toast("Transcript-bound naming request prepared locally. No provider was contacted.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function copyEpisodeNamingRequest() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-naming/request`);
    await navigator.clipboard.writeText(JSON.stringify(data.request, null, 2));
    toast("Naming request copied. Sending it to a model remains your separate action.");
  } catch (error) {
    toast(`Could not copy the naming request: ${error.message}`, "error");
  }
}

async function importEpisodeNamingProposal() {
  try {
    const raw = $("#episode-naming-proposal-json").value.trim();
    if (!raw) throw new Error("paste the structured proposal JSON first");
    const proposal = JSON.parse(raw);
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-naming/proposal`, {
      method: "POST",
      body: JSON.stringify({ proposal }),
    });
    state.episode = data.episode;
    renderEpisode();
    toast("Title options validated and imported. No title is approved yet.");
  } catch (error) {
    toast(error instanceof SyntaxError ? "Proposal must be valid JSON." : error.message, "error");
  }
}

async function addHumanEpisodeNamingOption() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-naming/human-candidate`, {
      method: "POST",
      body: JSON.stringify({
        canonical_title: $("#human-naming-title").value.trim(),
        rationale: $("#human-naming-rationale").value.trim(),
      }),
    });
    state.episode = data.episode;
    $("#human-naming-title").value = "";
    $("#human-naming-rationale").value = "";
    renderEpisode();
    toast("Human title option added. Approval is still required.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function approveEpisodeTitle(candidateId) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-naming/approval`, {
      method: "PUT",
      body: JSON.stringify({ candidate_id: candidateId }),
    });
    state.episode = data.episode;
    $("#assembly-title").value = data.approval.canonical_title;
    state.assemblyDirty = Boolean(state.episode.episode_assembly);
    renderEpisode();
    toast("Numbered episode title approved. Assembly remains a separate gate.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function prepareAssemblyDraft() {
  const episode = state.episode;
  const assembly = episode?.episode_assembly;
  const timeline = episode?.timeline;
  const cameraTracks = episode?.episode_assembly_state?.camera_tracks || [];
  const defaultStart = 0;
  const defaultEnd = Number(timeline?.reference_duration_ms || 0);
  state.assemblyUsesCameraPlan = assembly?.camera_direction?.mode === "automatic_source_bound";
  state.assemblyDraftShots = assembly?.program?.shots?.length
    ? assembly.program.shots.map((shot) => ({
      start: shot.start,
      end: shot.end,
      view_mode: shot.layout === "side_by_side" ? "side_by_side" : shot.camera_source_id,
      transition_type: shot.transition_in?.type || "cut",
      source_camera_plan_shot_ids: shot.source_camera_plan_shot_ids || [],
      reason_codes: shot.reason_codes || [],
      activity_ids: shot.activity_ids || [],
      confidence: shot.confidence,
    }))
    : cameraTracks.length && defaultEnd > defaultStart
      ? [{
        start: assemblyTimestamp(defaultStart),
        end: assemblyTimestamp(defaultEnd),
        view_mode: cameraTracks.length >= 2 ? "side_by_side" : cameraTracks[0].source_id,
        transition_type: "cut",
      }]
      : [];
  $("#assembly-title").value = episode?.episode_naming?.approved
    ? episode.episode_naming.approval.canonical_title
    : assembly?.title || episode?.source_name || "";
  $("#assembly-program-start").value = assembly?.program?.start || assemblyTimestamp(defaultStart);
  $("#assembly-program-end").value = assembly?.program?.end || assemblyTimestamp(defaultEnd);
  $("#assembly-opening-visual").value = assembly?.opening?.visual?.path || "";
  $("#assembly-opening-voiceover").value = assembly?.opening?.voiceover?.path || "";
  $("#assembly-opening-music").value = assembly?.opening?.music?.path || "";
  $("#assembly-closing-visual").value = assembly?.closing?.visual?.path || "";
  $("#assembly-closing-voiceover").value = assembly?.closing?.voiceover?.path || "";
  $("#assembly-closing-music").value = assembly?.closing?.music?.path || "";
  $("#assembly-closing-audio-lead").value = String(Number(assembly?.closing?.audio_lead_ms || 0) / 1_000);
  $("#assembly-opening-trim-end").value = String(Number(assembly?.opening?.trim_end_ms || 0) / 1_000);
  $("#assembly-program-fade-in").value = String(Number(assembly?.visual_style?.program_fade_in_ms || 0) / 1_000);
  $("#assembly-closing-audio-gain").value = String(assembly?.closing?.audio_gain_db ?? 0);
  $("#assembly-cta-asset").value = assembly?.cta_graphic?.asset?.path || "";
  $("#assembly-cta-label").value = assembly?.cta_graphic?.website_label || state.show?.show_name || "";
  $("#assembly-cta-url").value = assembly?.cta_graphic?.website_url || state.show?.links?.website || "";
  for (const action of ["like", "comment", "subscribe"]) {
    $(`#assembly-cta-${action}`).checked = !assembly || (assembly.cta_graphic?.actions || []).includes(action);
  }
  $("#assembly-cta-closing").checked = assembly?.cta_graphic?.show_during_closing !== false;
  $("#assembly-newsletter-asset").value = assembly?.newsletter_cta?.asset?.path || "";
  $("#assembly-newsletter-label").value = assembly?.newsletter_cta?.website_label || state.show?.links?.newsletter_name || "";
  $("#assembly-newsletter-url").value = assembly?.newsletter_cta?.website_url || "";
  $("#assembly-divider-enabled").checked = assembly?.visual_style?.side_by_side_divider?.enabled === true;
  $("#assembly-divider-color").value = assembly?.visual_style?.side_by_side_divider?.color || "#23333a";
  $("#assembly-divider-width").value = String(assembly?.visual_style?.side_by_side_divider?.width_full_px || 4);
  $("#assembly-camera-balance-enabled").checked = assembly?.visual_style?.camera_balance?.enabled === true;
  $("#assembly-camera-framing-enabled").checked = assembly?.visual_style?.camera_framing?.enabled === true;
  $("#assembly-primary-zoom").value = String(assembly?.visual_style?.camera_framing?.sources?.primary_camera?.zoom || 1);
  $("#assembly-primary-vertical").value = String(assembly?.visual_style?.camera_framing?.sources?.primary_camera?.vertical || 0);
  $("#assembly-primary-horizontal").value = String(assembly?.visual_style?.camera_framing?.sources?.primary_camera?.horizontal || 0);
  $("#assembly-secondary-zoom").value = String(assembly?.visual_style?.camera_framing?.sources?.secondary_camera?.zoom || 1);
  $("#assembly-secondary-vertical").value = String(assembly?.visual_style?.camera_framing?.sources?.secondary_camera?.vertical || 0);
  $("#assembly-secondary-horizontal").value = String(assembly?.visual_style?.camera_framing?.sources?.secondary_camera?.horizontal || 0);
  $("#assembly-primary-temperature").value = String(assembly?.visual_style?.camera_framing?.sources?.primary_camera?.temperature || 0);
  $("#assembly-secondary-temperature").value = String(assembly?.visual_style?.camera_framing?.sources?.secondary_camera?.temperature || 0);
  $("#assembly-program-graphics-enabled").checked = assembly?.program_graphics?.enabled === true;
  $("#assembly-host-one-name").value = assembly?.program_graphics?.lower_thirds?.[0]?.host_1_name || hostName("host_1");
  $("#assembly-host-two-name").value = assembly?.program_graphics?.lower_thirds?.[0]?.host_2_name || hostName("host_2");
  $("#assembly-lower-third-times").value = (assembly?.program_graphics?.lower_thirds || []).map((cue) => `${cue.start} | ${cue.duration_ms / 1_000}`).join(", ");
  $("#assembly-topic-bars").value = (assembly?.program_graphics?.topic_bars || []).map((cue) => `${cue.start} | ${cue.title} | ${cue.duration_ms / 1_000} | ${cue.position || "top"}`).join("\n");
  const inheritedSections = assembly?.show_package?.sections || {};
  state.assemblyInheritance = {
    opening: inheritedSections.opening === "show_default",
    closing: inheritedSections.closing === "show_default",
    cta_graphic: inheritedSections.cta_graphic === "show_default",
    newsletter_cta: inheritedSections.newsletter_cta === "show_default",
  };
  $("#assembly-opening-inherit").checked = state.assemblyInheritance.opening;
  $("#assembly-closing-inherit").checked = state.assemblyInheritance.closing;
  $("#assembly-cta-inherit").checked = state.assemblyInheritance.cta_graphic;
  $("#assembly-newsletter-inherit").checked = state.assemblyInheritance.newsletter_cta;
  if (!assembly) applyShowPackageToAssembly({ markDirty: false });
  else updateAssemblyInheritanceControls();
  state.assemblyDirty = false;
  state.cameraPlanPreviewedSampleIds = new Set(episode?.camera_plan_review?.stale
    ? []
    : episode?.camera_plan_review?.previewed_sample_ids || []);
  state.activeCameraPlanSampleId = null;
  state.cameraPlanPreviewPositionMs = null;
  state.cameraPlanChecks = episode?.camera_plan_review?.stale ? {} : { ...(episode?.camera_plan_review?.checks || {}) };
  for (const id of ["camera-plan-preview-primary", "camera-plan-preview-secondary"]) {
    const video = $(`#${id}`);
    if (video) video.removeAttribute("src");
  }
}

function markAssemblyDirty() {
  state.assemblyDirty = true;
  renderEpisodeAssembly();
}

function removeAssemblyShot(index) {
  if (state.assemblyDraftShots.length <= 1) return;
  const removed = state.assemblyDraftShots[index];
  if (index > 0) state.assemblyDraftShots[index - 1].end = removed.end;
  else state.assemblyDraftShots[index + 1].start = removed.start;
  state.assemblyDraftShots.splice(index, 1);
  markAssemblyDirty();
}

function splitLongestAssemblyShot() {
  if (!state.assemblyDraftShots.length) return;
  const cameraTracks = state.episode?.episode_assembly_state?.camera_tracks || [];
  let targetIndex = 0;
  let targetDuration = -1;
  state.assemblyDraftShots.forEach((shot, index) => {
    const start = assemblyTimestampMs(shot.start);
    const end = assemblyTimestampMs(shot.end);
    const duration = start === null || end === null ? -1 : end - start;
    if (duration > targetDuration) {
      targetIndex = index;
      targetDuration = duration;
    }
  });
  if (targetDuration < 2_000) return toast("A camera shot must be at least two seconds before it can be split.", "error");
  const shot = state.assemblyDraftShots[targetIndex];
  const start = assemblyTimestampMs(shot.start);
  const end = assemblyTimestampMs(shot.end);
  const midpoint = Math.round((start + end) / 2 / 10) * 10;
  const originalView = shot.view_mode;
  const alternateView = originalView === "side_by_side"
    ? cameraTracks[0]?.source_id
    : cameraTracks.length >= 2
      ? "side_by_side"
      : originalView;
  const second = {
    start: assemblyTimestamp(midpoint),
    end: shot.end,
    view_mode: alternateView,
    transition_type: alternateView !== originalView ? "dissolve" : "cut",
  };
  shot.end = assemblyTimestamp(midpoint);
  state.assemblyDraftShots.splice(targetIndex + 1, 0, second);
  markAssemblyDirty();
}

function renderAssemblyShotList() {
  const list = $("#assembly-shot-list");
  const cameraTracks = state.episode?.episode_assembly_state?.camera_tracks || [];
  if (!state.assemblyDraftShots.length) {
    list.innerHTML = '<div class="cta-cue-empty">Confirm the aligned camera preview to create the first full-program camera shot.</div>';
    return;
  }
  list.innerHTML = state.assemblyDraftShots.map((shot, index) => state.assemblyUsesCameraPlan ? `
    <div class="assembly-shot-row automatic" data-assembly-shot="${index}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <input value="${escapeHtml(shot.start)}" aria-label="Camera shot ${index + 1} start" readonly />
      <input value="${escapeHtml(shot.end)}" aria-label="Camera shot ${index + 1} end" readonly />
      <strong>${escapeHtml(shot.view_mode === "side_by_side" ? "Host 1 + Host 2 side by side" : `${cameraTracks.find((track) => track.source_id === shot.view_mode)?.label || shot.view_mode} isolated`)}</strong>
      <span class="assembly-shot-evidence"><strong>${escapeHtml((shot.reason_codes || []).join(" · ") || "source-bound decision")}</strong><span>plan ${escapeHtml((shot.source_camera_plan_shot_ids || []).join(", "))} · activity ${escapeHtml(summarizeEvidenceIds(shot.activity_ids))}${shot.confidence == null ? "" : ` · confidence ${Number(shot.confidence).toFixed(2)}`}</span></span>
    </div>
  ` : `
    <div class="assembly-shot-row" data-assembly-shot="${index}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <input data-assembly-field="start" value="${escapeHtml(shot.start)}" aria-label="Camera shot ${index + 1} start" />
      <input data-assembly-field="end" value="${escapeHtml(shot.end)}" aria-label="Camera shot ${index + 1} end" />
      <select data-assembly-field="view_mode" aria-label="Camera shot ${index + 1} view">
        ${cameraTracks.length >= 2 ? `<option value="side_by_side" ${shot.view_mode === "side_by_side" ? "selected" : ""}>Host 1 + Host 2 side by side</option>` : ""}
        ${cameraTracks.map((track) => `<option value="${escapeHtml(track.source_id)}" ${track.source_id === shot.view_mode ? "selected" : ""}>${escapeHtml(track.label)} isolated</option>`).join("")}
      </select>
      <select data-assembly-field="transition_type" aria-label="Camera shot ${index + 1} transition" ${index === 0 ? "disabled" : ""}>
        <option value="cut" ${shot.transition_type !== "dissolve" ? "selected" : ""}>Cut</option>
        <option value="dissolve" ${shot.transition_type === "dissolve" ? "selected" : ""}>Dissolve</option>
      </select>
      <button class="ghost-button remove-assembly-shot" type="button" aria-label="Remove camera shot ${index + 1}" ${state.assemblyDraftShots.length === 1 ? "disabled" : ""}>×</button>
    </div>
  `).join("");
  if (state.assemblyUsesCameraPlan) return;
  list.querySelectorAll("[data-assembly-shot]").forEach((row) => {
    const index = Number(row.dataset.assemblyShot);
    row.querySelectorAll("[data-assembly-field]").forEach((input) => {
      input.addEventListener("input", () => {
        state.assemblyDraftShots[index][input.dataset.assemblyField] = input.value;
        state.assemblyDirty = true;
        renderEpisodeAssemblyStatus();
      });
    });
    row.querySelector(".remove-assembly-shot").addEventListener("click", () => removeAssemblyShot(index));
  });
}

function applyCurrentCameraPlan() {
  const episode = state.episode;
  const plan = episode?.camera_plan;
  if (!plan || plan.stale) return toast("Build the current source-bound camera plan first.", "error");
  const programStart = assemblyTimestampMs($("#assembly-program-start").value);
  const programEnd = assemblyTimestampMs($("#assembly-program-end").value);
  if (programStart === null || programEnd === null || programEnd <= programStart) {
    return toast("Set a valid program start and end before applying the camera plan.", "error");
  }
  const shots = (plan.shots || []).flatMap((shot) => {
    const startMs = Math.max(programStart, Number(shot.start_ms));
    const endMs = Math.min(programEnd, Number(shot.end_ms));
    if (endMs <= startMs) return [];
    return [{
      start: assemblyTimestamp(startMs),
      end: assemblyTimestamp(endMs),
      view_mode: shot.layout === "side_by_side" ? "side_by_side" : shot.camera_source_id,
      transition_type: "cut",
      source_camera_plan_shot_ids: [shot.id],
      reason_codes: shot.reason_codes || [shot.reason_code].filter(Boolean),
      activity_ids: shot.activity_ids || [],
      confidence: shot.confidence,
    }];
  });
  if (!shots.length || shots[0].start !== assemblyTimestamp(programStart) || shots.at(-1).end !== assemblyTimestamp(programEnd)) {
    return toast("The current camera plan does not cover this entire program range.", "error");
  }
  state.assemblyUsesCameraPlan = true;
  state.assemblyDraftShots = shots;
  markAssemblyDirty();
}

function renderEpisodeAssemblyStatus() {
  const episode = state.episode;
  const assembly = episode?.episode_assembly;
  const review = episode?.episode_assembly_review || { status: "unavailable" };
  const eligible = Boolean(episode?.episode_assembly_state?.eligible);
  const namingRequired = Boolean(episode?.episode_assembly_state?.naming_required);
  const manualTwoCameraBlocked = Boolean(episode?.episode_assembly_state?.automatic_direction_required
    && assembly?.camera_direction?.mode !== "automatic_source_bound");
  const status = $("#assembly-status");
  if (!eligible) {
    status.className = "status-badge blocked";
    status.textContent = namingRequired ? "Approved title required" : "Alignment required";
  } else if (state.assemblyDirty) {
    status.className = "status-badge pending";
    status.textContent = "Unsaved changes";
  } else if (assembly?.stale) {
    status.className = "status-badge stale";
    status.textContent = "Recipe expired";
  } else if (manualTwoCameraBlocked) {
    status.className = "status-badge blocked";
    status.textContent = "Source-bound plan required";
  } else if (review.status === "approved") {
    status.className = "status-badge approved";
    status.textContent = "Recipe approved";
  } else if (review.status === "rejected") {
    status.className = "status-badge rejected";
    status.textContent = "Recipe rejected";
  } else if (assembly) {
    status.className = "status-badge pending";
    status.textContent = "Review required";
  } else {
    status.className = "status-badge pending";
    status.textContent = "Not started";
  }
  $("#save-assembly-button").disabled = !eligible;
  $("#split-assembly-shot-button").disabled = !eligible || !state.assemblyDraftShots.length || state.assemblyUsesCameraPlan;
  const applyPlan = $("#apply-camera-plan-button");
  const cameraPlanCurrent = Boolean(episode?.camera_plan && !episode.camera_plan.stale);
  applyPlan.disabled = !eligible || !cameraPlanCurrent;
  applyPlan.textContent = state.assemblyUsesCameraPlan ? "Source-bound plan applied" : "Apply source-bound camera plan";
  applyPlan.title = cameraPlanCurrent ? "Use the exact current camera decision manifest" : "Build the current channel- and speaker-bound camera plan first";
  $("#approve-assembly-button").disabled = !eligible || !assembly || assembly.stale || state.assemblyDirty || manualTwoCameraBlocked;
  $("#reject-assembly-button").disabled = !assembly || assembly.stale || state.assemblyDirty;
  $("#render-episode-button").disabled = !episode?.episode_assembly_state?.render_eligible || state.assemblyDirty;
  $("#render-proxy-button").disabled = !episode?.episode_assembly_state?.proxy_eligible || state.assemblyDirty;
  $("#open-episode-output-button").disabled = !episode?.episode_render || episode.episode_render.stale;
  $("#render-delivery-audio-button").disabled = !episode?.episode_render || episode.episode_render.stale;
  $("#build-delivery-text-button").disabled = !episode?.episode_render || episode.episode_render.stale
    || episode?.speaker_transcript_review?.status !== "approved" || episode.speaker_transcript_review.stale;
}

function renderE2EReadiness() {
  const episode = state.episode;
  const packageState = state.showPackageState || {};
  const assembly = episode?.episode_assembly;
  const proxy = episode?.episode_proxy;
  const proxyReview = episode?.episode_proxy_review || {};
  const cameraReviewRequired = episode?.episode_assembly_state?.camera_plan_review_required !== false;
  const steps = [
    { label: "Episode title", complete: episode?.episode_naming?.approved === true, detail: episode?.episode_naming?.approved ? `Episode ${episode.episode_naming.approval.episode_number} identity approved` : "Approve a numbered canonical title" },
    { label: "Show package", complete: packageState.approved === true, detail: packageState.approved ? "Opening and closing previews approved" : "Configure, preview, and approve" },
    { label: "CTA in program", complete: Number(assembly?.cta_graphic?.cues?.length || 0) > 0, detail: Number(assembly?.cta_graphic?.cues?.length || 0) > 0 ? "Confirmed cue is inside the selected window" : "Current program misses the confirmed cue" },
    { label: "Complete recipe", complete: Boolean(assembly && !assembly.stale && assembly.opening?.enabled && assembly.closing?.enabled && assembly.visual_style?.side_by_side_divider?.enabled), detail: "Opening, program, divider, CTA, closing" },
    { label: "Recipe approval", complete: episode?.episode_assembly_review?.status === "approved", detail: "Human approval bound to exact inputs" },
    { label: "Camera evidence", complete: !cameraReviewRequired || episode?.camera_plan_review?.status === "approved", detail: cameraReviewRequired ? "Switched views reviewed" : "Stable two-shot moves directly to integrated proxy" },
    { label: "Low-res proxy", complete: Boolean(proxy && !proxy.stale), detail: "Integrated output rendered" },
    {
      label: "Proxy acceptance",
      complete: proxyReview.status === "approved",
      detail: proxyReview.review_mode === "metadata_assisted"
        ? "Exact-file audit plus focused human review"
        : "Beginning-to-end human watch",
    },
    { label: "Full local render", complete: Boolean(episode?.episode_render && !episode.episode_render.stale), detail: "Publication remains separate" },
    { label: "RSS audio QC", complete: Boolean(episode?.delivery_audio && !episode.delivery_audio.stale), detail: "-16 LUFS target · true peak ≤ -1 dBTP" },
    { label: "Final text", complete: Boolean(episode?.delivery_text && !episode.delivery_text.stale), detail: "SRT · VTT · transcript · chapters" },
  ];
  const firstIncomplete = steps.findIndex((step) => !step.complete);
  $("#e2e-readiness-list").innerHTML = steps.map((step, index) => `
    <li class="${step.complete ? "complete" : index === firstIncomplete ? "current" : ""}">
      <strong>${step.complete ? "✓ " : ""}${escapeHtml(step.label)}</strong>
      <span>${escapeHtml(step.detail)}</span>
    </li>`).join("");
  const complete = steps.every((step) => step.complete);
  const status = $("#e2e-readiness-status");
  status.className = `status-badge ${complete ? "approved" : "pending"}`;
  status.textContent = complete ? "Operational proof complete" : `${steps.filter((step) => step.complete).length} of ${steps.length}`;
  $("#prepare-e2e-proof-button").disabled = !packageState.approved || !episode?.camera_plan || episode.camera_plan.stale || !episode?.cta_cues?.confirmed_count;
}

function renderEpisodeOutput() {
  const render = state.episode?.episode_render;
  const container = $("#episode-render-result");
  const video = $("#episode-render-preview");
  const receipt = $("#episode-render-receipt");
  if (!render || render.stale) {
    container.classList.add("hidden");
    video.removeAttribute("src");
    return;
  }
  container.classList.remove("hidden");
  video.src = `/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-media`;
  receipt.innerHTML = `
    <strong>Full episode rendered · ${formatDuration(render.output.duration_sec)}</strong>
    <span>${render.output.width}×${render.output.height} · ${escapeHtml(render.output.video_codec)}/${escapeHtml(render.output.audio_codec)} · ${(render.output.bytes / 1024 ** 2).toFixed(1)} MB</span>
    <span>${render.segments.map((segment) => `${escapeHtml(segment.type)} ${formatDuration(segment.duration_sec)}`).join(" · ")}</span>
    <span>${render.cta.in_program_cue_count} in-program CTA cue${render.cta.in_program_cue_count === 1 ? "" : "s"} · closing CTA ${render.cta.closing_overlay ? "on" : "off"} · publication still requires separate approval</span>
  `;
}

function renderDeliveryAudioState() {
  const delivery = state.episode?.delivery_audio;
  const render = state.episode?.episode_render;
  const status = $("#delivery-audio-status");
  const audio = $("#delivery-audio-preview");
  const receipt = $("#delivery-audio-receipt");
  if (!delivery || delivery.stale) {
    status.className = `status-badge ${delivery?.stale ? "stale" : "pending"}`;
    status.textContent = delivery?.stale ? "Audio expired" : render && !render.stale ? "Ready to create" : "Waiting for full render";
    audio.classList.add("hidden");
    audio.removeAttribute("src");
    receipt.innerHTML = render && !render.stale
      ? "<span>The approved full render is ready. Create the local RSS file to measure its final loudness.</span>"
      : "<span>Approve and render the current full episode first.</span>";
    return;
  }
  status.className = "status-badge approved";
  status.textContent = "RSS audio ready";
  audio.classList.remove("hidden");
  audio.src = `/api/episodes/${encodeURIComponent(state.activeSlug)}/delivery-audio-media`;
  receipt.innerHTML = `
    <strong>${escapeHtml(delivery.output.file)} · ${(delivery.output.bytes / 1024 ** 2).toFixed(1)} MB</strong>
    <span>${delivery.output.sample_rate_hz / 1_000} kHz · ${delivery.output.channels === 2 ? "stereo" : `${delivery.output.channels} channels`} · ${delivery.output.bitrate_kbps} kbps ${escapeHtml(delivery.output.codec.toUpperCase())}</span>
    <span>Integrated loudness ${Number(delivery.output_measurement.integrated_lufs).toFixed(1)} LUFS · true peak ${Number(delivery.output_measurement.true_peak_dbtp).toFixed(1)} dBTP</span>
    <span>SHA-256 ${escapeHtml(delivery.output.sha256.slice(0, 16))}… · Upload and publication remain separate.</span>
  `;
}

function renderDeliveryTextState() {
  const episode = state.episode;
  const delivery = episode?.delivery_text;
  const render = episode?.episode_render;
  const transcriptApproved = episode?.speaker_transcript_review?.status === "approved"
    && !episode.speaker_transcript_review.stale;
  const status = $("#delivery-text-status");
  const textarea = $("#delivery-chapter-lines");
  const receipt = $("#delivery-text-receipt");
  const receiptIdentity = delivery && !delivery.stale ? `${delivery.generated_at}:${delivery.assembly_fingerprint}` : "";
  if (textarea.dataset.receiptIdentity !== receiptIdentity && document.activeElement !== textarea) {
    const lines = delivery && !delivery.stale
      ? delivery.chapters.map((chapter) => `${chapter.start} ${chapter.title}`)
      : episode?.delivery_text_suggested_chapters || [];
    textarea.value = lines.join("\n");
    textarea.dataset.receiptIdentity = receiptIdentity;
  }
  if (!delivery || delivery.stale) {
    status.className = `status-badge ${delivery?.stale ? "stale" : "pending"}`;
    status.textContent = delivery?.stale
      ? "Final text expired"
      : !render || render.stale
        ? "Waiting for full render"
        : !transcriptApproved ? "Waiting for transcript approval" : "Ready to build";
    receipt.innerHTML = render && !render.stale && transcriptApproved
      ? "<span>Review the suggested chapters, replace generic titles with real topics, then build the final files.</span>"
      : "<span>A current full render and approved speaker transcript are required.</span>";
    return;
  }
  status.className = "status-badge approved";
  status.textContent = "Final text ready";
  receipt.innerHTML = `
    <strong>${delivery.caption_count} final-timeline caption cues · ${delivery.chapters.length} chapters</strong>
    <span>${[delivery.files.srt.file, delivery.files.vtt.file, delivery.files.transcript.file, delivery.files.chapters.file].map(escapeHtml).join(" · ")}</span>
    <span>Program begins at ${formatDuration(delivery.timeline_map.opening_duration_ms / 1_000)} after the opening package; closing begins at ${formatDuration(delivery.timeline_map.closing_start_ms / 1_000)}.</span>
    <span>Every file is checksum-bound to the current full render and approved transcript. External delivery remains separate.</span>
  `;
}

function renderEpisodeProxyOutput() {
  const proxy = state.episode?.episode_proxy;
  const container = $("#episode-proxy-result");
  const video = $("#episode-proxy-preview");
  const receipt = $("#episode-proxy-receipt");
  if (!proxy || proxy.stale) {
    container.classList.add("hidden");
    video.removeAttribute("src");
    return;
  }
  container.classList.remove("hidden");
  video.src = `/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-proxy-media`;
  $("#episode-proxy-focused-link").href = `/proxy_review.html?episode=${encodeURIComponent(state.activeSlug)}`;
  receipt.innerHTML = `
    <strong>Camera-direction proxy rendered · ${formatDuration(proxy.output.duration_sec)}</strong>
    <span>${proxy.output.width}×${proxy.output.height} · ${escapeHtml(proxy.output.video_codec)}/${escapeHtml(proxy.output.audio_codec)} · ${(proxy.output.bytes / 1024 ** 2).toFixed(1)} MB</span>
    <span>${proxy.segments.map((segment) => `${escapeHtml(segment.type)} ${formatDuration(segment.duration_sec)}`).join(" · ")}</span>
    <span>${proxy.cta.in_program_cue_count} in-program CTA · closing CTA ${proxy.cta.closing_overlay ? "on" : "off"} · divider ${proxy.visual_style?.side_by_side_divider?.enabled ? "on" : "off"}</span>
    <span>Bound to camera plan ${escapeHtml(String(proxy.camera_plan_fingerprint || "").slice(0, 12))}… · explicit proxy acceptance required before full render.</span>
  `;
  renderEpisodeProxyReview();
}

function proxyHasCompletePackage(proxy) {
  const segmentTypes = new Set((proxy?.segments || []).map((segment) => segment.type));
  return segmentTypes.has("opening")
    && segmentTypes.has("program")
    && segmentTypes.has("closing")
    && Number(proxy?.cta?.in_program_cue_count || 0) >= 1
    && proxy?.cta?.closing_overlay === true
    && proxy?.visual_style?.side_by_side_divider?.enabled === true
    && Object.values(proxy?.checks || {}).every(Boolean);
}

function proxyReviewChecks() {
  return Object.fromEntries([...document.querySelectorAll("[data-proxy-review-check]")]
    .map((input) => [input.dataset.proxyReviewCheck, input.checked]));
}

function proxyReviewMode() {
  return document.querySelector('input[name="proxy-review-mode"]:checked')?.value || "complete_watch";
}

function renderEpisodeProxyAudit() {
  const audit = state.episode?.episode_proxy_audit;
  const container = $("#episode-proxy-audit");
  const button = $("#run-episode-proxy-audit-button");
  if (!audit || audit.status === "unavailable") {
    container.innerHTML = "<span>Render the current proxy before running its exact-file metadata audit.</span>";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  button.textContent = audit.status === "passed" && !audit.stale ? "Rerun metadata audit" : "Run metadata audit";
  if (audit.status !== "passed" || audit.stale) {
    container.innerHTML = `<strong>${audit.stale ? "Metadata audit expired" : "Metadata audit required"}</strong><span>Full decode, A/V drift, stream format, timeline, CTA, loudness, black, freeze, and silence checks must pass for this exact proxy.</span>`;
    return;
  }
  const loudness = audit.loudness || {};
  const observations = audit.observations || {};
  container.innerHTML = `
    <strong>Exact proxy metadata audit passed</strong>
    <span>SHA-256 ${escapeHtml(String(audit.output?.sha256 || "").slice(0, 16))}… · A/V delta ${Number(audit.av_duration_delta_sec || 0).toFixed(3)}s</span>
    <span>Opening ${Number(loudness.opening?.integrated_lufs || 0).toFixed(2)} LUFS · program ${Number(loudness.program?.integrated_lufs || 0).toFixed(2)} LUFS · opening peak ${Number(loudness.opening?.true_peak_dbtp || 0).toFixed(2)} dBTP</span>
    <span>${(observations.black_intervals || []).length} black · ${(observations.freeze_intervals || []).length} freeze · ${(observations.silence_intervals || []).length} silence intervals inspected; none unexpectedly overlaps the program.</span>
  `;
}

function updateProxyReviewApprovalButton() {
  const mode = proxyReviewMode();
  const inputs = [...document.querySelectorAll("[data-proxy-review-check]")];
  const focusedChecked = inputs.filter((input) => input.dataset.proxyReviewCheck !== "complete_watch").every((input) => input.checked);
  const completeWatch = inputs.find((input) => input.dataset.proxyReviewCheck === "complete_watch");
  const audit = state.episode?.episode_proxy_audit;
  const evidenceReady = mode === "metadata_assisted"
    ? focusedChecked && audit?.status === "passed" && !audit.stale && audit.acceptance_eligible === true
    : focusedChecked && completeWatch?.checked === true;
  const proxy = state.episode?.episode_proxy;
  const review = state.episode?.episode_proxy_review || {};
  completeWatch.disabled = mode === "metadata_assisted";
  $("#complete-watch-check").classList.toggle("is-not-applicable", mode === "metadata_assisted");
  const approve = $("#approve-episode-proxy-button");
  approve.textContent = mode === "metadata_assisted" ? "Approve metadata-assisted proxy" : "Approve complete proxy";
  approve.disabled = !evidenceReady || !proxyHasCompletePackage(proxy) || review.status === "approved";
}

function renderEpisodeProxyReview() {
  const review = state.episode?.episode_proxy_review || { status: "pending", checks: {} };
  const mode = review.stale ? "complete_watch" : review.review_mode || "complete_watch";
  const modeInput = document.querySelector(`input[name="proxy-review-mode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  const status = $("#episode-proxy-review-status");
  status.className = `status-badge ${review.stale ? "stale" : review.status === "approved" ? "approved" : review.status === "rejected" ? "rejected" : "pending"}`;
  status.textContent = review.stale
    ? "Review expired"
    : review.status === "approved"
      ? mode === "metadata_assisted" ? "Proxy approved · metadata-assisted" : "Proxy approved · complete watch"
      : review.status === "rejected" ? "Proxy rejected" : "Review required";
  for (const input of document.querySelectorAll("[data-proxy-review-check]")) {
    input.checked = !review.stale && review.checks?.[input.dataset.proxyReviewCheck] === true;
  }
  if (mode === "metadata_assisted") document.querySelector('[data-proxy-review-check="complete_watch"]').checked = false;
  $("#episode-proxy-review-notes").value = review.stale ? "" : review.notes || "";
  $("#reject-episode-proxy-button").disabled = review.status === "rejected";
  renderEpisodeProxyAudit();
  updateProxyReviewApprovalButton();
}

async function saveEpisodeProxyReview(status) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-proxy-review`, {
      method: "PUT",
      body: JSON.stringify({
        status,
        review_mode: proxyReviewMode(),
        checks: proxyReviewChecks(),
        notes: $("#episode-proxy-review-notes").value.trim(),
      }),
    });
    state.episode = data.episode;
    renderEpisode();
    toast(status === "approved"
      ? `${proxyReviewMode() === "metadata_assisted" ? "Metadata-assisted" : "Complete-watch"} proxy approval saved. The full local render is unlocked; starting it remains a separate action.`
      : "Proxy rejected. Full rendering remains locked until a corrected proxy passes.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runEpisodeProxyAudit() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-proxy-audit`, {
      method: "POST",
      body: "{}",
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function prepareE2EProof() {
  const episode = state.episode;
  if (!episode || !state.showPackageState?.approved) return toast("Approve the opening and closing previews first.", "error");
  const cameraTracks = episode.episode_assembly_state?.camera_tracks || [];
  const commonStart = Math.max(0, ...cameraTracks.map((track) => Number(track.timeline_start_ms || 0)));
  const commonEnd = Math.min(Number(episode.timeline?.reference_duration_ms || 0), ...cameraTracks.map((track) => Number(track.timeline_end_ms || Infinity)));
  const confirmedCue = (episode.cta_cues?.cues || []).find((cue) => cue.status === "confirmed");
  const cueStart = assemblyTimestampMs(confirmedCue?.start || confirmedCue?.transcript_segment_start);
  if (!confirmedCue || cueStart === null || cueStart < commonStart || cueStart >= commonEnd) {
    return toast("The existing test does not have a confirmed CTA inside common camera coverage.", "error");
  }
  const programEnd = commonEnd;
  const programStart = Math.max(commonStart, programEnd - 300_000);
  if (cueStart < programStart) return toast("The confirmed CTA falls outside the available five-minute proof window.", "error");
  $("#assembly-program-start").value = assemblyTimestamp(programStart);
  $("#assembly-program-end").value = assemblyTimestamp(programEnd);
  $("#assembly-divider-enabled").checked = true;
  $("#assembly-divider-color").value = "#23333a";
  $("#assembly-camera-balance-enabled").checked = true;
  applyShowPackageToAssembly({ markDirty: false });
  applyCurrentCameraPlan();
  const saved = await saveEpisodeAssembly();
  if (saved) {
    toast("Five-minute end-to-end recipe prepared with opening, spoken CTA, closing, and the restrained center divider. Review and approve the exact recipe next.");
  }
}

function renderEpisodeAssembly() {
  const episode = state.episode;
  const eligible = Boolean(episode?.episode_assembly_state?.eligible);
  const lockNote = $("#assembly-lock-note");
  lockNote.classList.toggle("hidden", eligible);
  lockNote.textContent = eligible ? "" : episode?.episode_assembly_state?.naming_required
    ? "Approve a current numbered canonical title above before saving the full episode recipe."
    : "Confirm the current aligned camera preview near both ends before building the full episode recipe.";
  renderAssemblyShotList();
  const cta = episode?.cta_cues || {};
  $("#assembly-cta-summary").textContent = cta.confirmed_count
    ? `${cta.confirmed_count} confirmed cue${cta.confirmed_count === 1 ? "" : "s"} will trigger the compact single-action Subscribe visual and any custom pop-in selected here. Spoken actions remain available for platform copy.`
    : "No in-program cue is confirmed. The closing CTA can still play over the recorded outro.";
  const assembly = episode?.episode_assembly;
  const receipt = $("#assembly-receipt");
  if (!assembly) {
    receipt.innerHTML = "Save the recipe to create a source-bound episode assembly receipt.";
  } else if (assembly.stale) {
    receipt.innerHTML = '<div class="assembly-warning">This recipe expired because an aligned source, reviewed CTA cue, selected asset, or inherited show package changed. Existing choices were preserved. Use Refresh from approved defaults only when you want the new master, then save and review again.</div>';
  } else {
    const viewCount = new Set((assembly.program?.shots || []).map((shot) => shot.layout === "side_by_side" ? "side_by_side" : shot.camera_source_id)).size;
    receipt.innerHTML = `
      <strong>${assembly.program.shots.length} view shots · ${viewCount} view mode${viewCount === 1 ? "" : "s"} · ${formatDuration(assembly.program.duration_ms / 1000)} program</strong>
      <span>Full-master contract: 3840×2160 (4K UHD) · ${assembly.output.frame_rate}fps · ${escapeHtml(assembly.output.video_codec)}/${escapeHtml(assembly.output.audio_codec)}</span>
      <span>CTA visual: ${escapeHtml(assembly.cta_graphic.website_label)} · ${escapeHtml(assembly.cta_graphic.visual_secondary_label || "Subscribe on YouTube")} · spoken actions ${(assembly.cta_graphic.actions || []).map((action) => escapeHtml(action)).join(" / ") || "none"} remain available for platform copy with the real HTTPS link</span>
      <span>Two-shot divider: ${assembly.visual_style?.side_by_side_divider?.enabled ? `${assembly.visual_style.side_by_side_divider.width_full_px}px ${escapeHtml(assembly.visual_style.side_by_side_divider.color)}` : "off"}</span>
      <span>Camera balance: ${assembly.visual_style?.camera_balance?.enabled ? "gentle automatic match · exact measurements recorded in the proxy" : "off"}</span>
      <span>Host framing: ${assembly.visual_style?.camera_framing?.enabled ? "independent non-destructive camera crops" : "centered default crops"} · graphics ${(assembly.program_graphics?.cue_count || 0)} exact review cue${assembly.program_graphics?.cue_count === 1 ? "" : "s"}</span>
      <span>Closing music lead: ${(Number(assembly.closing?.audio_lead_ms || 0) / 1000).toFixed(1)} seconds under final speech</span>
      ${assembly.show_package?.fingerprint ? `<span>Inherited show package ${escapeHtml(assembly.show_package.fingerprint.slice(0, 12))}… · refresh behavior explicit</span>` : "<span>Show assets are episode-specific overrides.</span>"}
      ${episode.episode_assembly_state?.automatic_direction_required && assembly.camera_direction?.mode !== "automatic_source_bound" ? '<div class="assembly-warning">This manual two-camera recipe cannot be approved. Build and apply the current source-bound camera plan.</div>' : ""}
      ${(assembly.warnings || []).map((warning) => `<div class="assembly-warning">${escapeHtml(warning)}</div>`).join("")}
      <span>${episode.episode_assembly_state?.automatic_direction_required && assembly.camera_direction?.mode !== "automatic_source_bound" ? "Build and apply the current source-bound camera plan. This older manual recipe cannot unlock a proxy or full render." : assembly.camera_direction?.mode === "automatic_source_bound" ? episode.episode_assembly_state?.camera_plan_review_required ? "Approve the recipe and switched-view samples, render the proxy, then complete its exact review to unlock the full local render." : "This stable two-shot needs only recipe approval before the integrated proxy. Review the complete package there." : "Approve the recipe to enable a local full-episode render. Rendering does not upload or publish anything."}</span>
    `;
  }
  renderEpisodeOutput();
  renderDeliveryAudioState();
  renderDeliveryTextState();
  renderEpisodeProxyOutput();
  renderCameraPlanReview();
  renderEpisodeAssemblyStatus();
  renderE2EReadiness();
}

function graphicDurationMs(value, maximumSeconds) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > maximumSeconds) throw new Error(`Graphic duration must be 2–${maximumSeconds} seconds.`);
  return Math.round(seconds * 1_000);
}

async function saveEpisodeAssembly() {
  try {
    const lowerThirdTimes = $("#assembly-lower-third-times").value
      .split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    const topicBars = $("#assembly-topic-bars").value
      .split("\n").map((value) => value.trim()).filter(Boolean).map((line) => {
        const separator = line.indexOf("|");
        if (separator < 0) throw new Error(`Topic bar needs "timestamp | title": ${line}`);
        const [start, title, duration = "6", position = "top"] = line.split("|").map((part) => part.trim());
        return { start, title, duration_ms: graphicDurationMs(duration, 60), position };
      });
    const body = {
      title: $("#assembly-title").value.trim(),
      program_start: $("#assembly-program-start").value.trim(),
      program_end: $("#assembly-program-end").value.trim(),
      shots: state.assemblyDraftShots.map((shot, index) => ({
        start: shot.start,
        end: shot.end,
        layout: shot.view_mode === "side_by_side" ? "side_by_side" : "isolated",
        camera_source_id: shot.view_mode === "side_by_side" ? null : shot.view_mode,
        transition_in: { type: index === 0 ? "cut" : shot.transition_type, duration_ms: shot.transition_type === "dissolve" ? 350 : 0 },
      })),
      apply_camera_plan: state.assemblyUsesCameraPlan,
      camera_plan_fingerprint: state.assemblyUsesCameraPlan ? state.episode?.camera_plan?.fingerprint : null,
      opening: {
        use_show_default: state.assemblyInheritance.opening,
        visual_path: $("#assembly-opening-visual").value.trim(),
        voiceover_path: $("#assembly-opening-voiceover").value.trim(),
        music_path: $("#assembly-opening-music").value.trim(),
        trim_end_ms: Math.round(Number($("#assembly-opening-trim-end").value) * 1_000),
        audio_gain_db: state.episode?.episode_assembly?.opening?.audio_gain_db ?? 0,
      },
      closing: {
        use_show_default: state.assemblyInheritance.closing,
        visual_path: $("#assembly-closing-visual").value.trim(),
        voiceover_path: $("#assembly-closing-voiceover").value.trim(),
        music_path: $("#assembly-closing-music").value.trim(),
        audio_gain_db: Number($("#assembly-closing-audio-gain").value),
        trim_end_ms: state.episode?.episode_assembly?.closing?.trim_end_ms ?? 0,
        audio_lead_ms: Math.round(Number($("#assembly-closing-audio-lead").value || 0) * 1_000),
      },
      cta_graphic: {
        use_show_default: state.assemblyInheritance.cta_graphic,
        asset_path: $("#assembly-cta-asset").value.trim(),
        website_label: $("#assembly-cta-label").value.trim(),
        website_url: $("#assembly-cta-url").value.trim(),
        actions: ["like", "comment", "subscribe"].filter((action) => $(`#assembly-cta-${action}`).checked),
        show_during_closing: $("#assembly-cta-closing").checked,
      },
      newsletter_cta: {
        use_show_default: state.assemblyInheritance.newsletter_cta,
        asset_path: $("#assembly-newsletter-asset").value.trim(),
        website_label: $("#assembly-newsletter-label").value.trim(),
        website_url: $("#assembly-newsletter-url").value.trim(),
      },
      visual_style: {
        program_fade_in_ms: Math.round(Number($("#assembly-program-fade-in").value) * 1_000),
        side_by_side_divider: {
          enabled: $("#assembly-divider-enabled").checked,
          width_full_px: Number($("#assembly-divider-width").value),
          color: $("#assembly-divider-color").value,
        },
        camera_balance: {
          enabled: $("#assembly-camera-balance-enabled").checked,
        },
        camera_framing: {
          enabled: $("#assembly-camera-framing-enabled").checked,
          sources: {
            primary_camera: {
              zoom: Number($("#assembly-primary-zoom").value),
              horizontal: Number($("#assembly-primary-horizontal").value),
              vertical: Number($("#assembly-primary-vertical").value),
              temperature: Number($("#assembly-primary-temperature").value),
            },
            secondary_camera: {
              zoom: Number($("#assembly-secondary-zoom").value),
              horizontal: Number($("#assembly-secondary-horizontal").value),
              vertical: Number($("#assembly-secondary-vertical").value),
              temperature: Number($("#assembly-secondary-temperature").value),
            },
          },
        },
      },
      program_graphics: {
        enabled: $("#assembly-program-graphics-enabled").checked,
        lower_thirds: lowerThirdTimes.map((line) => ({
          start: line.split("|")[0].trim(),
          duration_ms: graphicDurationMs(line.split("|")[1]?.trim() ?? 6, 12),
          host_1_name: $("#assembly-host-one-name").value.trim(),
          host_2_name: $("#assembly-host-two-name").value.trim(),
        })),
        topic_bars: topicBars,
      },
    };
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/assembly`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    state.episode = data.episode;
    prepareAssemblyDraft();
    renderEpisode();
    const cameraReviewRequired = state.episode?.episode_assembly_state?.camera_plan_review_required !== false;
    toast(state.episode?.episode_assembly?.camera_direction?.mode === "automatic_source_bound"
      ? cameraReviewRequired
        ? "Source-bound camera plan saved unchanged in assembly. Approve the recipe, then review the switched-camera samples."
        : "Stable two-shot recipe saved. Approve it, then review the complete integrated proxy."
      : "Full episode assembly recipe saved. Review it before rendering.");
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

async function reviewEpisodeAssembly(status) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/assembly-review`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    state.episode = data.episode;
    renderEpisode();
    toast(status === "approved" ? "Episode recipe approved. Rendering remains a separate build gate." : "Episode recipe rejected for revision.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function activeCameraPlanSample() {
  return state.episode?.camera_plan_samples?.samples?.find((item) => item.id === state.activeCameraPlanSampleId) || null;
}

function currentCameraPlanTimelineMs() {
  const timeline = state.episode?.timeline;
  const tracks = (timeline?.tracks || []).filter((track) => track.media_kind === "video").slice(0, 2);
  const referenceIndex = Math.max(0, tracks.findIndex((track) => track.source_id === timeline?.reference_source_id));
  const referenceTrack = tracks[referenceIndex];
  const referenceVideo = [$("#camera-plan-preview-primary"), $("#camera-plan-preview-secondary")][referenceIndex];
  if (!referenceTrack || !referenceVideo || !Number.isFinite(referenceVideo.currentTime)) return null;
  const rate = Number(referenceTrack.alignment?.playback_rate || 1);
  return Number(referenceTrack.timeline_start_ms || 0)
    + (referenceVideo.currentTime * 1000 - Number(referenceTrack.source_in_ms || 0)) / rate;
}

function updateCameraPlanTransport(sample = activeCameraPlanSample(), timelineMs = state.cameraPlanPreviewPositionMs) {
  const resumeButton = $("#resume-camera-plan-preview-button");
  const pauseButton = $("#pause-camera-plan-preview-button");
  const scrubber = $("#camera-plan-preview-scrubber");
  const time = $("#camera-plan-preview-time");
  if (!resumeButton || !pauseButton || !scrubber || !time) return;
  if (!sample?.available) {
    resumeButton.disabled = true;
    pauseButton.disabled = true;
    scrubber.disabled = true;
    scrubber.min = "0";
    scrubber.max = "1";
    scrubber.value = "0";
    time.textContent = "Choose a sample";
    return;
  }
  const position = Math.max(Number(sample.start_ms), Math.min(Number(sample.end_ms) - 1, Number(timelineMs ?? sample.start_ms)));
  scrubber.disabled = false;
  scrubber.min = String(sample.start_ms);
  scrubber.max = String(Math.max(Number(sample.start_ms) + 1, Number(sample.end_ms) - 1));
  scrubber.value = String(Math.round(position));
  time.textContent = `Source ${assemblyTimestamp(position)} / ${assemblyTimestamp(sample.end_ms)}`;
  const playing = Boolean(state.cameraPlanPreviewTimer);
  resumeButton.disabled = playing || position >= Number(sample.end_ms) - 250;
  pauseButton.disabled = !playing;
}

function stopCameraPlanPreview() {
  const sample = activeCameraPlanSample();
  const current = currentCameraPlanTimelineMs();
  if (sample && current !== null) {
    state.cameraPlanPreviewPositionMs = Math.max(Number(sample.start_ms), Math.min(Number(sample.end_ms) - 1, current));
  }
  clearInterval(state.cameraPlanPreviewTimer);
  state.cameraPlanPreviewTimer = null;
  for (const id of ["camera-plan-preview-primary", "camera-plan-preview-secondary"]) {
    const video = $(`#${id}`);
    if (video) video.pause();
  }
  updateCameraPlanTransport(sample);
}

function updateCameraPlanPreview(timelineMs, sample) {
  const timeline = state.episode?.timeline;
  const assembly = state.episode?.episode_assembly;
  const tracks = (timeline?.tracks || []).filter((track) => track.media_kind === "video").slice(0, 2);
  if (!timeline || !assembly || tracks.length < 2) return;
  state.cameraPlanPreviewPositionMs = Number(timelineMs);
  const videos = [$("#camera-plan-preview-primary"), $("#camera-plan-preview-secondary")];
  tracks.forEach((track, index) => {
    const sourceMs = previewSourceMs(track, timelineMs);
    if (sourceMs === null) return videos[index].pause();
    videos[index].playbackRate = Number(track.alignment?.playback_rate || 1);
    const sourceSeconds = sourceMs / 1000;
    if (videos[index].paused || Math.abs(videos[index].currentTime - sourceSeconds) > 0.16) {
      try { videos[index].currentTime = sourceSeconds; } catch {}
    }
  });
  const shot = (assembly.program?.shots || []).find((item) => timelineMs >= Number(item.start_ms) && timelineMs < Number(item.end_ms))
    || assembly.program?.shots?.at(-1);
  const stage = $("#camera-plan-preview-stage");
  stage.classList.remove("side_by_side", "isolated-primary_camera", "isolated-secondary_camera");
  stage.classList.add(shot?.layout === "side_by_side" ? "side_by_side" : `isolated-${shot?.camera_source_id}`);
  $("#camera-plan-preview-reason").innerHTML = shot ? `
    <strong>${escapeHtml(shot.camera_label || shot.layout)}</strong> · ${escapeHtml(assemblyTimestamp(timelineMs))}<br>
    ${escapeHtml((shot.reason_codes || []).join(" · ") || "source-bound decision")} · plan ${escapeHtml((shot.source_camera_plan_shot_ids || []).join(", "))} · activity ${escapeHtml(summarizeEvidenceIds(shot.activity_ids))}
    ${sample?.cta_cue_id ? `<br>CTA ${escapeHtml(sample.cta_type)} · ${escapeHtml(sample.cta_cue_id)}` : ""}
  ` : "No camera shot covers this instant.";
  updateCameraPlanTransport(sample, timelineMs);
}

async function playCameraPlanSample(sampleId, { resume = false } = {}) {
  const priorSampleId = state.activeCameraPlanSampleId;
  stopCameraPlanPreview();
  const sample = state.episode?.camera_plan_samples?.samples?.find((item) => item.id === sampleId);
  const timeline = state.episode?.timeline;
  const tracks = (timeline?.tracks || []).filter((track) => track.media_kind === "video").slice(0, 2);
  if (!sample?.available || tracks.length < 2) return;
  state.activeCameraPlanSampleId = sampleId;
  const startMs = resume && priorSampleId === sampleId && Number.isFinite(Number(state.cameraPlanPreviewPositionMs))
    ? Math.max(Number(sample.start_ms), Math.min(Number(sample.end_ms) - 1, Number(state.cameraPlanPreviewPositionMs)))
    : Number(sample.start_ms);
  const videos = [$("#camera-plan-preview-primary"), $("#camera-plan-preview-secondary")];
  updateCameraPlanPreview(startMs, sample);
  await Promise.allSettled(videos.map((video) => video.play()));
  const referenceIndex = Math.max(0, tracks.findIndex((track) => track.source_id === timeline.reference_source_id));
  const referenceTrack = tracks[referenceIndex];
  const referenceVideo = videos[referenceIndex];
  state.cameraPlanPreviewedSampleIds.add(sampleId);
  renderCameraPlanReview();
  state.cameraPlanPreviewTimer = setInterval(() => {
    if (referenceVideo.paused) return stopCameraPlanPreview();
    const rate = Number(referenceTrack.alignment?.playback_rate || 1);
    const current = Number(referenceTrack.timeline_start_ms || 0)
      + (referenceVideo.currentTime * 1000 - Number(referenceTrack.source_in_ms || 0)) / rate;
    if (current >= Number(sample.end_ms)) {
      updateCameraPlanPreview(sample.end_ms - 1, sample);
      return stopCameraPlanPreview();
    }
    updateCameraPlanPreview(current, sample);
  }, 200);
  updateCameraPlanTransport(sample, startMs);
}

function resumeCameraPlanPreview() {
  if (state.activeCameraPlanSampleId) playCameraPlanSample(state.activeCameraPlanSampleId, { resume: true });
}

function seekCameraPlanPreview(event) {
  const timelineMs = Number(event.target.value);
  stopCameraPlanPreview();
  const sample = activeCameraPlanSample();
  if (!sample?.available) return;
  state.cameraPlanPreviewPositionMs = timelineMs;
  updateCameraPlanPreview(timelineMs, sample);
}

function renderCameraPlanReview() {
  const workspace = $("#camera-plan-review-workspace");
  const sampleSet = state.episode?.camera_plan_samples;
  const assembly = state.episode?.episode_assembly;
  if (!sampleSet || assembly?.stale || assembly?.camera_direction?.mode !== "automatic_source_bound"
    || state.episode?.episode_assembly_state?.camera_plan_review_required === false) {
    stopCameraPlanPreview();
    workspace.classList.add("hidden");
    return;
  }
  workspace.classList.remove("hidden");
  const openingSec = Number(state.showPackageState?.previews?.opening?.output?.duration_sec || 0);
  const closingSec = Number(state.showPackageState?.previews?.closing?.output?.duration_sec || 0);
  const programSec = Number(assembly.program?.duration_ms || 0) / 1000;
  const firstCue = assembly.cta_graphic?.cues?.[0];
  const ctaProxySec = firstCue ? openingSec + (Number(firstCue.start_ms) - Number(assembly.program.start_ms)) / 1000 : null;
  const scopeDetails = [
    openingSec ? `opening ${formatDuration(openingSec)}` : null,
    `recorded program ${formatDuration(programSec)}`,
    closingSec ? `closing ${formatDuration(closingSec)}` : null,
  ].filter(Boolean).join(" → ");
  $("#camera-plan-preview-scope").innerHTML = `
    <strong>This is not the packaged episode.</strong> It reviews only source recording ${escapeHtml(assembly.program.start)} → ${escapeHtml(assembly.program.end)}.
    The integrated proxy begins at 00:00 with ${escapeHtml(scopeDetails)}.${ctaProxySec !== null ? ` The CTA graphic is expected around proxy ${escapeHtml(formatDuration(ctaProxySec))}.` : ""}
  `;
  const tracks = (state.episode.timeline?.tracks || []).filter((track) => track.media_kind === "video").slice(0, 2);
  const primary = $("#camera-plan-preview-primary");
  const secondary = $("#camera-plan-preview-secondary");
  if (tracks[0] && !primary.src) primary.src = `/api/episodes/${encodeURIComponent(state.activeSlug)}/media/${encodeURIComponent(tracks[0].source_id)}`;
  if (tracks[1] && !secondary.src) secondary.src = `/api/episodes/${encodeURIComponent(state.activeSlug)}/media/${encodeURIComponent(tracks[1].source_id)}`;
  if (tracks[0]) applyReviewRotation(primary, tracks[0].source_id);
  if (tracks[1]) applyReviewRotation(secondary, tracks[1].source_id);
  updateCameraPlanRotationControls(tracks);
  primary.muted = tracks[0]?.source_id !== state.episode.timeline.reference_source_id;
  secondary.muted = tracks[1]?.source_id !== state.episode.timeline.reference_source_id;
  const saved = state.episode.camera_plan_review?.stale ? {} : state.episode.camera_plan_review || {};
  $("#camera-plan-review-notes").value = saved.notes || "";
  const status = $("#camera-plan-review-status");
  status.textContent = state.episode.camera_plan_review?.stale ? "Review expired" : saved.status === "approved" ? "Camera plan approved" : saved.status === "rejected" ? "Camera plan rejected" : "Review required";
  status.className = `status-badge ${state.episode.camera_plan_review?.stale ? "stale" : saved.status || "pending"}`;
  $("#camera-plan-sample-list").innerHTML = sampleSet.samples.map((sample) => {
    const previewed = state.cameraPlanPreviewedSampleIds.has(sample.id);
    const checked = state.cameraPlanChecks[sample.id] === true;
    return `
      <article class="camera-plan-sample ${sample.available ? "" : "unavailable"} ${previewed ? "previewed" : ""}">
        <strong>${escapeHtml(sample.label)}</strong>
        <span>${sample.available ? `Source ${escapeHtml(assemblyTimestamp(sample.start_ms))} → ${escapeHtml(assemblyTimestamp(sample.end_ms))}` : escapeHtml(sample.unavailable_reason)}</span>
        ${sample.available ? `<button class="secondary-button play-camera-plan-sample" data-sample-id="${escapeHtml(sample.id)}" type="button">${previewed ? "Replay sample" : "Play sample"}</button>` : ""}
        <label><input class="camera-plan-sample-check" data-sample-id="${escapeHtml(sample.id)}" type="checkbox" ${checked ? "checked" : ""} ${sample.available && !previewed ? "disabled" : ""} /> ${sample.available ? "View and reason are correct" : "Acknowledge state is absent"}</label>
      </article>`;
  }).join("");
  document.querySelectorAll(".play-camera-plan-sample").forEach((button) => button.addEventListener("click", () => playCameraPlanSample(button.dataset.sampleId)));
  document.querySelectorAll(".camera-plan-sample-check").forEach((input) => input.addEventListener("change", () => {
    state.cameraPlanChecks[input.dataset.sampleId] = input.checked;
    $("#approve-camera-plan-button").disabled = ![...document.querySelectorAll(".camera-plan-sample-check")].every((item) => item.checked);
  }));
  const allChecked = [...document.querySelectorAll(".camera-plan-sample-check")].every((input) => input.checked);
  $("#approve-camera-plan-button").disabled = !allChecked || saved.status === "approved";
  updateCameraPlanTransport();
}

async function reviewCameraPlan(status) {
  try {
    const checks = Object.fromEntries([...document.querySelectorAll(".camera-plan-sample-check")]
      .map((input) => [input.dataset.sampleId, input.checked]));
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/camera-plan-review`, {
      method: "PUT",
      body: JSON.stringify({
        status,
        checks,
        previewed_sample_ids: [...state.cameraPlanPreviewedSampleIds],
        notes: $("#camera-plan-review-notes").value.trim(),
      }),
    });
    state.episode = data.episode;
    renderEpisode();
    toast(status === "approved" ? "Camera samples approved. One low-resolution proxy is now available." : "Camera plan rejected. Proxy rendering remains locked.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveCtaCue({ cueId = null, segmentIndex = null, status, ctaType = null }) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/cta-cues`, {
      method: "PUT",
      body: JSON.stringify({ cue_id: cueId, segment_index: segmentIndex, status, cta_type: ctaType, notes: "" }),
    });
    state.episode = data.episode;
    renderCtaCues();
    renderTranscript();
    toast(status === "confirmed"
      ? `${ctaType === "newsletter" ? "Newsletter" : "Podcast"} graphic cue confirmed. The editor handoff files are current.`
      : "Graphic cue dismissed. The editor handoff files are current.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function sourceDetails(source) {
  const details = [formatDuration(source.duration_sec)];
  if (source.video) {
    details.push(`${source.video.width}×${source.video.height}`);
    if (source.video.fps) details.push(`${Number(source.video.fps).toFixed(2)} fps`);
    if (source.video.codec) details.push(source.video.codec);
  }
  if (source.audio) {
    if (source.audio.sample_rate) details.push(`${Math.round(source.audio.sample_rate / 1000)} kHz`);
    if (source.audio.channels) details.push(`${source.audio.channels} ch`);
    if (source.audio.codec) details.push(source.audio.codec);
  }
  return details.join(" · ");
}

function renderSourceReadiness() {
  const intake = state.episode.intake;
  const status = $("#intake-status");
  const cards = $("#source-cards");
  const findings = $("#intake-findings");
  if (!intake) {
    status.textContent = "Single source";
    status.className = "status-badge attention";
    cards.innerHTML = `
      <article class="source-card">
        <span class="source-role">Primary camera</span>
        <strong>${escapeHtml(state.episode.source_name)}</strong>
        <span>${formatDuration(state.episode.duration_sec)} · legacy single-source episode</span>
      </article>
    `;
    findings.innerHTML = '<div class="intake-finding">No multi-source receipt exists yet. This episode can still use the original single-camera workflow.</div>';
    renderSync();
    renderTimeline();
    renderSpeakerTranscript();
    return;
  }
  const compatibility = intake.compatibility || {};
  const transcriptionBlocked = ["blocked", "failed", "not_run", "pending"].includes(intake.transcription?.status);
  const syncApproved = state.episode.sync?.review?.status === "approved" && !state.episode.sync?.stale;
  const timelineReady = state.episode.timeline && !state.episode.timeline.stale;
  const previewApproved = state.episode.timeline_preview_review?.status === "approved" && !state.episode.timeline_preview_review?.stale;
  const pendingSequences = Object.values(intake.audio_sequences || {}).filter((sequence) => !sequence.ready);
  status.textContent = state.episode.intake_stale
    ? "Source check expired"
    : pendingSequences.length
      ? "Seam review required"
    : transcriptionBlocked
      ? "Transcript not current"
    : previewApproved
      ? "Playback verified · render disabled"
    : timelineReady
      ? "Timeline built · preview required"
    : syncApproved
      ? "Sync confirmed"
      : compatibility.status === "ready" ? "Ready for sync check" : compatibility.status || "Not measured";
  status.className = `status-badge ${state.episode.intake_stale || transcriptionBlocked ? "stale" : timelineReady ? "attention" : syncApproved ? "ready" : escapeHtml(compatibility.status || "pending")}`;
  const sequenceCards = Object.values(intake.audio_sequences || {}).map((sequence) => {
    const seams = (sequence.seams || []).map((seam) => `
      <div class="audio-seam-row ${escapeHtml(seam.review?.status || "pending")}">
        <strong>${escapeHtml(seam.id.replace("seam_", "Seam "))}: part ${escapeHtml(String((sequence.parts || []).find((part) => part.id === seam.previous_part_id)?.order || "?"))} → ${escapeHtml(String((sequence.parts || []).find((part) => part.id === seam.next_part_id)?.order || "?"))}</strong>
        <span>${escapeHtml(seam.classification)}${seam.delta_sec == null ? " · no reliable timeline delta" : ` · ${signedMs(Math.round(Number(seam.delta_sec) * 1000))}`} · confidence ${Number(seam.confidence || 0).toFixed(3)}</span>
        ${seam.duplicate_samples_suspected ? '<span class="intake-finding blocking">Mapped overlap may contain duplicate samples. Listen before choosing a boundary decision.</span>' : ""}
        ${seam.unexplained_discontinuity ? '<span class="intake-finding blocking">The discontinuity is not explained by reliable mapping. Human review is required.</span>' : ""}
        ${seam.preview_file ? `<audio controls preload="metadata" src="/api/episodes/${encodeURIComponent(state.episode.slug)}/audio-sequences/${encodeURIComponent(sequence.role)}/seams/${encodeURIComponent(seam.id)}/media"></audio>` : '<span class="muted">A local seam preview could not be created. Review the raw edge files before approval.</span>'}
        <div class="audio-seam-actions">
          <button class="primary-button audio-seam-review" data-role="${escapeHtml(sequence.role)}" data-seam-id="${escapeHtml(seam.id)}" data-status="approved" data-classification="${escapeHtml(seam.classification)}" type="button" ${seam.review?.status === "approved" ? "disabled" : ""}>${seam.review?.status === "approved" ? "Confirmed" : "Confirm & keep boundary"}</button>
          <button class="ghost-button audio-seam-review" data-role="${escapeHtml(sequence.role)}" data-seam-id="${escapeHtml(seam.id)}" data-status="rejected" type="button">Flag blocker</button>
        </div>
        ${seam.review?.notes ? `<small>${escapeHtml(seam.review.notes)}</small>` : ""}
      </div>`).join("");
    return `<article class="source-card audio-sequence-card">
      <span class="source-role">${escapeHtml(sequence.label)} · ordered wireless microphone sequence</span>
      <strong>${Number(sequence.part_count || 0)} part${Number(sequence.part_count || 0) === 1 ? "" : "s"} · ${sequence.ready ? "logical host track ready" : "human review required"}</strong>
      <span>Order ${sequence.order_confirmed ? "confirmed" : "not confirmed"} · raw masters unchanged · ${escapeHtml(sequence.status.replaceAll("_", " "))}</span>
      ${sequence.coverage?.finding ? `<div class="intake-finding ${sequence.coverage.status === "incomplete" ? "blocking" : ""}">${escapeHtml(sequence.coverage.finding)}</div>` : ""}
      <div class="audio-part-inventory">${(sequence.parts || []).map((part) => `<div><strong>${part.order}. ${escapeHtml(part.file)}</strong><br><span>${escapeHtml(sourceDetails(part))} · ${formatFileBytes(part.bytes)}</span></div>`).join("")}</div>
      ${sequence.analysis_error ? `<div class="intake-finding">Camera safety-audio mapping needs manual review: ${escapeHtml(sequence.analysis_error)}</div>` : ""}
      ${seams ? `<div class="audio-seam-list">${seams}</div>` : '<div class="intake-next-step">One part: no internal seam to review.</div>'}
    </article>`;
  }).join("");
  const ordinarySources = (intake.sources || []).filter((source) => !["host_1_audio", "host_2_audio"].includes(source.id));
  cards.innerHTML = ordinarySources.map((source) => `
    <article class="source-card">
      <span class="source-role">${escapeHtml(source.label)}</span>
      <strong title="${escapeHtml(source.file)}">${escapeHtml(source.file)}</strong>
      <span>${escapeHtml(sourceDetails(source))}</span>
    </article>
  `).join("") + sequenceCards;
  const blocks = (compatibility.blocking || []).map((message) => `<div class="intake-finding blocking">${escapeHtml(message)}</div>`);
  if (transcriptionBlocked) {
    blocks.push('<div class="intake-finding blocking">The Host 1 transcript is not current. Run Analyze &amp; transcribe again before reviewing candidates.</div>');
  }
  const warnings = (compatibility.warnings || []).map((message) => `<div class="intake-finding">${escapeHtml(message)}</div>`);
  const syncSummary = state.episode.intake_stale
    ? "source files changed; prior checks expired"
    : previewApproved
      ? "aligned playback verified; render disabled"
    : timelineReady
      ? "aligned timeline built; source preview still required"
    : state.episode.sync
    ? `analysis ${state.episode.sync.status}; review ${state.episode.sync.review?.status || "pending"}`
    : "not measured";
  const nextStep = state.episode.intake_stale
    ? "Run New episode with this source set again before reviewing or rendering."
    : previewApproved
      ? "The start and end were checked. Multi-source rendering remains a separate build gate."
    : timelineReady
      ? "Inspect every track mapping. Multi-source rendering is still disabled."
    : state.episode.sync
    ? "Review the measured start/end relationship before any timeline uses it."
    : compatibility.next_step || "";
  findings.innerHTML = [...blocks, ...warnings, `<div class="intake-next-step"><strong>Sync status:</strong> ${escapeHtml(syncSummary)}. ${escapeHtml(nextStep)}</div>`].join("");
  renderSync();
  renderTimeline();
  renderCameraDirection();
  renderSpeakerTranscript();
}

async function reviewAudioSeam(button) {
  const classification = button.dataset.classification || "";
  let notes = "";
  if (button.dataset.status === "approved" && classification && classification !== "continuous") {
    notes = window.prompt(`This seam is ${classification}. Record what you heard and why keeping the recorded boundary is correct.`, "") || "";
    if (!notes.trim()) return toast("Add a short review note before confirming a non-continuous or uncertain seam.", "error");
  } else if (button.dataset.status === "rejected") {
    notes = window.prompt("What is wrong at this seam?", "") || "";
    if (!notes.trim()) return toast("Add a blocker note so the recording issue is actionable.", "error");
  }
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/audio-sequences/${encodeURIComponent(button.dataset.role)}/review`, {
      method: "PUT",
      body: JSON.stringify({
        seam_id: button.dataset.seamId,
        status: button.dataset.status,
        decision: "keep_boundary",
        notes,
      }),
    });
    state.episode = data.episode;
    renderEpisode();
    await loadEpisodes();
    toast(button.dataset.status === "approved" ? "Seam confirmed. Studio will unlock the logical host track when every seam is approved." : "Seam blocker recorded. Downstream work remains locked.");
  } catch (error) {
    toast(error.message, "error");
  }
}

const CHECKLIST_PHASE_LABELS = {
  planning: "Planning",
  recording: "Recording",
  transfer: "Transfer",
  production: "Production",
  delivery: "Delivery",
  learning: "Learning",
};

function checklistStatusLabel(status) {
  return ({ todo: "To do", complete: "Complete", blocked: "Blocked", not_applicable: "Not applicable" })[status] || "To do";
}

function renderEpisodeChecklist() {
  const checklist = state.episode?.episode_checklist;
  const summary = state.episode?.episode_checklist_summary || { complete: 0, total: 0, blocked: 0, percent: 0 };
  if (!checklist) return;
  $("#episode-checklist-progress").textContent = `${summary.complete} of ${summary.total}${summary.blocked ? ` · ${summary.blocked} blocked` : ""}`;
  $("#episode-checklist-progress").className = `status-badge ${summary.blocked ? "blocked" : summary.percent === 100 ? "approved" : "pending"}`;
  $("#episode-checklist-progress-bar").style.width = `${summary.percent}%`;
  $("#episode-checklist-button").textContent = `Checklist ${summary.complete}/${summary.total}`;
  const activeItems = (checklist.items || []).filter((item) => !item.archived);
  const firstIncomplete = activeItems.find((item) => !["complete", "not_applicable"].includes(item.status));
  $("#episode-checklist-list").innerHTML = Object.keys(CHECKLIST_PHASE_LABELS).map((phase) => {
    const items = activeItems.filter((item) => item.phase === phase);
    const complete = items.filter((item) => ["complete", "not_applicable"].includes(item.status)).length;
    const open = firstIncomplete?.phase === phase || (!firstIncomplete && phase === "learning");
    return `<details class="checklist-phase" ${open ? "open" : ""}>
      <summary>${escapeHtml(CHECKLIST_PHASE_LABELS[phase])}<span>${complete}/${items.length}</span></summary>
      <div class="checklist-phase-items">${items.map((item) => `
        <article class="checklist-row ${escapeHtml(item.status)}" data-checklist-item-id="${escapeHtml(item.id)}">
          <input class="checklist-quick-toggle" type="checkbox" ${item.status === "complete" ? "checked" : ""} aria-label="Mark ${escapeHtml(item.title)} complete" />
          <div class="checklist-row-copy">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.description)}</span>
            <small>${escapeHtml(item.owner || "Unassigned")} · ${escapeHtml(checklistStatusLabel(item.status))}${item.notes ? ` · ${escapeHtml(item.notes)}` : ""}</small>
          </div>
          <button class="ghost-button checklist-edit-button" type="button">Update</button>
        </article>`).join("")}</div>
    </details>`;
  }).join("");
}

function openEpisodeChecklist() {
  if (!state.episode) return;
  renderEpisodeChecklist();
  $("#episode-checklist-dialog").showModal();
}

async function saveChecklistItemPatch(itemId, patch, { quiet = false } = {}) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/checklist/${encodeURIComponent(itemId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    state.episode = data.episode;
    renderEpisodeChecklist();
    renderStages();
    await loadEpisodes();
    if (!quiet) toast("Episode checklist updated.");
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

function openChecklistItem(itemId) {
  const item = state.episode?.episode_checklist?.items?.find((candidate) => candidate.id === itemId);
  if (!item) return;
  state.editingChecklistItemId = itemId;
  $("#checklist-item-phase").textContent = CHECKLIST_PHASE_LABELS[item.phase] || item.phase;
  $("#checklist-item-title").textContent = item.title;
  $("#checklist-item-description").textContent = item.description;
  $("#checklist-item-status").value = item.status;
  $("#checklist-item-owner").value = item.owner || "";
  $("#checklist-item-notes").value = item.notes || "";
  $("#checklist-item-archive-row").classList.toggle("hidden", item.template_item === true);
  $("#checklist-item-archived").checked = item.archived === true;
  $("#checklist-item-dialog").showModal();
}

async function saveChecklistItem() {
  const itemId = state.editingChecklistItemId;
  if (!itemId) return;
  const saved = await saveChecklistItemPatch(itemId, {
    status: $("#checklist-item-status").value,
    owner: $("#checklist-item-owner").value.trim(),
    notes: $("#checklist-item-notes").value.trim(),
    archived: $("#checklist-item-archived").checked,
  });
  if (saved) {
    state.editingChecklistItemId = null;
    $("#checklist-item-dialog").close();
  }
}

async function addChecklistItem() {
  const title = $("#checklist-new-title").value.trim();
  if (!title) return toast("Enter the new checklist step.", "error");
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/checklist`, {
      method: "POST",
      body: JSON.stringify({
        title,
        phase: $("#checklist-new-phase").value,
        owner: $("#checklist-new-owner").value.trim(),
        description: $("#checklist-new-description").value.trim(),
      }),
    });
    state.episode = data.episode;
    for (const id of ["checklist-new-title", "checklist-new-owner", "checklist-new-description"]) $(`#${id}`).value = "";
    renderEpisodeChecklist();
    await loadEpisodes();
    toast("New episode-specific checklist step added.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function signedMs(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${number}ms`;
}

function renderSync() {
  const sync = state.episode.sync;
  const hasCompanion = (state.episode.intake?.sources || []).length > 1;
  const results = $("#sync-results");
  const analyze = $("#analyze-sync-button");
  const approve = $("#approve-sync-button");
  const reject = $("#reject-sync-button");
  analyze.classList.toggle("hidden", !hasCompanion);
  approve.classList.add("hidden");
  reject.classList.add("hidden");
  if (!hasCompanion) {
    results.innerHTML = '<div class="intake-next-step">Add a companion camera or audio source to measure sync.</div>';
    return;
  }
  if (!sync) {
    results.innerHTML = '<div class="intake-next-step">Compatibility is checked. Waveform offsets and end drift have not been measured.</div>';
    return;
  }
  const review = sync.review || { status: "pending" };
  const rows = (sync.results || []).map((result) => result.status === "blocked"
    ? `<div class="sync-result"><strong>${escapeHtml(result.label)}</strong><span>${escapeHtml(result.error)}</span></div>`
    : `<div class="sync-result"><strong>${escapeHtml(result.label)}</strong><span>start ${signedMs(result.start_offset_ms)}</span><span>end ${signedMs(result.end_offset_ms)}</span><span>drift ${signedMs(result.drift_ms)} · ${escapeHtml(result.status)}</span></div>`
  );
  if (sync.stale || state.episode.intake_stale) {
    results.innerHTML = `<div class="intake-finding blocking">This measurement is expired because the source set changed. Run source checks, then analyze sync again.</div>${rows.join("")}`;
    return;
  }
  results.innerHTML = `${rows.join("")}<div class="intake-next-step">Analysis: ${escapeHtml(sync.status)} · Human review: ${escapeHtml(review.status)}</div>`;
  const reviewable = sync.status === "review_required" && review.status === "pending";
  approve.classList.toggle("hidden", !reviewable);
  reject.classList.toggle("hidden", review.status !== "pending");
}

function timelineMs(value) {
  const number = Math.max(0, Number(value || 0));
  const minutes = Math.floor(number / 60000);
  const seconds = ((number % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}

function renderTimeline() {
  const timeline = state.episode.timeline;
  const hasCompanion = (state.episode.intake?.sources || []).length > 1;
  const syncApproved = state.episode.sync?.review?.status === "approved" && !state.episode.sync?.stale;
  const results = $("#timeline-results");
  const build = $("#build-timeline-button");
  if (!hasCompanion) {
    build.classList.add("hidden");
    results.innerHTML = "";
    return;
  }
  build.classList.toggle("hidden", !syncApproved);
  build.textContent = timeline && !timeline.stale ? "Rebuild aligned timeline" : "Build aligned timeline";
  if (!syncApproved) {
    results.innerHTML = '<div class="intake-next-step">Confirm the waveform measurement before building a reversible timeline.</div>';
    return;
  }
  if (!timeline) {
    results.innerHTML = '<div class="intake-next-step">Sync is confirmed. Build the editable alignment receipt; this will not render or modify media.</div>';
    return;
  }
  if (timeline.stale) {
    results.innerHTML = '<div class="intake-finding blocking">This timeline belongs to an earlier sync review. Rebuild it from the current confirmed measurement.</div>';
    return;
  }
  const tracks = (timeline.tracks || []).map((track) => `
    <div class="timeline-track">
      <strong>${escapeHtml(track.label)}</strong>
      <span>timeline ${timelineMs(track.timeline_start_ms)} → ${timelineMs(track.timeline_end_ms)}</span>
      <span>source in ${timelineMs(track.source_in_ms)}</span>
      <span>rate ${Number(track.alignment?.playback_rate || 1).toFixed(6)}×</span>
    </div>
  `).join("");
  const warnings = (timeline.warnings || []).map((warning) => `<div class="intake-finding">${escapeHtml(warning)}</div>`).join("");
  const previewApproved = state.episode.timeline_preview_review?.status === "approved" && !state.episode.timeline_preview_review?.stale;
  results.innerHTML = `
    <div class="timeline-heading"><strong>Reversible aligned timeline</strong><span>${(timeline.tracks || []).length} tracks · ${previewApproved ? "playback verified · render disabled" : "preview required"}</span></div>
    ${tracks}
    ${warnings}
    <div class="intake-next-step">Playback review: ${escapeHtml(state.episode.timeline_preview_review?.status || "pending")}. No source was changed and no multi-source render is authorized. The editable receipt is saved as timeline.json.</div>
  `;
}

function stopAlignedPreview() {
  clearInterval(state.previewTimer);
  state.previewTimer = null;
  document.querySelectorAll("#aligned-preview-grid video").forEach((video) => video.pause());
}

function previewSourceMs(track, timelineMs) {
  const start = Number(track.timeline_start_ms || 0);
  const end = Number(track.timeline_end_ms || 0);
  if (timelineMs < start || timelineMs > end) return null;
  return Number(track.source_in_ms || 0) + (timelineMs - start) * Number(track.alignment?.playback_rate || 1);
}

function updatePreviewTime(timelineMs, correctPlayback = false) {
  const timeline = state.episode.timeline;
  if (!timeline || timeline.stale) return;
  const time = Math.max(0, Math.min(Number(timeline.reference_duration_ms || 0), Number(timelineMs || 0)));
  $("#preview-scrubber").value = String(Math.round(time));
  $("#preview-time").textContent = timelineMsLabel(time);
  (timeline.tracks || []).filter((track) => track.media_kind === "video").forEach((track) => {
    const video = document.querySelector(`[data-preview-source="${track.source_id}"] video`);
    const card = video?.closest(".preview-track");
    if (!video || !card) return;
    const sourceMs = previewSourceMs(track, time);
    card.classList.toggle("outside", sourceMs === null);
    if (sourceMs === null) {
      video.pause();
      return;
    }
    const sourceSeconds = sourceMs / 1000;
    video.playbackRate = Number(track.alignment?.playback_rate || 1);
    if (!correctPlayback || video.paused || Math.abs(video.currentTime - sourceSeconds) > 0.15) {
      try { video.currentTime = sourceSeconds; } catch {}
    }
    if (correctPlayback && video.paused) video.play().catch(() => {});
  });
}

function timelineMsLabel(value) {
  const number = Math.max(0, Number(value || 0));
  const minutes = Math.floor(number / 60000);
  const seconds = ((number % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}

function renderAlignedPreview() {
  stopAlignedPreview();
  const panel = $("#aligned-preview");
  const timeline = state.episode.timeline;
  const cameras = (timeline?.tracks || []).filter((track) => track.media_kind === "video");
  if (!timeline || timeline.stale || cameras.length < 2) {
    panel.classList.add("hidden");
    $("#aligned-preview-grid").innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  $("#aligned-preview-grid").innerHTML = cameras.map((track) => {
    const browserPreview = state.episode.browser_previews?.[track.source_id];
    const useBrowserPreview = browserPreview?.current === true;
    const mediaUrl = useBrowserPreview
      ? `/api/episodes/${encodeURIComponent(state.episode.slug)}/browser-preview/${encodeURIComponent(track.source_id)}/media`
      : `/api/episodes/${encodeURIComponent(state.episode.slug)}/media/${encodeURIComponent(track.source_id)}`;
    const playbackLabel = useBrowserPreview
      ? `local H.264 browser copy · ${track.source_id === timeline.reference_source_id ? "reference audio" : "muted"}`
      : track.source_id === timeline.reference_source_id
        ? "reference audio"
        : `muted · ${Number(track.alignment?.playback_rate || 1).toFixed(6)}×`;
    return `
      <article class="preview-track" data-preview-source="${escapeHtml(track.source_id)}" data-browser-preview="${useBrowserPreview ? "current" : "source"}">
        <video data-review-source="${escapeHtml(track.source_id)}" preload="metadata" playsinline ${track.source_id === timeline.reference_source_id ? "" : "muted"} src="${mediaUrl}"></video>
        <div class="preview-track-meta"><strong>${escapeHtml(track.label)}</strong><span>${escapeHtml(playbackLabel)}</span></div>
        <div class="browser-preview-recovery hidden">
          <p>${useBrowserPreview ? "The cached browser copy could not play." : "This source is healthy, but its camera codec is not playing in this browser."}</p>
          <button class="ghost-button create-browser-preview-button" data-source-id="${escapeHtml(track.source_id)}" type="button">${useBrowserPreview ? "Rebuild local browser copy" : "Create local browser copy"}</button>
          <small>Local review only. The raw camera and production render source stay unchanged.</small>
        </div>
      </article>
    `;
  }).join("");
  document.querySelectorAll("#aligned-preview-grid video").forEach((video) => {
    video.addEventListener("error", () => {
      const card = video.closest(".preview-track");
      card?.classList.add("outside");
      const detail = card?.querySelector(".preview-track-meta span");
      if (detail) detail.textContent = "browser playback unavailable";
      card?.querySelector(".browser-preview-recovery")?.classList.remove("hidden");
    });
  });
  requestAnimationFrame(applySavedReviewRotations);
  const scrubber = $("#preview-scrubber");
  scrubber.max = String(Math.max(1, Number(timeline.reference_duration_ms || 1)));
  scrubber.value = "0";
  updatePreviewTime(0);
  const saved = state.episode.timeline_preview_review || {};
  const review = saved.stale ? { status: "pending", checked_start: false, checked_end: false } : saved;
  const status = $("#preview-status");
  status.textContent = saved.stale ? "Review expired" : review.status === "approved" ? "Playback verified" : review.status === "rejected" ? "Rejected" : "Review required";
  status.className = `status-badge ${saved.stale ? "stale" : review.status || "pending"}`;
  $("#preview-start-check-button").classList.toggle("checked", Boolean(review.checked_start));
  $("#preview-end-check-button").classList.toggle("checked", Boolean(review.checked_end));
  $("#approve-preview-button").disabled = !(review.checked_start && review.checked_end) || review.status === "approved";
  $("#preview-review-note").textContent = saved.stale
    ? "The earlier playback review belongs to another timeline. Check both ends again."
    : review.status === "approved"
      ? "Both ends were confirmed for this timeline. Multi-source rendering remains disabled."
      : review.status === "rejected"
        ? "Alignment was rejected. Revisit the source or sync measurement before continuing."
        : "Play the shared clap or motion near the start and end, then mark each check.";
}

async function createBrowserPreview(sourceId) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/browser-preview/${encodeURIComponent(sourceId)}`, {
      method: "POST",
      body: "{}",
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function playAlignedPreview() {
  stopAlignedPreview();
  const timeline = state.episode.timeline;
  const position = Number($("#preview-scrubber").value || 0);
  updatePreviewTime(position);
  const videos = [...document.querySelectorAll("#aligned-preview-grid video")];
  await Promise.allSettled(videos.filter((video) => !video.closest(".preview-track").classList.contains("outside")).map((video) => video.play()));
  const referenceTrack = (timeline.tracks || []).find((track) => track.source_id === timeline.reference_source_id);
  const referenceVideo = document.querySelector(`[data-preview-source="${timeline.reference_source_id}"] video`);
  state.previewTimer = setInterval(() => {
    if (!referenceTrack || !referenceVideo || referenceVideo.paused) return stopAlignedPreview();
    const rate = Number(referenceTrack.alignment?.playback_rate || 1);
    const current = Number(referenceTrack.timeline_start_ms || 0)
      + (referenceVideo.currentTime * 1000 - Number(referenceTrack.source_in_ms || 0)) / rate;
    if (current >= Number(timeline.reference_duration_ms || 0)) return stopAlignedPreview();
    updatePreviewTime(current, true);
  }, 250);
}

async function saveTimelinePreview(status, changes = {}) {
  const saved = state.episode.timeline_preview_review || {};
  const current = saved.stale ? {} : saved;
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/timeline-review`, {
      method: "PUT",
      body: JSON.stringify({
        status,
        checked_start: changes.checked_start ?? current.checked_start ?? false,
        checked_end: changes.checked_end ?? current.checked_end ?? false,
        notes: current.notes || "",
      }),
    });
    state.episode = data.episode;
    renderAlignedPreview();
    toast(status === "approved" ? "Aligned playback verified. Multi-source rendering is still disabled." : status === "rejected" ? "Alignment rejected. No source was changed." : "Playback check saved.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderSpeakerTranscript() {
  const receipt = state.episode.speaker_transcript;
  const review = state.episode.speaker_transcript_review || {};
  const readiness = state.episode.speaker_transcript_state || {};
  const results = $("#speaker-transcript-results");
  const build = $("#build-speaker-transcript-button");
  const swap = $("#swap-speaker-roles-button");
  const approve = $("#approve-speaker-transcript-button");
  build.classList.add("hidden");
  swap.classList.add("hidden");
  approve.classList.add("hidden");
  if (!state.episode.intake) {
    results.innerHTML = "";
    return;
  }
  if ((readiness.missing_sources || []).length) {
    results.innerHTML = '<div class="intake-finding blocking">Host 1 + Host 2 isolated audio are required for speaker labels. Studio will not guess speakers from camera audio.</div>';
    return;
  }
  if (readiness.requires_timeline) {
    results.innerHTML = '<div class="intake-next-step">Build the current confirmed timeline before transcribing the isolated host tracks.</div>';
    return;
  }
  build.classList.remove("hidden");
  build.textContent = receipt && !receipt.stale ? "Rebuild speaker transcript" : "Transcribe host tracks";
  if (!receipt) {
    results.innerHTML = '<div class="intake-next-step">Both isolated host tracks are ready. Transcribe them locally and merge them onto the confirmed timeline.</div>';
    return;
  }
  if (receipt.stale) {
    results.innerHTML = '<div class="intake-finding blocking">This speaker transcript belongs to an earlier source set or timeline. Rebuild it before using its labels.</div>';
    return;
  }
  swap.classList.remove("hidden");
  approve.classList.remove("hidden");
  swap.textContent = review.roles_swapped ? "Restore assigned Host labels" : "Swap Host 1 / Host 2 labels";
  const pendingBleedDecisions = Number(state.episode.bleed_review_assistant?.pending_count || 0);
  approve.disabled = (review.status === "approved" && !review.stale) || pendingBleedDecisions > 0;
  approve.title = pendingBleedDecisions > 0
    ? `Resolve ${pendingBleedDecisions} likely cross-mic duplicate${pendingBleedDecisions === 1 ? "" : "s"} with the Studio assistant first.`
    : "";
  const speakers = (receipt.speakers || []).map((speaker) => `${escapeHtml(speaker.speaker_label)} ${Number(speaker.segment_count || 0)} lines`).join(" · ");
  const reviewLabel = review.status === "approved" && !review.stale ? "reviewed" : review.stale ? "review expired" : "review required";
  results.innerHTML = `
    <div class="timeline-heading"><strong>Isolated-audio speaker transcript</strong><span>${escapeHtml(reviewLabel)}</span></div>
    <div class="speaker-transcript-summary">${speakers} · ${Number(receipt.suppressed_bleed_segment_count || 0)} automatic bleed duplicates suppressed · ${pendingBleedDecisions} assistant decision${pendingBleedDecisions === 1 ? "" : "s"} left · ${Number(review.wording_correction_count || 0)} wording fixes · ${Number(review.speaker_correction_count || 0)} speaker fixes · ${Number(review.dismissed_bleed_count || 0)} bleed lines dismissed</div>
    <div class="intake-next-step">Labels come from assigned audio roles, not voice recognition. Use the focused assistant queue for likely duplicates; review an ordinary line only when wording or speaker identity sounds wrong. Confirm the review before selecting clips.</div>
  `;
}

function renderCameraDirection() {
  const results = $("#camera-direction-results");
  const sourceSelect = $("#channel-source-select");
  const validate = $("#validate-channels-button");
  const buildActivity = $("#build-speaker-activity-button");
  const buildPlan = $("#build-camera-plan-button");
  const intakeSources = state.episode.intake?.sources || [];
  const hasAssignedIsolatedPair = ["host_1_audio", "host_2_audio"].every((id) => intakeSources.some((source) => source.id === id));
  const sources = [
    ...(hasAssignedIsolatedPair ? [{ id: "isolated_masters", label: "Two assigned mono transmitter WAVs", audio: { channels: 2 } }] : []),
    ...intakeSources.filter((source) => Number(source.audio?.channels || 0) >= 2),
  ];
  const priorSelection = sourceSelect.value;
  sourceSelect.innerHTML = sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.label)}</option>`).join("");
  if (sources.some((source) => source.id === priorSelection)) sourceSelect.value = priorSelection;
  else if (sources.some((source) => source.id === state.episode.channel_preflight?.source_id)) sourceSelect.value = state.episode.channel_preflight.source_id;
  validate.disabled = !sources.length || state.episode.intake_stale;
  buildActivity.classList.add("hidden");
  buildPlan.classList.add("hidden");
  if (!state.episode.intake) {
    results.innerHTML = "";
    return;
  }
  if (!sources.length) {
    results.innerHTML = '<div class="intake-finding blocking">Attach either one validated stereo receiver recording or both assigned mono transmitter masters.</div>';
    return;
  }
  const channel = state.episode.channel_preflight;
  const activity = state.episode.speaker_activity;
  const plan = state.episode.camera_plan;
  if (!channel) {
    results.innerHTML = hasAssignedIsolatedPair
      ? '<div class="intake-next-step"><strong>Automatic camera direction is locked.</strong> Validate the two assigned transmitter roles first; speaker labels remain human-reviewable.</div>'
      : '<div class="intake-next-step"><strong>Automatic camera direction is locked.</strong> Validate the required 17-second TX1-left / TX2-right slate first.</div>';
    return;
  }
  if (channel.stale) {
    results.innerHTML = '<div class="intake-finding blocking">The channel receipt is stale because the source changed. Validate the slate again.</div>';
    return;
  }
  const checks = Object.entries(channel.checks || {}).map(([name, passed]) => `${passed ? "✓" : "×"} ${name.replaceAll("_", " ")}`).join(" · ");
  if (channel.status !== "passed") {
    results.innerHTML = `<div class="intake-finding blocking"><strong>Channel validation blocked.</strong> ${escapeHtml((channel.blocking || []).join(" "))}</div><div class="speaker-transcript-summary">${escapeHtml(checks)}</div>`;
    return;
  }
  if (state.episode.camera_direction_state?.speaker_activity_eligible) buildActivity.classList.remove("hidden");
  if (state.episode.camera_direction_state?.camera_plan_eligible) buildPlan.classList.remove("hidden");
  const activitySummary = activity && !activity.stale
    ? `${escapeHtml(activity.evidence_mode.replaceAll("_", " "))} · ${Number(activity.segments?.length || 0)} evidence segments`
    : "speaker activity not built";
  const planSummary = plan && !plan.stale
    ? `${Number(plan.shots?.length || 0)} reason-coded shots · review required · render locked`
    : "camera plan not built";
  results.innerHTML = `
    <div class="timeline-heading"><strong>Speaker-aware camera direction</strong><span>${channel.evidence_mode === "assigned_isolated_transmitter_masters" ? "assigned transmitter roles validated" : "channel slate passed"}</span></div>
    <div class="speaker-transcript-summary">${escapeHtml(checks)}</div>
    <div class="speaker-transcript-summary">${activitySummary}</div>
    <div class="speaker-transcript-summary">${planSummary}</div>
    <div class="intake-next-step">Full episodes default to a stable side-by-side edit. A solo cut must be an explicit human editorial choice with a clear reason; speaker changes never trigger one automatically. Social clips keep their separate isolated framing.</div>
  `;
}

function workflowBadge(label, kind) {
  return `<span class="guide-badge ${kind}">${escapeHtml(label)}</span>`;
}

function socialWorkflowCoach({ activeStage, hasCompanion, hasApproved }) {
  const episode = state.episode;
  if (currentEpisodeRender && currentDeliveryAudio && currentDeliveryText) {
    return {
      index: "07",
      title: "Local delivery files are ready",
      description: "The full render, audio-only file, captions, transcript, and chapters are current. Prepare the release copy next. Upload and publication happen outside Studio.",
      target: "release-workspace",
      button: "Open release copy",
      badges: [["Local files ready", "local"], ["No publishing", "approval"]],
    };
  }
  if (activeStage === "source") {
    return {
      index: "01", title: episode.intake_stale ? "Refresh the changed source set" : "Complete source intake",
      description: "Social clips use the same current source receipts as the full episode. Resolve every blocking source or split-audio finding first.",
      target: "source-readiness", button: "Review source issues", badges: [["Shared evidence", "local"]],
    };
  }
  if (activeStage === "alignment") {
    const timelineCurrent = Boolean(episode.timeline && !episode.timeline.stale);
    return {
      index: "02", title: timelineCurrent ? "Verify aligned playback" : "Measure and confirm synchronization",
      description: hasCompanion ? "Confirm the shared timing evidence before a clip boundary or speaker label depends on it." : "The single-source recording can continue without companion alignment.",
      target: timelineCurrent ? "aligned-preview" : "source-readiness", button: "Open shared alignment", badges: [["Shared evidence", "local"], ["Human approval", "approval"]],
    };
  }
  if (activeStage === "transcript") {
    return {
      index: "03", title: "Correct the shared transcript",
      description: "Fix material wording and confirm speaker roles before selecting moments. Social approvals cannot repair an incorrect transcript later.",
      target: "transcript-panel", button: "Review transcript", badges: [["Shared evidence", "local"], ["Human approval", "approval"]],
    };
  }
  if (activeStage === "assembly") {
    if (!episode.episode_naming?.approved) {
      return {
        index: "04",
        title: "Name and number this episode",
        description: "Prepare the transcript-bound naming request, review title options, and approve one canonical title. Model connection remains a later choice.",
        target: "episode-naming-workspace",
        button: "Open episode naming",
        badges: [["Transcript-bound", "local"], ["Human approval", "approval"]],
      };
    }
    return {
      index: "04", title: "Choose the first complete social moment",
      description: "Use Start and End around one complete thought, then add its working title, opening words, standalone rationale, and optional on-screen hook.",
      target: "transcript-panel", button: "Choose from transcript", badges: [["Social workflow", "local"], ["Editorial judgment", "approval"]],
    };
  }
  if (activeStage === "review") {
    return {
      index: "05", title: "Review and approve a social candidate",
      description: "Preview the exact boundaries and confirm that the clip opens cleanly, resolves its thought, frames the right host, and stands alone.",
      target: "candidate-review-panel", button: "Open candidate queue", badges: [["Social workflow", "local"], ["Human approval", "approval"]],
    };
  }
  const rendered = episode.candidates.filter((candidate) => candidate.review.status === "approved" && candidate.output && !candidate.output.stale).length;
  const watched = episode.candidates.filter((candidate) => candidate.social_render_review?.status === "approved" && !candidate.social_render_review.stale).length;
  const packaged = episode.candidates.filter((candidate) => candidate.social_package_review?.status === "approved" && !candidate.social_package_review.stale).length;
  return {
    index: "06",
    title: episode.social_delivery ? "Local social delivery is ready"
      : packaged ? "Build the versioned local social delivery"
        : watched ? "Approve one three-platform package per clip"
          : rendered ? "Watch every rendered social master" : "Render the approved social candidates",
    description: episode.social_delivery
      ? `${episode.social_delivery.version} contains the approved shared masters, covers, platform cards, release slots, and checksums. Publication remains a separate gate.`
      : packaged ? `${packaged} package${packaged === 1 ? " is" : "s are"} approved. Build a new local version after all three release slots are represented.`
        : watched ? `${watched} master${watched === 1 ? " is" : "s are"} completely watched. Review the shared wording, covers, and unavoidable platform transforms once per clip.`
          : rendered
            ? `${rendered} approved clip${rendered === 1 ? " has" : "s have"} a current local render. Watch each output completely before packaging.`
      : hasApproved ? "Render only approved candidates, then watch every vertical output before treating it as deliverable." : "Approve at least one candidate before rendering.",
    target: "candidate-review-panel", button: rendered ? "Review social outputs" : "Open approved candidates", badges: [["Local vertical render", "local"], ["No publishing", "approval"]],
  };
}

function workflowCoachForEpisode({ activeStage, hasCompanion, hasApproved }) {
  if (state.workflowBranch === "social") return socialWorkflowCoach({ activeStage, hasCompanion, hasApproved });
  const episode = state.episode;
  const assemblyApproved = episode.episode_assembly_review?.status === "approved"
    && !episode.episode_assembly_review?.stale
    && !episode.episode_assembly?.stale;
  const currentProxy = episode.episode_proxy && !episode.episode_proxy.stale;
  const proxyApproved = episode.episode_proxy_review?.status === "approved"
    && !episode.episode_proxy_review?.stale;
  const currentEpisodeRender = episode.episode_render && !episode.episode_render.stale;
  const currentDeliveryAudio = episode.delivery_audio && !episode.delivery_audio.stale;
  const currentDeliveryText = episode.delivery_text && !episode.delivery_text.stale;
  if (assemblyApproved && !currentProxy && episode.episode_assembly_state?.proxy_eligible) {
    return {
      index: "06",
      title: "Render the complete package proxy",
      description: "Create one low-resolution proof containing the opening, program, CTA, divider, and closing before spending time on the full-resolution render.",
      target: "assembly-workspace",
      button: "Open package render",
      badges: [["Local proxy", "local"], ["Watch before full render", "approval"]],
    };
  }
  if (currentProxy && !proxyApproved) {
    return {
      index: "06",
      title: "Watch the complete package",
      description: "The opening, full program, exact CTA moments, divider, camera balance, and closing are ready in one video. Use the review-page jump controls for fast CTA checks, then watch it completely and record the seven checks in Studio.",
      action: "proxy-review",
      button: "Open simple package review",
      badges: [["Exact rendered proxy", "local"], ["Human acceptance", "approval"]],
    };
  }
  if (proxyApproved && !currentEpisodeRender) {
    return {
      index: "06",
      title: "Render the full local episode proof",
      description: "The complete proxy passed its selected acceptance path. Render the same approved recipe as a 3840×2160 4K UHD local master, then review that final output. Publishing remains separate.",
      target: "assembly-workspace",
      button: "Open full render",
      badges: [["Full local render", "local"], ["No publishing", "approval"]],
    };
  }
  if (currentEpisodeRender && !currentDeliveryAudio) {
    return {
      index: "07",
      title: "Create and verify the RSS audio",
      description: "Generate the local audio-only episode from the approved full render. Studio measures integrated loudness and true peak before it marks the file ready.",
      target: "delivery-audio-workspace",
      button: "Open RSS audio delivery",
      badges: [["Local audio render", "local"], ["Measured QC", "approval"]],
    };
  }
  if (currentEpisodeRender && currentDeliveryAudio && !currentDeliveryText) {
    return {
      index: "07",
      title: "Build final captions, transcript, and chapters",
      description: "Review the chapter titles and map the approved speaker transcript onto the exact opening, program, and closing timeline.",
      target: "delivery-text-workspace",
      button: "Open final text delivery",
      badges: [["Final timeline", "local"], ["Human chapter review", "approval"]],
    };
  }
  if (activeStage === "source") {
    return {
      index: "01",
      title: episode.intake_stale ? "Refresh the changed source set" : "Resolve source intake before editing",
      description: episode.intake_stale
        ? "A recording changed or moved. Re-run intake so every later receipt is bound to the current local bytes."
        : "Read the blocking source finding. Add a readable local recording or wait until the file has finished copying.",
      target: "source-readiness",
      button: "Review source issues",
      badges: [["Local processing", "local"]],
    };
  }
  if (activeStage === "alignment") {
    const syncApproved = episode.sync?.review?.status === "approved" && !episode.sync?.stale;
    const timelineCurrent = Boolean(episode.timeline && !episode.timeline.stale);
    const previewCurrent = episode.timeline_preview_review?.status === "approved" && !episode.timeline_preview_review?.stale;
    return {
      index: "02",
      title: !syncApproved ? "Measure and approve synchronization" : !timelineCurrent ? "Build the aligned timeline" : "Verify aligned playback near both ends",
      description: !syncApproved
        ? "Run waveform analysis, check the clap evidence, then confirm or reject the measurement. Analysis alone is not approval."
        : !timelineCurrent
          ? "Create the reversible timing map from the approved sync receipt. This still does not authorize rendering."
          : previewCurrent
            ? "Alignment is current. Continue to transcript review."
            : "Play the camera sources together near the start and end, mark both checks, then confirm the preview.",
      target: timelineCurrent ? "aligned-preview" : "source-readiness",
      button: timelineCurrent ? "Open aligned preview" : "Open alignment controls",
      badges: [["Local analysis", "local"], ["Human approval", "approval"]],
    };
  }
  if (activeStage === "transcript") {
    return {
      index: "03",
      title: "Correct and confirm the transcript",
      description: hasCompanion
        ? "Review wording and speaker evidence. Use isolated host tracks when available; Studio will not guess speaker identity from camera audio."
        : "Review the generated wording, make any corrections, and confirm the transcript context before selecting clips.",
      target: "transcript-panel",
      button: "Review transcript",
      badges: [["Local transcript", "local"], ["Human approval", "approval"]],
    };
  }
  if (activeStage === "assembly") {
    return {
      index: "04",
      title: "Build and approve the episode recipe",
      description: "Apply the source-bound camera plan, inherit only the approved show defaults you want, review representative switches, then save and approve the recipe.",
      target: "assembly-workspace",
      button: "Open episode assembly",
      badges: [["Reversible recipe", "local"], ["Human approval", "approval"]],
    };
  }
  if (activeStage === "review") {
    const hasCandidates = episode.candidates.length > 0;
    return {
      index: "05",
      title: hasCandidates ? "Review and approve a clip candidate" : "Choose the first complete thought",
      description: hasCandidates
        ? "Preview the candidate, verify its opening, end, title, crop, and standalone value, then approve or reject it."
        : "In the transcript choose Start on the first line and End on the last. Finish the clip card, then review it before approval.",
      target: hasCandidates ? "candidate-review-panel" : "transcript-panel",
      button: hasCandidates ? "Open candidate queue" : "Choose from transcript",
      badges: [["Editorial judgment", "approval"]],
    };
  }
  if (activeStage === "render") {
    return {
      index: "06",
      title: "Render and watch the approved output",
      description: hasApproved
        ? "Render from the current approved candidate or assembly receipt, then watch the result before treating it as a deliverable."
        : "Approve at least one candidate before rendering.",
      target: hasApproved ? "candidate-review-panel" : "assembly-workspace",
      button: hasApproved ? "Open approved outputs" : "Review assembly",
      badges: [["Local render", "local"], ["Watch before export", "approval"]],
    };
  }
  return {
    index: "07",
    title: "Review the finished outputs",
    description: "Approved outputs stay in the local work folder. Copying, uploading, and publishing happen outside Studio.",
    target: "candidate-review-panel",
    button: "Open approved outputs",
    badges: [["Local files", "local"], ["No publishing", "approval"]],
  };
}

function renderWorkflowCoach(context) {
  const action = workflowCoachForEpisode(context);
  state.workflowNextAction = action;
  $("#workflow-coach-index").textContent = action.index;
  $("#workflow-coach-title").textContent = action.title;
  $("#workflow-coach-description").textContent = action.description;
  $("#workflow-coach-badges").innerHTML = action.badges.map(([label, kind]) => workflowBadge(label, kind)).join("");
  $("#workflow-next-button").textContent = action.button;
}

function applyWorkflowView() {
  const episodeView = $("#episode-view");
  if (!episodeView || episodeView.classList.contains("hidden")) return;
  const focused = state.workflowView === "focus";
  const stage = state.focusedStage || state.recommendedStage || "source";
  episodeView.classList.toggle("workflow-focus-view", focused);
  episodeView.classList.toggle("workflow-branch-episode", state.workflowBranch === "episode");
  episodeView.classList.toggle("workflow-branch-social", state.workflowBranch === "social");
  episodeView.dataset.workflowStage = stage;
  document.querySelectorAll("[data-workflow-panel]").forEach((panel) => {
    const branch = panel.dataset.workflowBranch || "shared";
    const branchVisible = branch === "shared" || branch === state.workflowBranch;
    const stages = String(panel.dataset.workflowPanel || "").split(/\s+/).filter(Boolean);
    let panelStage = stage;
    if (branch === "shared" && state.workflowBranch === "social") {
      if (stage === "assembly") panelStage = "transcript";
      if (stage === "render") panelStage = "review";
    }
    if (branch === "episode" && ["review", "render"].includes(stage)) panelStage = "assembly";
    panel.classList.toggle("workflow-stage-hidden", !branchVisible || (focused && !stages.includes(panelStage)));
  });
  document.querySelectorAll(".stage[data-stage]").forEach((button) => {
    const selected = focused && button.dataset.stage === stage;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const toggle = $("#workflow-view-toggle");
  toggle.textContent = focused ? "Show all steps" : "Focus on one step";
  toggle.setAttribute("aria-pressed", String(!focused));
  const clipActionVisible = state.workflowBranch === "social" && (!focused || ["transcript", "assembly", "review", "render"].includes(stage));
  $("#add-candidate-button").classList.toggle("workflow-action-hidden", !clipActionVisible);
}

const WORKFLOW_STAGE_COPY = {
  episode: [
    ["Sources", "source-readiness"], ["Sync", "aligned-preview"], ["Transcript", "transcript-panel"],
    ["Assemble", "episode-naming-workspace"], ["Package review", "assembly-workspace"], ["Delivery", "delivery-text-workspace"],
  ],
  social: [
    ["Sources", "source-readiness"], ["Sync", "aligned-preview"], ["Transcript", "transcript-panel"],
    ["Select moments", "transcript-panel"], ["Review clips", "candidate-review-panel"], ["Render & review", "candidate-review-panel"],
  ],
};

function renderWorkflowBranch() {
  const branch = state.workflowBranch;
  document.querySelectorAll("[data-workflow-branch-choice]").forEach((button) => {
    const selected = button.dataset.workflowBranchChoice === branch;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll(".stage[data-stage]").forEach((button, index) => {
    const [label, target] = WORKFLOW_STAGE_COPY[branch][index];
    button.querySelector("strong").textContent = label;
    button.dataset.scrollTarget = target;
  });
}

function selectWorkflowBranch(branch) {
  if (!["episode", "social"].includes(branch)) return;
  state.workflowBranch = branch;
  state.focusedStage = null;
  renderWorkflowBranch();
  renderStages();
  toast(branch === "social" ? "Social Clips is now the active workflow. Shared source and transcript evidence stays the same." : "Full Episode is now the active workflow. Social candidate approvals stay separate.");
}

function renderOperatorIdentity() {
  const operator = state.operator;
  const select = $("#social-operator-select");
  if (operator?.operator_id) select.value = operator.operator_id;
  const status = $("#social-operator-status");
  status.textContent = operator ? `${operator.display_name} · local only` : "Required to contribute";
  status.className = `status-badge ${operator ? "approved" : "pending"}`;
}

async function loadOperatorIdentity() {
  const data = await api("/api/operator");
  state.operator = data.operator;
  renderOperatorIdentity();
}

async function saveOperatorIdentity() {
  const operatorId = $("#social-operator-select").value;
  if (!operatorId) return toast("Choose Host 1 or Host 2 first.", "error");
  try {
    const data = await api("/api/operator", {
      method: "PUT",
      body: JSON.stringify({ operator_id: operatorId }),
    });
    state.operator = data.operator;
    renderOperatorIdentity();
    if (state.episode) {
      renderTranscript();
      renderCandidates();
    }
    toast(`${data.operator.display_name} is now the local contributor identity.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderSocialWorkflow() {
  const candidates = state.episode?.candidates || [];
  const approved = candidates.filter((candidate) => candidate.review.status === "approved");
  const rendered = approved.filter((candidate) => candidate.output && !candidate.output.stale);
  const watched = approved.filter((candidate) => candidate.social_render_review?.status === "approved" && !candidate.social_render_review.stale);
  const packaged = approved.filter((candidate) => candidate.social_package_review?.status === "approved" && !candidate.social_package_review.stale);
  $("#social-select-count").textContent = `${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`;
  $("#social-review-count").textContent = `${approved.length} approved`;
  $("#social-render-count").textContent = `${watched.length} watched`;
  $("#social-package-count").textContent = `${packaged.length} packaged`;
  $("#social-delivery-count").textContent = state.episode.social_delivery ? state.episode.social_delivery.version : "Not ready";
  $("#social-step-select").classList.toggle("complete", candidates.length > 0);
  $("#social-step-review").classList.toggle("complete", approved.length > 0);
  $("#social-step-render").classList.toggle("complete", watched.length > 0);
  $("#social-step-package").classList.toggle("complete", packaged.length > 0);
  $("#social-step-delivery").classList.toggle("complete", Boolean(state.episode.social_delivery));
  const status = $("#social-workflow-status");
  status.textContent = state.episode.social_delivery ? `${state.episode.social_delivery.version} local delivery ready`
    : packaged.length ? "Ready for local delivery"
      : watched.length ? "Packaging required"
        : rendered.length ? "Complete watches required"
          : approved.length ? "Ready to render" : candidates.length ? "Review required" : "Not started";
  status.className = `status-badge ${state.episode.social_delivery ? "ready" : approved.length ? "attention" : "pending"}`;
  const ready = reviewContextReady();
  const contributionReady = ready && Boolean(state.operator?.operator_id);
  $("#social-add-candidate-button").disabled = !contributionReady;
  $("#social-choose-transcript-button").disabled = !contributionReady;
  $("#social-generate-suggestions-button").disabled = !contributionReady || state.episode.social_state?.suggestions_current;
  $("#social-generate-suggestions-button").textContent = state.episode.social_state?.suggestions_current
    ? `${state.episode.social_suggestions?.suggestions?.length || 0} local suggestions ready` : "Generate up to 6 suggestions";
  $("#social-build-delivery-button").disabled = !(packaged.length === 3 || ($("#social-quality-over-quota")?.checked && packaged.length > 0));
  $("#social-delivery-summary").innerHTML = state.episode.social_delivery
    ? `<strong>${escapeHtml(state.episode.social_delivery.version)} ready</strong><span>${escapeHtml(state.episode.social_delivery.editorial_master_count)} shared masters · ${escapeHtml(state.episode.social_delivery.destination_count)} platform cards · local only</span>`
    : `<strong>${packaged.length} of 3 packages approved</strong><span>Target: three distinct masters scheduled for episode day, day 5, and day 10.</span>`;
  renderOperatorIdentity();
}

function selectWorkflowStage(stage, { scroll = true } = {}) {
  state.workflowView = "focus";
  state.focusedStage = stage;
  applyWorkflowView();
  if (!scroll) return;
  const button = document.querySelector(`.stage[data-stage="${CSS.escape(stage)}"]`);
  if (button?.dataset.scrollTarget) scrollToWorkflowTarget(button.dataset.scrollTarget, { preserveStage: true });
}

function toggleWorkflowView() {
  state.workflowView = state.workflowView === "focus" ? "overview" : "focus";
  if (state.workflowView === "focus" && !state.focusedStage) state.focusedStage = state.recommendedStage || "source";
  applyWorkflowView();
  toast(state.workflowView === "focus" ? "Focused view shows one production step at a time." : "Overview shows every production step.");
}

function scrollToWorkflowTarget(targetId, { preserveStage = false } = {}) {
  let target = document.getElementById(targetId);
  if (!target || target.classList.contains("hidden")) target = document.getElementById("source-readiness");
  if (!preserveStage && state.workflowView === "focus") {
    const stage = ({ "01": "source", "02": "alignment", "03": "transcript", "04": "assembly", "05": "review", "06": "render" })[state.workflowNextAction?.index];
    if (stage) {
      state.focusedStage = stage;
      applyWorkflowView();
      target = document.getElementById(targetId) || target;
    }
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("workflow-focus");
  window.requestAnimationFrame(() => target.classList.add("workflow-focus"));
  window.setTimeout(() => target.classList.remove("workflow-focus"), 1500);
}

function openStudioGuide() {
  const dialog = $("#studio-guide-dialog");
  if (!dialog.open) dialog.showModal();
}

function runWorkflowNextAction() {
  const action = state.workflowNextAction;
  if (!action) return openStudioGuide();
  if (action.action === "proxy-review") {
    window.open(`/proxy_review.html?episode=${encodeURIComponent(state.activeSlug)}`, "_blank", "noopener");
    return;
  }
  scrollToWorkflowTarget(action.target);
}

function openGuideDestination(openDestination) {
  $("#studio-guide-dialog").close();
  openDestination();
}

function renderStages() {
  const episode = state.episode;
  const blocked = episode.intake_stale
    || episode.intake?.compatibility?.status === "blocked"
    || ["blocked", "failed", "not_run", "pending"].includes(episode.intake?.transcription?.status);
  const sources = episode.intake?.sources || [];
  const hasCompanion = sources.length > 1;
  const hasCameraPair = sources.filter((source) => source.expected_kind === "video").length > 1;
  const hasAssignedIsolatedPair = ["host_1_audio", "host_2_audio"].every((id) => sources.some((source) => source.id === id));
  const sourceComplete = !blocked;
  const alignedPlaybackComplete = episode.timeline_preview_review?.status === "approved"
    && !episode.timeline_preview_review?.stale;
  const channelValidationComplete = episode.channel_preflight?.status === "passed"
    && !episode.channel_preflight?.stale;
  const speakerActivityComplete = Boolean(episode.speaker_activity && !episode.speaker_activity.stale);
  const alignmentComplete = !hasCompanion
    || (hasCameraPair
      ? alignedPlaybackComplete && channelValidationComplete && speakerActivityComplete
      : Boolean(episode.timeline && !episode.timeline.stale));
  const hasTranscript = episode.transcript.some((cue) => !cue.dismissed_as_bleed);
  const isolatedTranscriptComplete = episode.speaker_transcript_review?.status === "approved"
    && !episode.speaker_transcript_review?.stale;
  const transcriptComplete = hasTranscript && episode.transcript_review_ready
    && (!hasAssignedIsolatedPair || isolatedTranscriptComplete);
  const assemblyComplete = episode.episode_assembly_review?.status === "approved"
    && !episode.episode_assembly_review?.stale
    && !episode.episode_assembly?.stale;
  const hasApproved = reviewContextReady() && episode.candidates.some((candidate) => candidate.review.status === "approved");
  const hasRender = Boolean(episode.episode_render && !episode.episode_render.stale)
    || episode.candidates.some((candidate) => candidate.review.status === "approved" && candidate.output && !candidate.output.stale);
  const fullRenderComplete = Boolean(episode.episode_render && !episode.episode_render.stale);
  const deliveryComplete = Boolean(episode.delivery_audio && !episode.delivery_audio.stale && episode.delivery_text && !episode.delivery_text.stale);
  const socialCandidatesComplete = episode.candidates.length > 0;
  const socialReviewComplete = hasApproved;
  const socialRenderComplete = Boolean(episode.social_delivery);
  const branchSteps = state.workflowBranch === "social"
    ? { assembly: socialCandidatesComplete, review: socialReviewComplete, render: socialRenderComplete }
    : { assembly: assemblyComplete, review: fullRenderComplete, render: deliveryComplete };
  const activeStage = !sourceComplete
    ? "source"
    : !alignmentComplete
      ? "alignment"
      : !transcriptComplete
        ? "transcript"
        : !branchSteps.assembly
          ? "assembly"
          : !branchSteps.review
            ? "review"
            : !branchSteps.render ? "render" : null;
  state.recommendedStage = activeStage || "render";
  if (!state.focusedStage) state.focusedStage = state.recommendedStage;
  const stageClass = (name, complete) => `stage ${complete ? "complete" : activeStage === name ? "active" : ""}`;
  $("#stage-source").className = stageClass("source", sourceComplete);
  $("#stage-alignment").className = stageClass("alignment", alignmentComplete);
  $("#stage-transcript").className = stageClass("transcript", transcriptComplete);
  $("#stage-assembly").className = stageClass("assembly", branchSteps.assembly);
  $("#stage-review").className = stageClass("review", branchSteps.review);
  $("#stage-render").className = stageClass("render", branchSteps.render);
  renderWorkflowCoach({ activeStage, hasCompanion, hasApproved });
  applyWorkflowView();
}

function primaryReviewMediaUrl(episode) {
  const primarySourceId = (episode.intake?.sources || []).find((source) => source.id === "primary_camera")?.id || "primary_camera";
  const browserPreview = episode.browser_previews?.[primarySourceId];
  return browserPreview?.current
    ? `/api/episodes/${encodeURIComponent(episode.slug)}/browser-preview/${encodeURIComponent(primarySourceId)}/media`
    : `/api/episodes/${encodeURIComponent(episode.slug)}/media`;
}

function renderEpisode() {
  const episode = state.episode;
  renderProductionWorkflow(episode, { api, toast, pollJob, operatorChanged: loadOperatorIdentity, activate: (stepId, allControls) => {
    document.body.classList.toggle('production-focused', !allControls);
    document.body.dataset.productionStage = stepId;
    if (!episode.recovery) {
      state.workflowView = allControls ? 'overview' : 'focus';
      state.workflowBranch = stepId === 'social' ? 'social' : 'episode';
      state.focusedStage = ({intake:'source',continuity:'alignment',finishing:'assembly',ctas:'assembly',review:'review',final:'render',release:'render',social:'transcript',learning:'render'})[stepId];
      renderWorkflowBranch();
      applyWorkflowView();
    }
    document.querySelectorAll('#recovery-workspace video, #recovery-workspace audio, #episode-view video, #episode-view audio').forEach(media => {
      if (!media.getClientRects().length) media.pause();
    });
  } });
  if (episode.recovery) {
    renderRecoveryWorkspace(episode, { api, openEpisode, pollJob, toast });
    renderNumberedOpeningControl(episode, { api, openEpisode, pollJob, toast });
    renderOpeningTransitionControl(episode, { api, pollJob, toast });
    renderClosingTransitionControl(episode, { api, pollJob, toast });
    renderEpisodeNav();
    return;
  }
  $("#recovery-workspace").querySelectorAll("video").forEach(video => video.pause());
  $("#recovery-workspace").classList.add("hidden");
  $("#welcome-view").classList.add("hidden");
  $("#episode-view").classList.remove("hidden");
  $("#episode-title").textContent = episode.episode_title || episode.source_name;
  $("#episode-meta").textContent = `${formatDuration(episode.duration_sec)} · ${episode.transcript.length} transcript lines · ${episode.model || "local transcription"} · source ${episode.source_name}`;
  $("#add-candidate-button").disabled = !candidateContributionReady();
  $("#add-candidate-button").title = candidateContributionReady() ? "" : "Choose this machine's operator and confirm the current transcript before adding candidates";
  renderEpisodeChecklist();
  renderWorkflowBranch();
  renderSocialWorkflow();
  const video = $("#source-video");
  const fallback = $("#video-fallback");
  if (episode.source_available) {
    video.src = primaryReviewMediaUrl(episode);
    video.classList.remove("hidden");
    fallback.classList.add("hidden");
    video.onerror = () => {
      video.classList.add("hidden");
      fallback.classList.remove("hidden");
    };
  } else {
    video.removeAttribute("src");
    video.classList.add("hidden");
    fallback.classList.remove("hidden");
  }
  renderSourceReadiness();
  renderAlignedPreview();
  renderStages();
  renderTranscript();
  renderCtaCues();
  renderEpisodeNaming();
  renderEpisodeAssembly();
  renderNumberedOpeningControl(episode, { api, openEpisode, pollJob, toast });
  renderCandidates();
  renderEpisodeNav();
}

async function openEpisode(slug) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(slug)}`);
    state.activeSlug = slug;
    state.episode = data.episode;
    history.replaceState(null, "", `/?episode=${encodeURIComponent(slug)}`);
    state.transcriptSelection = null;
    state.workflowView = "focus";
    state.focusedStage = null;
    if (!state.episode.recovery) prepareAssemblyDraft();
    renderEpisode();
  } catch (error) {
    toast(error.message, "error");
  }
}

function seekVideo(timestamp) {
  const video = $("#source-video");
  if (!video.src) return toast("The source recording is not available for preview.", "error");
  video.currentTime = timestampSeconds(timestamp);
  video.play().catch(() => {});
}

function previewCandidate(id) {
  const candidate = state.episode.candidates.find((item) => item.id === id);
  if (candidate) seekVideo(candidate.start);
}

function candidateSegmentIds(start, end) {
  const startSeconds = timestampSeconds(start);
  const endSeconds = timestampSeconds(end);
  return (state.episode?.transcript || [])
    .filter((cue) => !cue.dismissed_as_bleed && timestampSeconds(cue.end) > startSeconds && timestampSeconds(cue.start) < endSeconds)
    .map((cue) => cue.segment_id)
    .filter(Boolean);
}

function defaultCandidate() {
  const cues = (state.episode.transcript || []).filter((cue) => !cue.dismissed_as_bleed);
  const first = cues[0];
  const startSeconds = timestampSeconds(first?.start);
  const end = cues.find((cue) => timestampSeconds(cue.end) >= startSeconds + 30) || cues.at(-1);
  return {
    id: `clip_${String(state.episode.candidates.length + 1).padStart(3, "0")}`,
    start: first?.start || "00:00:00.000",
    end: end?.end || "00:00:30.000",
    title: "",
    hook: first?.text || "",
    rationale: "",
    crop_offset_px: 0,
    hook_overlay: "",
    segment_ids: candidateSegmentIds(first?.start || "00:00:00.000", end?.end || "00:00:30.000"),
    category: "explainer",
  };
}

function updateCandidatePreview() {
  const video = $("#candidate-preview-video");
  const frame = $("#candidate-preview-frame");
  const cropOffset = Number($("#candidate-crop").value || 0);
  const scale = video.videoHeight ? frame.clientHeight / video.videoHeight : 0;
  video.style.left = `calc(50% + ${(-cropOffset * scale).toFixed(2)}px)`;
  $("#candidate-preview-hook").textContent = $("#candidate-overlay").value.trim() || "Optional hook zone";
  $("#candidate-preview-caption").textContent = $("#candidate-hook").value.trim() || "Caption zone from reviewed transcript";
}

function prepareCandidatePreview(candidate) {
  const video = $("#candidate-preview-video");
  const button = $("#candidate-preview-play-button");
  video.pause();
  button.textContent = "Preview at start";
  button.disabled = !state.episode?.source_available;
  if (!state.episode?.source_available) {
    video.removeAttribute("src");
    $("#candidate-preview-note").textContent = "The source is unavailable in this browser. Crop and text guides remain visible; no render was attempted.";
    updateCandidatePreview();
    return;
  }
  video.src = primaryReviewMediaUrl(state.episode);
  video.onloadedmetadata = () => {
    video.currentTime = Math.min(timestampSeconds(candidate.start), Math.max(0, video.duration || 0));
    updateCandidatePreview();
  };
  video.ontimeupdate = () => {
    if (video.currentTime >= timestampSeconds($("#candidate-end").value.trim())) {
      video.pause();
      button.textContent = "Preview at start";
    }
  };
  $("#candidate-preview-note").textContent = "This browser mask matches Studio's center crop and current text positions. It is not a rendered output or platform-device receipt.";
}

function toggleCandidatePreview() {
  const video = $("#candidate-preview-video");
  if (!video.src) return toast("The source recording is not available for preview.", "error");
  if (video.paused) {
    video.currentTime = timestampSeconds($("#candidate-start").value.trim());
    video.play().then(() => {
      $("#candidate-preview-play-button").textContent = "Pause preview";
    }).catch(() => toast("The browser could not play this source format.", "error"));
  } else {
    video.pause();
    $("#candidate-preview-play-button").textContent = "Preview at start";
  }
}

function openCandidateDialog(id = null, seed = null) {
  if (!state.operator?.operator_id) return toast("Choose Host 1 or Host 2 as this machine's operator first.", "error");
  const candidate = id
    ? state.episode.candidates.find((item) => item.id === id)
    : seed || defaultCandidate();
  if (!candidate) return;
  state.editingId = id;
  $("#candidate-dialog-title").textContent = id ? "Edit candidate" : "Add a candidate";
  $("#candidate-id").value = candidate.id;
  $("#candidate-start").value = candidate.start;
  $("#candidate-end").value = candidate.end;
  $("#candidate-title").value = candidate.title;
  $("#candidate-hook").value = candidate.hook;
  $("#candidate-rationale").value = candidate.rationale;
  $("#candidate-overlay").value = candidate.hook_overlay || "";
  $("#candidate-crop").value = candidate.crop_offset_px ?? 0;
  $("#candidate-category").value = candidate.category || "explainer";
  prepareCandidatePreview(candidate);
  updateCandidatePreview();
  if (!$("#candidate-dialog").open) $("#candidate-dialog").showModal();
}

function cleanCandidate(candidate) {
  const result = {
    id: candidate.id,
    start: candidate.start,
    end: candidate.end,
    title: candidate.title,
    hook: candidate.hook,
    rationale: candidate.rationale,
    crop_offset_px: Number(candidate.crop_offset_px || 0),
    segment_ids: Array.isArray(candidate.segment_ids) ? candidate.segment_ids : candidateSegmentIds(candidate.start, candidate.end),
    category: candidate.category || "explainer",
  };
  if (String(candidate.hook_overlay || "").trim()) result.hook_overlay = candidate.hook_overlay.trim();
  for (const field of ["proposed_by", "proposed_at", "origin", "cluster_id", "recommendation"]) {
    if (candidate[field]) result[field] = candidate[field];
  }
  for (const field of ["signals", "flags", "boundary_notes", "speaker_balance"]) {
    if (Array.isArray(candidate[field])) result[field] = candidate[field];
  }
  return result;
}

async function saveCandidate() {
  const existing = state.editingId ? state.episode.candidates.find((item) => item.id === state.editingId) : null;
  const candidate = cleanCandidate({
    ...(existing || {}),
    id: $("#candidate-id").value,
    start: $("#candidate-start").value.trim(),
    end: $("#candidate-end").value.trim(),
    title: $("#candidate-title").value.trim(),
    hook: $("#candidate-hook").value.trim(),
    rationale: $("#candidate-rationale").value.trim(),
    crop_offset_px: $("#candidate-crop").value,
    hook_overlay: $("#candidate-overlay").value,
    category: $("#candidate-category").value,
    segment_ids: candidateSegmentIds($("#candidate-start").value.trim(), $("#candidate-end").value.trim()),
  });
  const clips = state.episode.candidates.map(cleanCandidate);
  const index = clips.findIndex((item) => item.id === candidate.id);
  if (index >= 0) clips[index] = candidate;
  else clips.push(candidate);
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/clips`, {
      method: "PUT",
      body: JSON.stringify({
        schema: "eaol-clips-v2",
        selected_by: `${state.operator.display_name} via Studio · ${new Date().toLocaleDateString()}`,
        clips,
      }),
    });
    state.episode = data.episode;
    state.transcriptSelection = null;
    $("#candidate-dialog").close();
    renderCandidates();
    toast("Candidate saved and checked.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openCandidateReview(id) {
  if (!state.operator?.operator_id) return toast("Choose Host 1 or Host 2 as this machine's operator first.", "error");
  const candidate = state.episode.candidates.find((item) => item.id === id);
  if (!candidate) return;
  state.reviewingCandidateId = id;
  $("#candidate-review-title").textContent = candidate.title;
  $("#candidate-review-context").textContent = `${contributorLabel(candidate.proposed_by)} proposal · ${categoryLabel(candidate.category)} · ${formatDuration(timestampSeconds(candidate.end) - timestampSeconds(candidate.start))}`;
  $("#candidate-review-status").value = ["approved", "needs_discussion", "rejected"].includes(candidate.review.status) ? candidate.review.status : "approved";
  $("#candidate-review-notes").value = "";
  const video = $("#candidate-review-video");
  video.src = primaryReviewMediaUrl(state.episode);
  video.onloadedmetadata = () => {
    video.currentTime = timestampSeconds(candidate.start);
    video.play().catch(() => {});
  };
  video.ontimeupdate = () => {
    if (video.currentTime >= timestampSeconds(candidate.end)) video.pause();
  };
  $("#candidate-review-evidence").innerHTML = [
    ...(candidate.signals || []).map((item) => `<span><strong>Why surfaced:</strong> ${escapeHtml(item)}</span>`),
    ...(candidate.flags || []).map((item) => `<span><strong>Listen for:</strong> ${escapeHtml(item)}</span>`),
    `<span><strong>Evidence:</strong> ${escapeHtml(summarizeEvidenceIds(candidate.segment_ids || []))} · ${escapeHtml(candidate.cluster_id || "human-selected idea")}</span>`,
  ].join("");
  $("#candidate-review-dialog").showModal();
}

async function reviewCandidate(id, status, notes = "") {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/review/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ status, notes }),
    });
    state.episode = data.episode;
    renderCandidates();
    await loadEpisodes();
    toast(status === "approved"
      ? "Candidate approved for local rendering only."
      : status === "needs_discussion"
        ? "Candidate marked for host discussion. The note is preserved."
        : status === "rejected" ? "Candidate rejected and preserved in the inbox." : "Candidate returned to proposed.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveCandidateReview() {
  const id = state.reviewingCandidateId;
  if (!id) return;
  const status = $("#candidate-review-status").value;
  const notes = $("#candidate-review-notes").value.trim();
  if (status === "needs_discussion" && !notes) return toast("Add the question or disagreement before saving.", "error");
  await reviewCandidate(id, status, notes);
  $("#candidate-review-dialog").close();
  state.reviewingCandidateId = null;
  const next = state.episode.candidates.find((candidate) => ["suggested", "proposed"].includes(candidate.review.status));
  if (next) window.setTimeout(() => openCandidateReview(next.id), 120);
}

async function generateSocialSuggestions() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/social-suggestions`, { method: "POST", body: "{}" });
    state.episode = data.episode;
    renderCandidates();
    await loadEpisodes();
    const next = state.episode.candidates.find((candidate) => candidate.review.status === "suggested");
    const count = data.suggestions?.suggestions?.length || state.episode.social_suggestions?.suggestions?.length || 0;
    toast(data.reused ? `${count} current local suggestions are already available.` : `${count} local suggestions are ready. Review begins at the first clip; fewer strong moments are fine.`);
    if (next) window.setTimeout(() => openCandidateReview(next.id), 120);
  } catch (error) {
    toast(error.message, "error");
  }
}

function resetSocialRenderWatch() {
  state.socialRenderCompleteWatch = false;
  state.socialRenderWatchMax = 0;
  $("#social-render-review-progress").textContent = "Complete watch not yet observed in this review.";
  $("#approve-social-render-button").disabled = true;
}

function updateSocialRenderApproval() {
  const checks = [...document.querySelectorAll("[data-social-render-check]")];
  $("#approve-social-render-button").disabled = !(state.socialRenderCompleteWatch && checks.every((item) => item.checked));
}

function openSocialRenderReview(id) {
  const candidate = state.episode.candidates.find((item) => item.id === id);
  if (!candidate?.social_render || candidate.social_render.stale) return toast("Render the current clip first.", "error");
  state.reviewingSocialRenderId = id;
  $("#social-render-review-title").textContent = candidate.title;
  $("#social-render-review-warnings").textContent = (candidate.social_render.warnings || []).join(" ");
  $("#social-render-review-notes").value = "";
  document.querySelectorAll("[data-social-render-check]").forEach((item) => { item.checked = false; });
  resetSocialRenderWatch();
  const video = $("#social-render-review-video");
  video.src = `/api/episodes/${encodeURIComponent(state.activeSlug)}/social-media/${encodeURIComponent(id)}`;
  video.onloadedmetadata = () => {
    video.currentTime = 0;
    video.play().catch(() => {});
  };
  video.onseeking = () => {
    if (video.currentTime > Number(state.socialRenderWatchMax || 0) + 1.25) resetSocialRenderWatch();
  };
  video.ontimeupdate = () => {
    if (video.currentTime <= Number(state.socialRenderWatchMax || 0) + 1.25) {
      state.socialRenderWatchMax = Math.max(Number(state.socialRenderWatchMax || 0), video.currentTime);
    }
  };
  video.onended = () => {
    if (Number(state.socialRenderWatchMax || 0) >= Number(video.duration || 0) - 1.25) {
      state.socialRenderCompleteWatch = true;
      $("#social-render-review-progress").textContent = "Complete beginning-to-end watch observed for this exact local file.";
      updateSocialRenderApproval();
    }
  };
  $("#social-render-review-dialog").showModal();
}

async function saveSocialRenderReview(status) {
  const id = state.reviewingSocialRenderId;
  if (!id) return;
  const checks = Object.fromEntries([...document.querySelectorAll("[data-social-render-check]")]
    .map((item) => [item.dataset.socialRenderCheck, item.checked]));
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/social-render-review/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        status,
        complete_watch: state.socialRenderCompleteWatch,
        checks,
        notes: $("#social-render-review-notes").value.trim(),
      }),
    });
    state.episode = data.episode;
    $("#social-render-review-dialog").close();
    renderCandidates();
    toast(status === "approved" ? "Exact social master approved for packaging." : "Social render rejected; the source plan and receipt are preserved.");
    state.reviewingSocialRenderId = null;
  } catch (error) {
    toast(error.message, "error");
  }
}

function socialPackageInput() {
  return {
    public_episode_url: $("#social-package-url").value.trim(),
    caption: $("#social-package-caption").value.trim(),
    hashtags: $("#social-package-hashtags").value.trim().split(/[\s,]+/).filter(Boolean),
    cover_headline: $("#social-package-cover").value.trim(),
    release_slot: $("#social-package-release-slot").value,
    tiktok_bio_link_available: $("#social-package-tiktok-link").checked,
  };
}

function renderSocialPackagePreview() {
  const input = socialPackageInput();
  const tags = input.hashtags.join(" ");
  const url = input.public_episode_url || "[specific YouTube episode URL required]";
  const cards = [
    ["YouTube Shorts", `${input.caption}\n\nWatch the full episode: ${url}\n\n${tags}`],
    ["Instagram Reels", `${input.caption}\n\nFull episode via the link in bio.\n\n${tags}`],
    ["TikTok", `${input.caption}\n\n${input.tiktok_bio_link_available ? "Full episode via the link in bio." : `Watch the full episode: ${url}`}\n\n${tags}`],
  ];
  $("#social-package-preview").innerHTML = cards.map(([name, copy]) => `<article><strong>${name}</strong><small>Same master · required funnel transform only</small><p>${escapeHtml(copy)}</p></article>`).join("");
}

function openSocialPackage(id) {
  const candidate = state.episode.candidates.find((item) => item.id === id);
  if (!candidate?.social_render_review || candidate.social_render_review.stale || candidate.social_render_review.status !== "approved") {
    return toast("Approve the complete rendered master first.", "error");
  }
  state.packagingCandidateId = id;
  const prior = candidate.social_package && !candidate.social_package.stale ? candidate.social_package : null;
  const approved = state.episode.candidates.filter((item) => item.review.status === "approved");
  const slot = ["day_0", "day_5", "day_10"][Math.max(0, approved.findIndex((item) => item.id === id)) % 3];
  const inheritedUrl = state.episode.candidates.find((item) => item.social_package?.platforms?.youtube_shorts?.related_video_url)?.social_package.platforms.youtube_shorts.related_video_url || "";
  $("#social-package-title").textContent = candidate.title;
  $("#social-package-url").value = prior?.platforms?.youtube_shorts?.related_video_url || inheritedUrl;
  $("#social-package-caption").value = prior?.core_copy?.caption || candidate.hook;
  $("#social-package-hashtags").value = prior?.core_copy?.hashtags?.join(" ") || `${state.show?.show_hashtag || ""} `;
  $("#social-package-cover").value = prior?.cover?.headline || candidate.hook_overlay || candidate.title;
  $("#social-package-release-slot").value = prior?.release_slot || slot;
  $("#social-package-tiktok-link").checked = Boolean(prior?.platforms?.tiktok?.bio_link);
  renderSocialPackagePreview();
  $("#social-package-dialog").showModal();
}

async function saveSocialPackage({ approve = false } = {}) {
  const id = state.packagingCandidateId;
  if (!id) return;
  try {
    let data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/social-package/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(socialPackageInput()),
    });
    state.episode = data.episode;
    if (approve) {
      data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/social-package-review/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({
          status: "approved",
          checks: { master: true, cover: true, core_copy: true, youtube: true, instagram: true, tiktok: true, release_slot: true },
        }),
      });
      state.episode = data.episode;
      $("#social-package-dialog").close();
      renderCandidates();
      toast("One approval now covers the master, covers, core wording, all three platform cards, and release slot.");
      const next = state.episode.candidates.find((item) => item.social_render_review?.status === "approved"
        && !item.social_render_review.stale && !(item.social_package_review?.status === "approved" && !item.social_package_review.stale));
      if (next) window.setTimeout(() => openSocialPackage(next.id), 120);
    } else {
      renderCandidates();
      toast("Three-platform package saved locally. Approval is still required.");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function buildSocialDelivery() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/social-delivery`, {
      method: "POST",
      body: JSON.stringify({
        quality_over_quota: $("#social-quality-over-quota").checked,
        quality_exception_reason: $("#social-quality-exception-reason").value.trim(),
      }),
    });
    state.episode = data.episode;
    renderCandidates();
    toast(`${data.receipt.version} social delivery built locally. No upload, scheduling, or publication action occurred.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function showJob(job) {
  const drawer = $("#job-drawer");
  drawer.classList.remove("hidden");
  drawer.dataset.status = job.status;
  $("#job-title").textContent = job.type === "recovery_import"
    ? "Verifying recovered episode and review evidence"
    : job.type === "recovery_playback"
      ? "Preparing alternate browser playback"
    : job.type === "recovery_preview"
      ? "Rendering a camera draft preview"
    : job.type === "ingest"
    ? "Checking sources and transcribing"
    : job.type === "sync"
      ? "Measuring waveform sync and drift"
    : job.type === "transcribe"
      ? "Transcribing locally"
    : job.type === "speaker_transcript"
      ? "Transcribing isolated host tracks"
    : job.type === "channel_preflight"
      ? "Validating microphone channel slate"
    : job.type === "speaker_activity"
      ? "Building source-bound speaker activity"
    : job.type === "social_render"
      ? "Rendering source-bound social clip"
    : job.type === "browser_preview"
      ? "Creating a browser-compatible camera copy"
    : job.type === "episode_render"
      ? "Rendering the full episode locally"
    : job.type === "episode_proxy"
      ? "Building the complete episode review video"
    : job.type === "episode_proxy_audit"
      ? "Auditing the exact proxy"
    : job.type === "delivery_audio"
      ? "Creating and checking RSS audio"
    : job.type === "opening_transition"
      ? "Rendering the opening transition"
    : job.type === "closing_transition"
      ? "Rendering music beneath the sign-off"
    : job.type === "numbered_opening"
      ? "Rendering the numbered opening"
    : job.type === "show_package_preview"
      ? "Rendering the reusable show package preview"
      : "Rendering approved clip";
  $("#job-status").textContent = job.recovered && job.status === "running" ? "Reattached · running" : job.status;
  $("#job-close-button").classList.toggle("hidden", job.status === "running");
  $("#job-logs").textContent = job.logs.length ? job.logs.join("\n") : "Starting…";
  $("#job-logs").scrollTop = $("#job-logs").scrollHeight;
}

async function pollJob(job) {
  if (state.pollingJobId && state.pollingJobId !== job.id) {
    toast("Another local job is already shown. It will remain safe on disk.", "error");
    return;
  }
  state.pollingJobId = job.id;
  showJob(job);
  if (job.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      const data = await api(`/api/jobs/${job.id}`);
      return pollJob(data.job);
    } catch (error) {
      state.pollingJobId = null;
      throw error;
    }
  }
  state.pollingJobId = null;
  if (["failed", "interrupted"].includes(job.status)) {
    if (job.type === "show_package_preview") {
      await loadShowPackage();
      renderShowPackageDialog();
    }
    await loadEpisodes();
    if (job.slug && state.episodes.some((episode) => episode.slug === job.slug)) await openEpisode(job.slug);
    toast(
      job.error || (job.status === "interrupted"
        ? "The prior result could not be verified. Start the job again; completed phases will be reused."
        : "The local job failed. Review the log for the exact step."),
      "error",
    );
    return;
  }
  toast(job.type === "social_finish" ? "Finished clip created. Watch the exact master and complete its six-part review." : job.type === "social_portable" ? "Finished-video test rendered. Complete human review and closing-line finishing are still required." : job.type === "recovery_import" ? "Recovery imported with scoped decisions. Final master remains unapproved." : job.type === "recovery_playback" ? "Alternate playback ready in Studio." : job.type === "recovery_preview" ? "Camera preview ready for human review." : job.type === "ingest" ? "Source checks and transcription complete." : job.type === "sync" ? "Sync analysis complete. Human confirmation is still required." : job.type === "transcribe" ? "Transcription complete." : job.type === "speaker_transcript" ? "Speaker transcript built. Human review is still required." : job.type === "channel_preflight" ? "microphone channel slate passed. Rendering remains locked." : job.type === "speaker_activity" ? "Source-bound speaker activity built. Rendering remains locked." : job.type === "social_render" ? "Source-bound vertical rendered and technically checked. A complete human watch is still required." : job.type === "browser_preview" ? "Browser-compatible camera copy ready. The raw source is unchanged." : job.type === "episode_proxy" ? "Low-resolution package proxy rendered. Complete its exact review to unlock full rendering." : job.type === "episode_proxy_audit" ? "Exact proxy metadata audit complete. Human spot checks remain required." : job.type === "episode_render" ? "Full episode rendered locally with technical checks. Publication is still separate." : job.type === "delivery_audio" ? "RSS audio created with measured loudness and true peak. Drive and publishing remain separate." : job.type === "cohost_review_handoff" ? "Portable co-host review folder created. External transfer remains separate." : job.type === "delivery_bundle" ? "Versioned delivery bundle created and checksum verified. Upload and publishing remain separate." : job.type === "recovery_revision_proof" ? "Revision proof ready for human review. Full cut unchanged." : job.type === "recovery_cta" ? "CTA previews ready. Review timing and placement before full assembly." : job.type === "recovery_final_4k" ? "4K export ready. Final-file playback check is next." : job.type === "recovery_cta_addition" ? "Early CTA preview ready. Current full cut unchanged." : job.type === "recovery_revision_full" ? "Revised full 1080p cut ready. Whole-cut acceptance is next." : job.type === "recovery_full_review" ? "Complete 1080p review ready. Whole-cut review is next." : job.type === "recovery_border" ? "Divider previews ready for review. Full episode unchanged." : job.type === "recovery_graphics_schedule" ? "Approved graphics prepared. Border review and full video assembly remain next." : job.type === "recovery_graphics" ? "Names and topic previews ready for human review." : job.type === "closing_transition" ? "Closing music lead ready for review. Full episode approval remains separate." : job.type === "opening_transition" ? "Opening transition ready for review. Full episode approval remains separate." : job.type === "numbered_opening" ? "Numbered opening rendered locally. Review picture and sound before using it in the episode." : job.type === "show_package_preview" ? "Show-package preview rendered locally. Approval remains separate." : "Approved clip rendered with a receipt.");
  if (job.type === "show_package_preview") {
    await loadShowPackage();
    renderShowPackageDialog();
    setTimeout(() => $("#job-drawer").classList.add("hidden"), 2200);
    return;
  }
  await loadEpisodes();
  if (job.slug) await openEpisode(job.slug);
  setTimeout(() => $("#job-drawer").classList.add("hidden"), 2200);
}

async function resumeActiveJob() {
  const data = await api("/api/jobs/active");
  if (state.pollingJobId || !data.jobs.length) return;
  const job = data.jobs.find((candidate) => candidate.status === "running") || data.jobs[0];
  await pollJob(job);
}

async function renderCandidate(id) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/render`, {
      method: "POST",
      body: JSON.stringify({ clip_id: id }),
    });
    await pollJob(data.job);
    const candidate = state.episode?.candidates?.find((item) => item.id === id);
    if (candidate?.social_render && !candidate.social_render.stale) window.setTimeout(() => openSocialRenderReview(id), 150);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderFullEpisode() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-render`, {
      method: "POST",
      body: "{}",
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderDeliveryAudio() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/delivery-audio`, {
      method: "POST",
      body: "{}",
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function buildDeliveryText() {
  const chapterLines = $("#delivery-chapter-lines").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/delivery-text`, {
      method: "PUT",
      body: JSON.stringify({ chapter_lines: chapterLines }),
    });
    state.episode = data.episode;
    renderEpisode();
    await loadEpisodes();
    toast("Final SRT, VTT, transcript, and chapters created locally. External delivery remains separate.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function renderEpisodeProxy() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/episode-proxy`, {
      method: "POST",
      body: "{}",
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function analyzeSync() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/sync`, { method: "POST", body: "{}" });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function reviewSync(status) {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/sync-review`, {
      method: "PUT",
      body: JSON.stringify({ status, notes: "" }),
    });
    state.episode = data.episode;
    renderSourceReadiness();
    toast(status === "approved" ? "Sync measurement confirmed. Build the aligned timeline next." : "Sync measurement rejected.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function buildAlignedTimeline() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/timeline`, {
      method: "POST",
      body: "{}",
    });
    state.episode = data.episode;
    renderSourceReadiness();
    renderAlignedPreview();
    toast("Aligned timeline built. Media is unchanged and preview is still required.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function validateChannelSlate() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/channel-preflight`, {
      method: "POST",
      body: JSON.stringify({ source_id: $("#channel-source-select").value }),
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function buildSpeakerActivity() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/speaker-activity`, { method: "POST", body: "{}" });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function buildCameraDirectionPlan() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/camera-plan`, { method: "POST", body: "{}" });
    state.episode = data.episode;
    renderSourceReadiness();
    toast("Reason-coded camera plan built. Review is required and rendering remains locked.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function buildSpeakerTranscript() {
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/speaker-transcript`, {
      method: "POST",
      body: "{}",
    });
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

function currentSpeakerReview() {
  const review = state.episode.speaker_transcript_review || {};
  return review.stale ? { roles_swapped: false, edits: {}, speaker_overrides: {}, dismissed_segment_ids: [], confirmed_overlap_pair_ids: [] } : review;
}

async function saveSpeakerTranscriptReview(status, changes = {}) {
  const current = currentSpeakerReview();
  try {
    const data = await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/speaker-transcript-review`, {
      method: "PUT",
      body: JSON.stringify({
        status,
        roles_swapped: changes.roles_swapped ?? current.roles_swapped ?? false,
        edits: changes.edits ?? current.edits ?? {},
        speaker_overrides: changes.speaker_overrides ?? current.speaker_overrides ?? {},
        dismissed_segment_ids: changes.dismissed_segment_ids ?? current.dismissed_segment_ids ?? [],
        confirmed_overlap_pair_ids: changes.confirmed_overlap_pair_ids ?? current.confirmed_overlap_pair_ids ?? [],
      }),
    });
    state.episode = data.episode;
    renderEpisode();
    await loadEpisodes();
    toast(status === "approved"
      ? "Speaker transcript review confirmed. Candidate selection is unlocked."
      : "Transcript correction saved. Confirm the full review before selecting clips.");
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

async function resolveBleedReviewPair(pairId, { dismissSegmentId = null, keepBoth = false } = {}) {
  const current = currentSpeakerReview();
  const dismissed = new Set(current.dismissed_segment_ids || []);
  const confirmed = new Set(current.confirmed_overlap_pair_ids || []);
  if (dismissSegmentId) {
    dismissed.add(dismissSegmentId);
    confirmed.delete(pairId);
  } else if (keepBoth) {
    confirmed.add(pairId);
  }
  const saved = await saveSpeakerTranscriptReview("draft", {
    dismissed_segment_ids: [...dismissed],
    confirmed_overlap_pair_ids: [...confirmed],
  });
  if (saved) toast(dismissSegmentId ? "Duplicate copy dismissed. Studio loaded the next likely pair." : "Real overlap preserved. Studio loaded the next likely pair.");
}

function openTranscriptEdit(segmentId) {
  const cue = (state.episode.transcript || []).find((item) => item.segment_id === segmentId);
  if (!cue) return toast("Transcript line not found.", "error");
  state.editingTranscriptSegmentId = segmentId;
  $("#transcript-edit-context").textContent = `${cue.speaker_label} · ${cue.start} → ${cue.end}`;
  $("#transcript-edit-speaker").value = cue.speaker_id;
  $("#transcript-edit-text").value = cue.text;
  $("#transcript-edit-dismiss-bleed").checked = cue.dismissed_as_bleed === true;
  $("#transcript-edit-dialog").showModal();
}

async function saveTranscriptCorrection() {
  const id = state.editingTranscriptSegmentId;
  const text = $("#transcript-edit-text").value.trim();
  if (!id || !text) return toast("Enter what was actually said.", "error");
  const cue = (state.episode.transcript || []).find((item) => item.segment_id === id);
  const cueIndex = (state.episode.transcript || []).findIndex((item) => item.segment_id === id);
  const base = (state.episode.speaker_transcript?.segments || [])[cueIndex];
  const current = currentSpeakerReview();
  const edits = { ...(current.edits || {}) };
  if (base && text === String(base.text || "").trim()) delete edits[id];
  else edits[id] = text;
  const speakerOverrides = { ...(current.speaker_overrides || {}) };
  const assignedSpeaker = current.roles_swapped
    ? base?.speaker_id === "host_1" ? "host_2" : base?.speaker_id === "host_2" ? "host_1" : base?.speaker_id
    : base?.speaker_id;
  const selectedSpeaker = $("#transcript-edit-speaker").value;
  if (selectedSpeaker === assignedSpeaker) delete speakerOverrides[id];
  else speakerOverrides[id] = selectedSpeaker;
  const dismissed = new Set(current.dismissed_segment_ids || []);
  if ($("#transcript-edit-dismiss-bleed").checked) dismissed.add(id);
  else dismissed.delete(id);
  if (cue && text === String(cue.text || "").trim()
    && selectedSpeaker === cue.speaker_id
    && dismissed.has(id) === Boolean(cue.dismissed_as_bleed)) {
    state.editingTranscriptSegmentId = null;
    $("#transcript-edit-dialog").close();
    return toast("No line decision changed. The existing review state was preserved.");
  }
  const saved = await saveSpeakerTranscriptReview("draft", {
    edits,
    speaker_overrides: speakerOverrides,
    dismissed_segment_ids: [...dismissed],
  });
  if (saved) {
    state.editingTranscriptSegmentId = null;
    $("#transcript-edit-dialog").close();
  }
}

async function swapSpeakerRoles() {
  const current = currentSpeakerReview();
  const action = current.roles_swapped ? "restore the assigned Host labels" : "swap every Host 1 and Host 2 label";
  if (!window.confirm(`Are you sure you want to ${action}? This reopens transcript review and returns candidate approvals to pending.`)) return;
  await saveSpeakerTranscriptReview("draft", { roles_swapped: !current.roles_swapped });
}

async function pickFile(button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Choosing…";
  try {
    const data = await api("/api/pick-file", { method: "POST", body: JSON.stringify({ kind: button.dataset.kind }) });
    $(`#${button.dataset.target}`).value = data.path;
    if (button.dataset.target.startsWith("assembly-")) {
      state.assemblyDirty = true;
      renderEpisodeAssemblyStatus();
    }
  } catch (error) {
    if (!["no recording was selected", "no file was selected"].includes(error.message)) toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    updateIngestButton();
  }
}

let audioPartInputCounter = 0;

function audioPartContainer(role) {
  return role === "host_1_audio" ? $("#host-1-audio-parts") : $("#host-2-audio-parts");
}

function renumberAudioParts(role) {
  [...audioPartContainer(role).querySelectorAll(".audio-part-row")].forEach((row, index, rows) => {
    row.querySelector(".audio-part-index").textContent = `Part ${index + 1} of ${rows.length} · recorded order`;
    row.querySelector(".move-audio-part-up").disabled = index === 0;
    row.querySelector(".move-audio-part-down").disabled = index === rows.length - 1;
  });
  updateIngestButton();
}

function addAudioPart(role, path = "") {
  const container = audioPartContainer(role);
  const id = `audio-part-path-${++audioPartInputCounter}`;
  const row = document.createElement("div");
  row.className = "audio-part-row";
  row.dataset.audioRole = role;
  row.innerHTML = `
    <span class="audio-part-index"></span>
    <input id="${id}" class="audio-part-path" value="${escapeHtml(path)}" placeholder="/path/to/original-transmitter-part.wav" autocomplete="off" />
    <button class="secondary-button source-browse" data-target="${id}" data-kind="audio" type="button">Browse</button>
    <button class="ghost-button move-audio-part-up" type="button" aria-label="Move part up">↑</button>
    <button class="ghost-button move-audio-part-down" type="button" aria-label="Move part down">↓</button>
    <button class="ghost-button remove-audio-part" type="button" aria-label="Remove part">Remove</button>`;
  container.append(row);
  renumberAudioParts(role);
}

function audioPartValues(role) {
  return [...audioPartContainer(role).querySelectorAll(".audio-part-path")].map((input) => input.value.trim()).filter(Boolean);
}

function updateIngestButton() {
  const hostOneReady = !audioPartValues("host_1_audio").length || $("#host-1-order-confirmed").checked;
  const hostTwoReady = !audioPartValues("host_2_audio").length || $("#host-2-order-confirmed").checked;
  $("#ingest-button").disabled = !$("#primary-camera-path").value.trim() || !hostOneReady || !hostTwoReady;
}

async function startIngest() {
  const sources = {
    primary_camera: $("#primary-camera-path").value.trim(),
    secondary_camera: $("#secondary-camera-path").value.trim(),
    host_1_audio_parts: audioPartValues("host_1_audio"),
    host_2_audio_parts: audioPartValues("host_2_audio"),
    host_1_audio_order_confirmed: $("#host-1-order-confirmed").checked,
    host_2_audio_order_confirmed: $("#host-2-order-confirmed").checked,
  };
  if (!sources.primary_camera) return toast("Choose the Host 1 camera first.", "error");
  try {
    const data = await api("/api/jobs/ingest", {
      method: "POST",
      body: JSON.stringify({ sources }),
    });
    $("#new-episode-dialog").close();
    await pollJob(data.job);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openOutput() {
  try {
    await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/open-output`, { method: "POST", body: "{}" });
    toast("Output folder opened.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openEpisodeOutput() {
  try {
    await api(`/api/episodes/${encodeURIComponent(state.activeSlug)}/open-episode-output`, { method: "POST", body: "{}" });
    toast("Full episode folder opened.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openNewEpisode() {
  for (const id of ["primary-camera-path", "secondary-camera-path"]) {
    $(`#${id}`).value = "";
  }
  $("#host-1-audio-parts").innerHTML = "";
  $("#host-2-audio-parts").innerHTML = "";
  $("#host-1-order-confirmed").checked = false;
  $("#host-2-order-confirmed").checked = false;
  addAudioPart("host_1_audio");
  addAudioPart("host_2_audio");
  updateIngestButton();
  $("#new-episode-dialog").showModal();
}

function bindEvents() {
  bindRecoveryImport({ api, pollJob, toast });
  $("#job-close-button").addEventListener("click", () => $("#job-drawer").classList.add("hidden"));
  $("#new-episode-button").addEventListener("click", openNewEpisode);
  $("#episode-checklist-button").addEventListener("click", openEpisodeChecklist);
  $("#episode-checklist-list").addEventListener("change", (event) => {
    const toggle = event.target.closest(".checklist-quick-toggle");
    if (!toggle) return;
    const row = toggle.closest("[data-checklist-item-id]");
    saveChecklistItemPatch(row.dataset.checklistItemId, { status: toggle.checked ? "complete" : "todo" }, { quiet: true });
  });
  $("#episode-checklist-list").addEventListener("click", (event) => {
    const button = event.target.closest(".checklist-edit-button");
    if (button) openChecklistItem(button.closest("[data-checklist-item-id]").dataset.checklistItemId);
  });
  $("#source-readiness").addEventListener("click", (event) => {
    const button = event.target.closest(".audio-seam-review");
    if (button) reviewAudioSeam(button);
  });
  $("#aligned-preview-grid").addEventListener("click", (event) => {
    const button = event.target.closest(".create-browser-preview-button");
    if (button) createBrowserPreview(button.dataset.sourceId);
  });
  $("#save-checklist-item-button").addEventListener("click", saveChecklistItem);
  $("#add-checklist-item-button").addEventListener("click", addChecklistItem);
  $("#welcome-new-button").addEventListener("click", openNewEpisode);
  $("#studio-guide-button").addEventListener("click", openStudioGuide);
  $("#welcome-guide-button").addEventListener("click", openStudioGuide);
  $("#workflow-guide-inline-button").addEventListener("click", openStudioGuide);
  $("#workflow-next-button").addEventListener("click", runWorkflowNextAction);
  $("#workflow-view-toggle").addEventListener("click", toggleWorkflowView);
  document.querySelectorAll("[data-workflow-branch-choice]").forEach((button) => {
    button.addEventListener("click", () => selectWorkflowBranch(button.dataset.workflowBranchChoice));
  });
  $("#social-choose-transcript-button").addEventListener("click", () => selectWorkflowStage("assembly"));
  $("#social-add-candidate-button").addEventListener("click", () => {
    state.transcriptSelection = null;
    openCandidateDialog();
  });
  $("#social-open-output-button").addEventListener("click", openOutput);
  $("#social-generate-suggestions-button").addEventListener("click", generateSocialSuggestions);
  $("#save-social-operator-button").addEventListener("click", saveOperatorIdentity);
  $("#guide-show-button").addEventListener("click", () => openGuideDestination(openShowPackage));
  $("#guide-new-button").addEventListener("click", () => openGuideDestination(openNewEpisode));
  document.querySelectorAll(".stage[data-stage]").forEach((button) => {
    button.addEventListener("click", () => selectWorkflowStage(button.dataset.stage));
  });
  $("#show-package-button").addEventListener("click", openShowPackage);
  $("#e2e-show-package-button").addEventListener("click", openShowPackage);
  $("#prepare-e2e-proof-button").addEventListener("click", prepareE2EProof);
  $("#save-show-package-button").addEventListener("click", saveShowPackage);
  $("#approve-show-package-button").addEventListener("click", () => reviewShowPackage("approved"));
  $("#reject-show-package-button").addEventListener("click", () => reviewShowPackage("rejected"));
  $("#preview-show-opening-button").addEventListener("click", () => previewShowPackage("opening"));
  $("#preview-show-closing-button").addEventListener("click", () => previewShowPackage("closing"));
  for (const section of ["opening", "closing"]) {
    $(`#show-${section}-narration-mode`).addEventListener("change", (event) => {
      $(`#show-${section}-voiceover-row`).classList.toggle("hidden", event.target.value !== "evergreen");
    });
  }
  document.querySelectorAll(".source-browse").forEach((button) => button.addEventListener("click", () => pickFile(button)));
  $("#new-episode-form").addEventListener("click", (event) => {
    const add = event.target.closest(".add-audio-part");
    if (add) return addAudioPart(add.dataset.audioRole);
    const row = event.target.closest(".audio-part-row");
    if (!row) return;
    if (event.target.closest(".source-browse")) return pickFile(event.target.closest(".source-browse"));
    if (event.target.closest(".remove-audio-part")) row.remove();
    if (event.target.closest(".move-audio-part-up") && row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling);
    if (event.target.closest(".move-audio-part-down") && row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row);
    renumberAudioParts(row.dataset.audioRole);
  });
  $("#new-episode-form").addEventListener("input", updateIngestButton);
  $("#new-episode-form").addEventListener("change", updateIngestButton);
  $("#primary-camera-path").addEventListener("input", updateIngestButton);
  $("#ingest-button").addEventListener("click", startIngest);
  $("#add-candidate-button").addEventListener("click", () => {
    state.transcriptSelection = null;
    openCandidateDialog();
  });
  $("#save-candidate-button").addEventListener("click", saveCandidate);
  $("#save-candidate-review-button").addEventListener("click", saveCandidateReview);
  $("#candidate-review-dialog").addEventListener("close", () => $("#candidate-review-video").pause());
  $("#approve-social-render-button").addEventListener("click", () => saveSocialRenderReview("approved"));
  $("#reject-social-render-button").addEventListener("click", () => saveSocialRenderReview("rejected"));
  document.querySelectorAll("[data-social-render-check]").forEach((input) => input.addEventListener("change", updateSocialRenderApproval));
  $("#social-render-review-dialog").addEventListener("close", () => $("#social-render-review-video").pause());
  $("#save-social-package-button").addEventListener("click", () => saveSocialPackage());
  $("#approve-social-package-button").addEventListener("click", () => saveSocialPackage({ approve: true }));
  for (const id of ["social-package-url", "social-package-caption", "social-package-hashtags", "social-package-cover", "social-package-release-slot", "social-package-tiktok-link"]) {
    $(`#${id}`).addEventListener("input", renderSocialPackagePreview);
    $(`#${id}`).addEventListener("change", renderSocialPackagePreview);
  }
  $("#social-quality-over-quota").addEventListener("change", renderSocialWorkflow);
  $("#social-build-delivery-button").addEventListener("click", buildSocialDelivery);
  $("#candidate-preview-play-button").addEventListener("click", toggleCandidatePreview);
  for (const id of ["candidate-start", "candidate-end", "candidate-hook", "candidate-overlay", "candidate-crop"]) {
    $(`#${id}`).addEventListener("input", updateCandidatePreview);
  }
  $("#candidate-dialog").addEventListener("close", () => {
    $("#candidate-preview-video").pause();
    $("#candidate-preview-play-button").textContent = "Preview at start";
  });
  $("#open-output-button").addEventListener("click", openOutput);
  $("#analyze-sync-button").addEventListener("click", analyzeSync);
  $("#approve-sync-button").addEventListener("click", () => reviewSync("approved"));
  $("#reject-sync-button").addEventListener("click", () => reviewSync("rejected"));
  $("#build-timeline-button").addEventListener("click", buildAlignedTimeline);
  $("#validate-channels-button").addEventListener("click", validateChannelSlate);
  $("#build-speaker-activity-button").addEventListener("click", buildSpeakerActivity);
  $("#build-camera-plan-button").addEventListener("click", buildCameraDirectionPlan);
  $("#build-speaker-transcript-button").addEventListener("click", buildSpeakerTranscript);
  $("#swap-speaker-roles-button").addEventListener("click", swapSpeakerRoles);
  $("#approve-speaker-transcript-button").addEventListener("click", () => saveSpeakerTranscriptReview("approved"));
  $("#save-transcript-edit-button").addEventListener("click", saveTranscriptCorrection);
  $("#preview-play-button").addEventListener("click", playAlignedPreview);
  $("#preview-pause-button").addEventListener("click", stopAlignedPreview);
  $("#preview-scrubber").addEventListener("input", (event) => {
    stopAlignedPreview();
    updatePreviewTime(Number(event.target.value));
  });
  $("#preview-end-button").addEventListener("click", () => {
    stopAlignedPreview();
    updatePreviewTime(Math.max(0, Number(state.episode.timeline?.reference_duration_ms || 0) - 10_000));
  });
  $("#preview-start-check-button").addEventListener("click", () => saveTimelinePreview("pending", { checked_start: true }));
  $("#preview-end-check-button").addEventListener("click", () => saveTimelinePreview("pending", { checked_end: true }));
  $("#reject-preview-button").addEventListener("click", () => saveTimelinePreview("rejected"));
  $("#approve-preview-button").addEventListener("click", () => saveTimelinePreview("approved"));
  $("#prepare-naming-request-button").addEventListener("click", prepareEpisodeNamingRequest);
  $("#copy-naming-request-button").addEventListener("click", copyEpisodeNamingRequest);
  $("#add-human-naming-option-button").addEventListener("click", addHumanEpisodeNamingOption);
  $("#import-naming-options-button").addEventListener("click", importEpisodeNamingProposal);
  $("#episode-number").addEventListener("input", () => {
    renderEpisodeNaming();
    renderEpisodeAssemblyStatus();
  });
  $("#split-assembly-shot-button").addEventListener("click", splitLongestAssemblyShot);
  $("#apply-camera-plan-button").addEventListener("click", applyCurrentCameraPlan);
  $("#refresh-show-package-button").addEventListener("click", () => applyShowPackageToAssembly({ markDirty: true }));
  $("#assembly-opening-inherit").addEventListener("change", (event) => toggleAssemblyInheritance("opening", event.target.checked));
  $("#assembly-closing-inherit").addEventListener("change", (event) => toggleAssemblyInheritance("closing", event.target.checked));
  $("#assembly-cta-inherit").addEventListener("change", (event) => toggleAssemblyInheritance("cta_graphic", event.target.checked));
  $("#assembly-newsletter-inherit").addEventListener("change", (event) => toggleAssemblyInheritance("newsletter_cta", event.target.checked));
  $("#save-assembly-button").addEventListener("click", saveEpisodeAssembly);
  $("#approve-assembly-button").addEventListener("click", () => reviewEpisodeAssembly("approved"));
  $("#reject-assembly-button").addEventListener("click", () => reviewEpisodeAssembly("rejected"));
  $("#approve-camera-plan-button").addEventListener("click", () => reviewCameraPlan("approved"));
  $("#reject-camera-plan-button").addEventListener("click", () => reviewCameraPlan("rejected"));
  $("#resume-camera-plan-preview-button").addEventListener("click", resumeCameraPlanPreview);
  $("#pause-camera-plan-preview-button").addEventListener("click", stopCameraPlanPreview);
  $("#camera-plan-preview-scrubber").addEventListener("input", seekCameraPlanPreview);
  $("#rotate-camera-plan-primary-button").addEventListener("click", (event) => rotateReviewSource(event.currentTarget.dataset.sourceId));
  $("#rotate-camera-plan-secondary-button").addEventListener("click", (event) => rotateReviewSource(event.currentTarget.dataset.sourceId));
  $("#render-proxy-button").addEventListener("click", renderEpisodeProxy);
  $("#run-episode-proxy-audit-button").addEventListener("click", runEpisodeProxyAudit);
  $("#approve-episode-proxy-button").addEventListener("click", () => saveEpisodeProxyReview("approved"));
  $("#reject-episode-proxy-button").addEventListener("click", () => saveEpisodeProxyReview("rejected"));
  document.querySelectorAll('input[name="proxy-review-mode"]').forEach((input) => input.addEventListener("change", () => {
    if (proxyReviewMode() === "metadata_assisted") {
      document.querySelector('[data-proxy-review-check="complete_watch"]').checked = false;
    }
    updateProxyReviewApprovalButton();
  }));
  document.querySelectorAll("[data-proxy-review-check]").forEach((input) => input.addEventListener("change", updateProxyReviewApprovalButton));
  $("#render-episode-button").addEventListener("click", renderFullEpisode);
  $("#render-delivery-audio-button").addEventListener("click", renderDeliveryAudio);
  $("#build-delivery-text-button").addEventListener("click", buildDeliveryText);
  $("#open-episode-output-button").addEventListener("click", openEpisodeOutput);
  window.addEventListener("resize", applySavedReviewRotations);
  for (const id of [
    "assembly-title",
    "assembly-opening-visual",
    "assembly-opening-voiceover",
    "assembly-opening-music",
    "assembly-closing-visual",
    "assembly-closing-voiceover",
    "assembly-closing-music",
    "assembly-closing-audio-lead",
    "assembly-cta-asset",
    "assembly-cta-label",
    "assembly-cta-url",
    "assembly-cta-like",
    "assembly-cta-comment",
    "assembly-cta-subscribe",
    "assembly-cta-closing",
    "assembly-newsletter-asset",
    "assembly-newsletter-label",
    "assembly-newsletter-url",
    "assembly-divider-enabled",
    "assembly-divider-color",
    "assembly-divider-width",
    "assembly-camera-balance-enabled",
    "assembly-primary-temperature",
    "assembly-secondary-temperature",
    "assembly-camera-framing-enabled",
    "assembly-opening-trim-end",
    "assembly-program-fade-in",
    "assembly-closing-audio-gain",
    "assembly-primary-horizontal",
    "assembly-secondary-horizontal",
    "assembly-primary-zoom",
    "assembly-primary-vertical",
    "assembly-secondary-zoom",
    "assembly-secondary-vertical",
    "assembly-program-graphics-enabled",
    "assembly-host-one-name",
    "assembly-host-two-name",
    "assembly-lower-third-times",
    "assembly-topic-bars",
  ]) {
    $(`#${id}`).addEventListener("input", () => {
      state.assemblyDirty = true;
      renderEpisodeAssemblyStatus();
    });
  }
  $("#assembly-program-start").addEventListener("input", (event) => {
    if (state.assemblyDraftShots.length) state.assemblyDraftShots[0].start = event.target.value;
    state.assemblyDirty = true;
    renderAssemblyShotList();
    renderEpisodeAssemblyStatus();
  });
  $("#assembly-program-end").addEventListener("input", (event) => {
    if (state.assemblyDraftShots.length) state.assemblyDraftShots.at(-1).end = event.target.value;
    state.assemblyDirty = true;
    renderAssemblyShotList();
    renderEpisodeAssemblyStatus();
  });
}

async function init() {
  bindEvents();
  try {
    await loadShowConfig();
    await loadShowPackage();
    await loadOperatorIdentity();
    await loadEpisodes();
    const requestedSlug = new URLSearchParams(window.location.search).get("episode");
    const requestedEpisode = state.episodes.find((episode) => episode.slug === requestedSlug);
    if (requestedEpisode) await openEpisode(requestedEpisode.slug);
    else if (state.episodes.length) await openEpisode(state.episodes[0].slug);
    await resumeActiveJob();
  } catch (error) {
    toast(error.message, "error");
  }
}

init();
