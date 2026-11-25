#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  EPISODE_NAMING_PROPOSAL_SCHEMA,
  buildEpisodeNamingApproval,
  buildEpisodeNamingRequest,
  buildHumanEpisodeNamingProposal,
  episodeNamingPolicyFingerprint,
  episodeNamingState,
  validateEpisodeNamingProposal,
} from "./episode_naming.mjs";

const policyFingerprint = episodeNamingPolicyFingerprint("skill instructions\n", "research evidence\n");
assert.equal(policyFingerprint, episodeNamingPolicyFingerprint("skill instructions\n\n\n", "research evidence\n\n"));
assert.notEqual(policyFingerprint, episodeNamingPolicyFingerprint("changed skill instructions\n", "research evidence\n"));

const segments = [
  { id: "segment_0001", start: "00:00:01.000", end: "00:00:05.000", speaker_label: "Host 1", text: "We have to begin with a small first step." },
  { id: "segment_0002", start: "00:00:05.000", end: "00:00:09.000", speaker_label: "Host 2", text: "The useful part is learning while we build." },
];
const request = buildEpisodeNamingRequest({
  slug: "sa001_08301632_c002",
  episodeNumber: 1,
  segments,
  previousApprovedTitles: ["A Prior Episode"],
  policyVersion: "2026-09-02",
  policyFingerprint: "a".repeat(64),
  createdAt: "2026-09-02T12:00:00.000Z",
});
assert.equal(request.episode_number, 1);
assert.equal(request.production_id, "ep001");
assert.equal(request.transcript.length, 2);
assert.equal(request.task.candidate_count_min, 3);
assert.equal(request.request_fingerprint.length, 64);

const proposal = validateEpisodeNamingProposal({
  schema: EPISODE_NAMING_PROPOSAL_SCHEMA,
  request_fingerprint: request.request_fingerprint,
  generated_at: "2026-09-02T12:01:00.000Z",
  generator: { mode: "external_import", provider: "future-provider", model: "future-model" },
  candidates: [
    { canonical_title: "Learning a Skill by Practicing in Public", lane: "clear_searchable", rationale: "Names the central practical theme." },
    { canonical_title: "Begin With One Small Step", lane: "curiosity_led", rationale: "Uses the hosts' framing without exaggeration." },
    { canonical_title: "What We Noticed When We Finally Began", lane: "host_voice_led", rationale: "Reflects the first-person conversation." },
  ],
}, request);
assert.equal(proposal.candidates.length, 3);
assert.equal(proposal.proposal_fingerprint.length, 64);

const approval = buildEpisodeNamingApproval({
  request,
  proposal,
  candidateId: "title_002",
  approvedBy: "host_1",
  approvedAt: "2026-09-02T12:02:00.000Z",
});
assert.equal(approval.canonical_title, "Begin With One Small Step");
assert.equal(approval.platform_titles.podcast_rss, "Begin With One Small Step");
assert.equal(approval.platform_titles.youtube, "Begin With One Small Step | Ep. 1");
assert.equal(approval.platform_titles.website, "Episode 1: Begin With One Small Step");
assert.equal(approval.assembly_authorized, false);
assert.equal(approval.render_authorized, false);
assert.equal(approval.publication_authorized, false);

const current = episodeNamingState({ request, proposal, approval, segments, policyFingerprint: "a".repeat(64) });
assert.equal(current.approved, true);
assert.equal(current.provider_connected, false);
assert.equal(current.generation_available, false);
const stale = episodeNamingState({
  request,
  proposal,
  approval,
  segments: [...segments, { id: "segment_0003", start: "00:00:09.000", end: "00:00:10.000", speaker_label: "Host 1", text: "A changed line." }],
  policyFingerprint: "a".repeat(64),
});
assert.equal(stale.request_current, false);
assert.equal(stale.approved, false);

const human = buildHumanEpisodeNamingProposal({ request, title: "A Human Grounded Title", rationale: "Chosen directly by the hosts." });
assert.equal(human.generator.provider, "none");
assert.equal(human.candidates[0].lane, "human");

assert.throws(() => buildHumanEpisodeNamingProposal({ request, title: "Episode 1: A Bad Prefix", rationale: "Bad numbering." }), /must not begin/);
assert.throws(() => buildHumanEpisodeNamingProposal({ request, title: "Example Podcast Learns", rationale: "Repeats the show name." }), /must not repeat/);
assert.throws(() => validateEpisodeNamingProposal({ ...proposal, request_fingerprint: "b".repeat(64) }, request), /different transcript/);

console.log("PASS episode naming requests, proposals, approvals, platform variants, and stale-state checks stay provider-neutral");
