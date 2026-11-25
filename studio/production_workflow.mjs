// A navigation/readiness view of the existing checklist, never a render authorization.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEpisodeChecklist, updateEpisodeChecklistItem } from './episode_checklist.mjs';
import { inside, writeRecoveryJson } from './recovery.mjs';

export const WORKFLOW_STEPS = [
  { id: 'intake', title: 'Recordings and setup', phases: ['planning', 'recording', 'transfer'], target: 'source-readiness', recoveryTarget: 'recovery-workspace', hint: 'Before recording: choose the call-to-action moments. Keep every camera restart and microphone part. Originals stay unchanged.' },
  { id: 'continuity', title: 'Joins, sync and words', items: ['production_intake','production_camera_restarts','production_seams','production_sync','production_transcript'], target: 'aligned-preview', recoveryTarget: 'recovery-workspace', hint: 'Compare the question and answer across each join. Listen for clipped syllables, then inspect picture continuity and sync near both ends.' },
  { id: 'finishing', title: 'Framing, graphics and bookends', items: ['production_framing','production_bookends','production_graphics'], target: 'assembly-workspace', recoveryTarget: 'recovery-framing-form', hint: 'Use short proofs first. Match face size between solo and two-shot; give camera changes time to breathe. Keep labels simple.' },
  { id: 'ctas', title: 'Call-to-action placements', items: ['production_cta_early','production_cta_secondary','production_cta_closing'], target: 'cta-workspace', hint: 'Check each call to action against the spoken moment before the full render. These are episode-specific placements, not inherited timestamps.' },
  { id: 'review', title: 'Complete draft and revisions', items: ['production_proxy','production_revisions'], target: 'assembly-workspace', hint: 'Watch the complete low-resolution proxy. Each host records watched coverage. Recheck changed proofs and their assembled result.' },
  { id: 'final', title: 'Final video and companion files', items: ['production_render','delivery_companions'], target: 'assembly-workspace', hint: 'After the assembled cut is accepted, render the full episode. Audio-only, transcript, captions and chapters must match the final timeline. Check the actual exported files.' },
  { id: 'release', title: 'Release copy', items: ['delivery_release_copy','delivery_platform_copy','delivery_segment_chapters','delivery_artwork_settings','delivery_publish'], target: 'release-workspace', recoveryTarget:'release-workspace', hint: 'Prepare the platform descriptions. Keep title options and show notes as drafts until selected. Uploading and publishing happen outside Studio.' },
  { id: 'social', title: 'Social clips', items: ['delivery_social'], target: 'social-workspace', recoveryTarget: 'social-workspace', hint: 'Select real moments from the exact finished cut, then review each rendered clip in full. Rendering, sharing and posting are separate decisions.' },
  { id: 'learning', title: 'Notes for the next run', phases: ['learning'], hint: 'Record what to change next time. Leave raw and superseded files alone until cleanup is separately approved.' },
];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const current = receipt => Boolean(receipt && !receipt.stale);

export function buildProductionWorkflow(episode, checklist, operator = null) {
  const recovery = Boolean(episode.recovery);
  const stale = recovery ? Boolean(episode.recovery.staleInputs?.length) : Boolean(episode.intake_stale);
  const facts = recovery ? [
    ['Recovery inputs', stale ? 'Changed; re-verify before continuing' : 'Current imported continuity map'],
  ] : [
    ['Source inputs', stale ? 'Changed; re-verify before continuing' : episode.intake ? 'Source receipt available' : 'Single-source / intake needs checking'],
    ['Full render', current(episode.episode_render) ? 'Current local full render' : 'No current full render'],
  ];
  const blockers = recovery ? [
    'Interrupted-camera assembly is assisted: the recovery map must be prepared and verified before import. This view does not stitch arbitrary camera restarts.',
    'A recovered episode supports camera drafts, short previews and the opening and closing transitions. Full export of a recovered episode is not part of this version.',
  ] : [
    'Normal intake supports one continuous camera per host plus ordered microphone parts. Camera interruptions need the assisted recovery route.',
  ];
  const steps = WORKFLOW_STEPS.map(step => ({ ...step,
    target: recovery ? step.recoveryTarget || null : step.target || null,
    mode: (!step.target || (recovery && !step.recoveryTarget)) ? 'Guided handoff' : 'Studio controls',
    items: checklist.items.filter(item => !item.archived && (step.items?.includes(item.id) || step.phases?.includes(item.phase))),
  }));
  const assigned = new Set(steps.flatMap(step => step.items.map(item => item.id)));
  for (const item of checklist.items.filter(item => !item.archived && !assigned.has(item.id))) {
    const fallback = item.phase === 'production' ? 'finishing' : item.phase === 'delivery' ? 'release' : 'learning';
    steps.find(step => step.id === fallback).items.push(item);
  }
  const media = [];
  const revision = hash({ checklist, stale, facts, fingerprint: episode.recovery?.draftFingerprint || null });
  return { schema: 'eaol-production-workflow-v1', slug: episode.slug, title: episode.episode_title || episode.source_name || episode.slug, revision,
    operator: operator?.display_name || null, operator_id: operator?.operator_id || null, recovery, stale, facts, blockers, steps, media,
    notice: 'Progress notes are self-reported. They do not grant render, upload, publication or cleanup approval. Existing exact-file gates remain authoritative.',
  };
}

export function loadWorkflowChecklist(dir, episode) {
  const path = join(dir, 'episode_checklist.json');
  const exists = existsSync(path);
  if (exists) {
    inside(path, [dir]);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.schema !== 'eaol-episode-checklist-v1' || !Array.isArray(saved.items)) throw new Error('Checklist is unreadable; preserve it and repair before continuing.');
  }
  const checklist = loadEpisodeChecklist(dir, { slug: episode.slug, title: episode.episode_title || episode.source_name });
  // Loading an untouched episode must yield the same revision on the next request.
  if (!exists) { checklist.created_at = null; checklist.updated_at = null; }
  return checklist;
}

export function saveWorkflowItem(dir, checklist, itemId, body, workflow) {
  if (body.revision !== workflow.revision) throw new Error('The workflow changed. Reload before saving your note.');
  if (!workflow.operator) throw new Error('Choose this machine’s operator in Studio setup before saving.');
  if (!['todo','complete','blocked','not_applicable'].includes(body.status)) throw new Error('Choose a valid progress status.');
  if (typeof body.notes !== 'string' || body.notes.length > 4000) throw new Error('Notes must be text up to 4000 characters.');
  if (body.status !== 'todo' && !body.notes.trim()) throw new Error('Add the version, evidence or reason for this progress status.');
  if (body.owner != null && (typeof body.owner !== 'string' || body.owner.length > 100)) throw new Error('Owner must be text up to 100 characters.');
  const next = updateEpisodeChecklistItem(checklist, itemId, { status: body.status, notes: body.notes, owner: body.owner });
  const item = next.items.find(item => item.id === itemId);
  item.recorded_by = workflow.operator;
  next.created_at ||= next.updated_at;
  const path = join(dir, 'episode_checklist.json');
  if (existsSync(path)) inside(path, [dir]);
  writeRecoveryJson(path, next);
  return next;
}

export function workflowHandoff(state) {
  return `# Studio workflow notes: ${state.slug}\n\n` +
    `Use your own local checkout and locally available episode sources. Run npm run setup:check, then npm run studio, and open the address the server prints. Select your operator, open the episode and use Production workflow.\n\nNotes recorded by: ${state.operator || 'no operator selected'}\n\n` +
    `## Current observations\n${state.facts.map(([label,value]) => `- ${label}: ${value}`).join('\n')}\n\n` +
    `## Known assisted steps\n${state.blockers.map(value => `- ${value}`).join('\n')}\n\n` +
    `## Recorded progress\n${state.steps.map(step => `### ${step.title}\n${step.items.map(item => `- [${item.status}] ${item.title} (${item.owner || 'unassigned'})${item.notes ? `\n  ${item.notes}` : ''}`).join('\n')}`).join('\n\n')}\n\n` +
    `Progress notes are not approvals. This file includes no media. Nothing here authorizes upload, publication or cleanup.\n`;
}
