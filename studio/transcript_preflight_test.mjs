import assert from 'node:assert/strict';
import { auditTranscriptPreflight } from './transcript_preflight.mjs';

const cue = (id, chunk, start, end, text) => ({ id, chunk, source_cue: id, start, end, text });
const repeats = [
  [cue('a',1,100,101.96,'every new update'),cue('b',2,101.51,102.64,'new update arrives')],
  [cue('a',6,200,202.91,'I think'),cue('b',7,203.4,206.29,'I think the next step')],
  [cue('a',4,300,301,'just'),cue('b',4,301,303.44,'a small'),cue('c',5,302.8,305.86,'just a small detail')],
];
for (const rows of repeats) {
  const original = structuredClone(rows);
  const result = auditTranscriptPreflight(rows);
  assert.equal(result.findings.filter(f => f.kind === 'chunk_boundary_repetition').length,1);
  assert.equal(result.findings[0].automatic_word_deletion,false);
  assert.equal(result.findings[0].human_approval_required,false);
  assert.deepEqual(rows,original,'discovery must never discard a genuine spoken repeat');
}
assert.equal(auditTranscriptPreflight([cue('a',1,0,1,'I think'),cue('b',1,1,2,'I think it works')]).findings.length,0,'same-chunk rhetoric is not an overlap-window finding');
assert.equal(auditTranscriptPreflight([cue('a',1,0,1,'I think'),cue('b',2,8,9,'I think it works')]).findings.length,0,'distant repetitions are not seam candidates');
assert.equal(auditTranscriptPreflight([cue('a',1,0,1,'across cloud'),cue('b',1,1,2,'code and chat')]).findings[0].kind,'split_product_spelling');
assert.equal(auditTranscriptPreflight([cue('a',1,0,1,'across Claude'),cue('b',1,1,2,'Code and chat')]).findings.length,0);
assert.equal(auditTranscriptPreflight([cue('a',1,1,1,'sample files')]).findings[0].kind,'invalid_source_span');
const before=auditTranscriptPreflight(repeats[0]).findings[0].finding_key;
const changed=repeats[0].map(c=>({...c,id:'reindexed'}));
assert.equal(auditTranscriptPreflight(changed).findings[0].finding_key,before,'source identity survives regenerated display IDs');
console.log('PASS: seam and name defects discovered without deleting words or generating host gates.');
