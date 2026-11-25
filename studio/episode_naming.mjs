import { createHash } from "node:crypto";
import { loadShowConfig } from "./show_config.mjs";

export const EPISODE_NAMING_REQUEST_SCHEMA = "eaol-episode-naming-request-v1";
export const EPISODE_NAMING_PROPOSAL_SCHEMA = "eaol-episode-naming-proposal-v1";
export const EPISODE_NAMING_APPROVAL_SCHEMA = "eaol-episode-naming-approval-v1";

// The naming policy an agent or a person follows when proposing titles. Its
// fingerprint is stored in each request, so changing this text makes older
// requests and proposals stale.
export const EPISODE_NAMING_POLICY_VERSION = "generic-v1";
export const EPISODE_NAMING_POLICY = [
  "Ground every title in the approved transcript only.",
  "Offer three to five options covering a clear and searchable angle, a curiosity-led angle and a host-voice angle.",
  "Put the topic first. Do not lead with an episode number, the show name or a date.",
  "Do not promise a topic, result or controversy the episode does not deliver.",
  "The canonical title carries no episode number; the numbered video title is derived from it.",
  "Proposing titles is not approval. A person approves one title in Studio.",
].join("\n");

const LANES = new Set(["clear_searchable", "curiosity_led", "host_voice_led", "balanced", "human"]);

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function episodeNamingPolicyFingerprint(skillText, researchText = "") {
  const canonicalFile = (value) => `${String(value ?? "").trimEnd()}\n\n`;
  return createHash("sha256")
    .update(`${canonicalFile(skillText)}\n${canonicalFile(researchText)}`)
    .digest("hex");
}

function cleanText(value, label, maximum, { required = false } = {}) {
  const result = String(value ?? "").trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`);
  return result;
}

function validEpisodeNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 9_999) {
    throw new Error("episode number must be a whole number from 1 to 9999");
  }
  return number;
}

function canonicalTranscript(segments) {
  if (!Array.isArray(segments) || !segments.length) throw new Error("an approved transcript is required before naming the episode");
  return segments
    .filter((segment) => !segment.dismissed_as_bleed)
    .map((segment, index) => ({
      id: String(segment.id || segment.segment_id || `segment_${String(index + 1).padStart(4, "0")}`),
      start: cleanText(segment.start, "transcript start", 24, { required: true }),
      end: cleanText(segment.end, "transcript end", 24, { required: true }),
      speaker: cleanText(segment.speaker_label || segment.speaker || "Speaker", "speaker", 80, { required: true }),
      text: cleanText(segment.text, "transcript text", 4_000, { required: true }),
    }));
}

export function episodeNamingTranscriptFingerprint(segments) {
  return fingerprint(canonicalTranscript(segments));
}

export function buildEpisodeNamingRequest({
  slug,
  episodeNumber,
  segments,
  previousApprovedTitles = [],
  policyVersion,
  policyFingerprint,
  createdAt = new Date().toISOString(),
}) {
  const transcript = canonicalTranscript(segments);
  const number = validEpisodeNumber(episodeNumber);
  const request = {
    schema: EPISODE_NAMING_REQUEST_SCHEMA,
    source_slug: cleanText(slug, "source slug", 160, { required: true }),
    episode_number: number,
    production_id: `ep${String(number).padStart(3, "0")}`,
    created_at: createdAt,
    policy: {
      version: cleanText(policyVersion, "naming policy version", 80, { required: true }),
      fingerprint: cleanText(policyFingerprint, "naming policy fingerprint", 128, { required: true }),
    },
    task: {
      candidate_count_min: 3,
      candidate_count_max: 5,
      canonical_title_max_characters: 90,
      youtube_title_max_characters: 100,
      required_lanes: ["clear_searchable", "curiosity_led", "host_voice_led"],
      instructions: `${EPISODE_NAMING_POLICY}\nDo not approve a title or authorize any later production action.`,
    },
    previous_approved_titles: [...new Set(previousApprovedTitles.map((title) => cleanText(title, "previous title", 160)).filter(Boolean))].slice(0, 100),
    transcript,
  };
  request.transcript_fingerprint = fingerprint(transcript);
  request.request_fingerprint = fingerprint({
    source_slug: request.source_slug,
    episode_number: request.episode_number,
    policy: request.policy,
    task: request.task,
    previous_approved_titles: request.previous_approved_titles,
    transcript_fingerprint: request.transcript_fingerprint,
  });
  return request;
}

export function normalizeCanonicalTitle(value, episodeNumber) {
  const title = cleanText(value, "canonical title", 90, { required: true }).replace(/\s+/g, " ");
  const number = validEpisodeNumber(episodeNumber);
  if (/^(episode|ep\.?)[\s#-]*\d+/i.test(title)) throw new Error("canonical titles must not begin with an episode number");
  const showName = loadShowConfig().show_name.trim();
  if (showName && title.toLowerCase().includes(showName.toLowerCase())) throw new Error("canonical titles must not repeat the show name");
  if (new RegExp(`(?:\\||-|—)\\s*(?:episode|ep\\.?)\\s*${number}\\s*$`, "i").test(title)) {
    throw new Error("keep the episode number out of the canonical title; Studio adds platform variants separately");
  }
  if (`${title} | Ep. ${number}`.length > 100) {
    throw new Error("canonical title is too long for the numbered YouTube variant");
  }
  return title;
}

function normalizeCandidate(candidate, index, episodeNumber) {
  const lane = cleanText(candidate?.lane || "balanced", `title option ${index + 1} lane`, 40, { required: true });
  if (!LANES.has(lane)) throw new Error(`title option ${index + 1} has an unsupported lane`);
  return {
    id: `title_${String(index + 1).padStart(3, "0")}`,
    canonical_title: normalizeCanonicalTitle(candidate?.canonical_title || candidate?.title, episodeNumber),
    lane,
    rationale: cleanText(candidate?.rationale, `title option ${index + 1} rationale`, 1_000, { required: true }),
  };
}

export function validateEpisodeNamingProposal(value, request, { allowSingleHumanCandidate = false } = {}) {
  if (!request?.request_fingerprint) throw new Error("prepare a current naming request before importing title options");
  if (!value || value.schema !== EPISODE_NAMING_PROPOSAL_SCHEMA) {
    throw new Error(`proposal schema must be ${EPISODE_NAMING_PROPOSAL_SCHEMA}`);
  }
  if (value.request_fingerprint !== request.request_fingerprint) {
    throw new Error("these title options were generated for a different transcript, episode number, or naming policy");
  }
  if (!Array.isArray(value.candidates)) throw new Error("proposal candidates must be an array");
  const minimum = allowSingleHumanCandidate ? 1 : request.task.candidate_count_min;
  if (value.candidates.length < minimum || value.candidates.length > request.task.candidate_count_max) {
    throw new Error(`proposal must contain ${minimum}–${request.task.candidate_count_max} title options`);
  }
  const candidates = value.candidates.map((candidate, index) => normalizeCandidate(candidate, index, request.episode_number));
  const titles = new Set(candidates.map((candidate) => candidate.canonical_title.toLowerCase()));
  if (titles.size !== candidates.length) throw new Error("title options must be unique");
  const proposal = {
    schema: EPISODE_NAMING_PROPOSAL_SCHEMA,
    source_slug: request.source_slug,
    request_fingerprint: request.request_fingerprint,
    transcript_fingerprint: request.transcript_fingerprint,
    generated_at: cleanText(value.generated_at || new Date().toISOString(), "generated at", 80, { required: true }),
    generator: {
      mode: cleanText(value.generator?.mode || "external_import", "generator mode", 80, { required: true }),
      provider: cleanText(value.generator?.provider || "not_recorded", "generator provider", 120, { required: true }),
      model: cleanText(value.generator?.model || "not_recorded", "generator model", 120, { required: true }),
    },
    candidates,
  };
  proposal.proposal_fingerprint = fingerprint({
    source_slug: proposal.source_slug,
    request_fingerprint: proposal.request_fingerprint,
    generator: proposal.generator,
    candidates: proposal.candidates,
  });
  return proposal;
}

export function buildHumanEpisodeNamingProposal({ request, title, rationale, createdAt = new Date().toISOString() }) {
  return validateEpisodeNamingProposal({
    schema: EPISODE_NAMING_PROPOSAL_SCHEMA,
    request_fingerprint: request?.request_fingerprint,
    generated_at: createdAt,
    generator: { mode: "human", provider: "none", model: "none" },
    candidates: [{ canonical_title: title, lane: "human", rationale }],
  }, request, { allowSingleHumanCandidate: true });
}

export function buildEpisodeNamingApproval({ request, proposal, candidateId, approvedBy, approvedAt = new Date().toISOString() }) {
  const checked = validateEpisodeNamingProposal(proposal, request, {
    allowSingleHumanCandidate: proposal?.generator?.mode === "human",
  });
  const candidate = checked.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error("choose a current title option");
  const number = request.episode_number;
  const approval = {
    schema: EPISODE_NAMING_APPROVAL_SCHEMA,
    source_slug: request.source_slug,
    episode_number: number,
    production_id: request.production_id,
    canonical_title: candidate.canonical_title,
    selected_candidate_id: candidate.id,
    selected_lane: candidate.lane,
    rationale: candidate.rationale,
    approved_by: cleanText(approvedBy, "approver", 100, { required: true }),
    approved_at: approvedAt,
    request_fingerprint: request.request_fingerprint,
    proposal_fingerprint: checked.proposal_fingerprint,
    policy: request.policy,
    platform_titles: {
      podcast_rss: candidate.canonical_title,
      rss_episode_number: number,
      youtube: `${candidate.canonical_title} | Ep. ${number}`,
      website: `Episode ${number}: ${candidate.canonical_title}`,
    },
    assembly_authorized: false,
    render_authorized: false,
    publication_authorized: false,
  };
  approval.approval_fingerprint = fingerprint({
    source_slug: approval.source_slug,
    episode_number: approval.episode_number,
    canonical_title: approval.canonical_title,
    request_fingerprint: approval.request_fingerprint,
    proposal_fingerprint: approval.proposal_fingerprint,
    policy: approval.policy,
  });
  return approval;
}

export function episodeNamingState({ request, proposal, approval, segments, policyFingerprint }) {
  const transcriptFingerprint = Array.isArray(segments) && segments.length ? episodeNamingTranscriptFingerprint(segments) : null;
  const requestCurrent = Boolean(request
    && request.transcript_fingerprint === transcriptFingerprint
    && request.policy?.fingerprint === policyFingerprint);
  const proposalCurrent = Boolean(requestCurrent && proposal?.request_fingerprint === request.request_fingerprint);
  const approvalCurrent = Boolean(proposalCurrent
    && approval?.request_fingerprint === request.request_fingerprint
    && approval?.proposal_fingerprint === proposal.proposal_fingerprint
    && proposal.candidates?.some((candidate) => candidate.id === approval.selected_candidate_id
      && candidate.canonical_title === approval.canonical_title));
  return {
    request: request ? { ...request, stale: !requestCurrent } : null,
    proposal: proposal ? { ...proposal, stale: !proposalCurrent } : null,
    approval: approval ? { ...approval, stale: !approvalCurrent } : null,
    transcript_fingerprint: transcriptFingerprint,
    request_current: requestCurrent,
    proposal_current: proposalCurrent,
    approved: approvalCurrent,
    provider_connected: false,
    generation_available: false,
  };
}
