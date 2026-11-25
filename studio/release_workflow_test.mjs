import {buildEpisodeNamingRequest, validateEpisodeNamingProposal, EPISODE_NAMING_PROPOSAL_SCHEMA} from './episode_naming.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createNoteDrafts} from './public/note-drafts.js';
import {buildReleaseCopy, validateShortTitle, websiteLink, validateChapterTitleAuthority, validateReleaseChapters} from './release_policy.mjs';
import {normalizeShowConfig} from './show_config.mjs';
import {parseChapterLines, validateChapters, suggestChapterLines} from './delivery_text.mjs';
import {signature} from './recovery.mjs';
import {loadReleaseWorkspace, saveReleaseWorkspace, localDestination} from './release_workspace.mjs';
import {loadSocialWorkspace, saveSocialWorkspace, socialJobArgs} from './social_workspace.mjs';
import {trackedEpisodeLink} from './social_post_kit.mjs';
import {createStudioServer} from './server.mjs';

const input={episode_number:3,title:'A useful workflow',summary:'A & B <discuss> a workflow.',article_urls:'https://news.example.org/article',youtube_url:'https://youtu.be/abcdefghijk',chapters:'00:00 Tool Bench: Making tools\n02:00 Listener Mail: Education\n04:00 World Desk: News'};
// A fictional show with three recurring segments, used to exercise the optional chapter rules.
const segmented=normalizeShowConfig({show_name:'Sample Show',links:{website:'https://example.com/podcast'},release:{chapters:{enforce_from_episode:3,min_count:3,min_duration_seconds:120,required_segment_prefixes:['Tool Bench','Listener Mail','World Desk']}}});
test('saving or discarding one note retains other drafts and typing during a save',()=>{
  const d=createNoteDrafts(),first={notes:'first'};d.set('a',first);d.set('b',{notes:'second'});
  d.saved('a',first);assert.equal(d.get('b').notes,'second');assert.equal(d.dirty,true);
  d.set('a',{notes:'newer typing'});d.saved('a',first);assert.equal(d.get('a').notes,'newer typing');
  d.discard('b');assert.equal(d.dirty,true);d.discard('a');assert.equal(d.dirty,false);
});
test('platform copy follows title, link, HTML and size rules without approval',()=>{
  const c=buildReleaseCopy(input);assert.equal(c.titles.youtube,'A useful workflow | Ep. 3');assert.equal(c.titles.podcast_rss,input.title);
  assert.match(c.spotify_html,/A &amp; B &lt;discuss&gt;/);assert.match(c.spotify_html,/utm_source=podcast_feed&amp;utm_medium=podcast&amp;utm_campaign=ep003/);
  assert.match(c.youtube_description,/utm_source=youtube&/);assert.match(c.spotify_html,/href="https:\/\/news.example.org\/article"/);
  assert.match(c.spotify_html,/href="https:\/\/youtu.be\/abcdefghijk"/);assert.equal(c.publication_authorized,false);
  assert.throws(()=>buildReleaseCopy({...input,summary:'x'.repeat(3500)}),/4,000/);
  assert.throws(()=>buildReleaseCopy({...input,title:'x'.repeat(99)}),/100/);
  assert.throws(()=>buildReleaseCopy({...input,youtube_url:'https://youtu.be/short'}),/watch URL/);
  assert.throws(()=>buildReleaseCopy({...input,end_screen_video_url:input.youtube_url}),/different full episode/);
  assert.throws(()=>buildReleaseCopy({...input,end_screen_playlist_url:'https://youtube.com/watch?v=abcdefghijk'}),/playlist/);
  assert.throws(()=>buildReleaseCopy({...input,pinned_comment:'x'.repeat(1001)}),/1,000/);
  assert.ok(c.missing.some(x=>x.includes('pinned question')));
  assert.throws(()=>websiteLink('https://other.example','youtube',3),/configured show website/);
  assert.match(websiteLink('https://example.com/podcast','youtube',3),/utm_campaign=ep003/);
  for(const title of ['#AI tricks','Episode 3','ep003','SHOW_EP3_Test.mp4','Example Podcast'])assert.throws(()=>validateShortTitle(title));
  assert.equal(validateShortTitle('A better way to learn'),'A better way to learn');
  assert.equal(trackedEpisodeLink({destinationUrl:'https://youtu.be/abcdefghijk',source:'youtube',episodeId:'ep003',clipId:'clip_001'}),'https://youtu.be/abcdefghijk');
});
test('naming requests accept three to five title options',()=>{
  const args={slug:'test',segments:[{id:'a',start:'00:00:00.000',end:'00:00:02.000',text:'A thought',speaker:'Host'}],policyVersion:'v1',policyFingerprint:'a'.repeat(64)};
  const request=buildEpisodeNamingRequest({...args,episodeNumber:3});
  const candidates=Array.from({length:6},(_,i)=>({canonical_title:`Useful Topic ${i+1}`,lane:'balanced',rationale:'An accurate transcript-based angle.'}));
  const proposal=count=>({schema:EPISODE_NAMING_PROPOSAL_SCHEMA,request_fingerprint:request.request_fingerprint,candidates:candidates.slice(0,count)});
  for(const count of [3,5]) assert.equal(validateEpisodeNamingProposal(proposal(count),request).candidates.length,count);
  for(const count of [2,6]) assert.throws(()=>validateEpisodeNamingProposal(proposal(count),request),/3–5 title options/);
});
test('default chapter rules need three increasing chapters from 00:00 and suggest a neutral set',()=>{
  const chapters=parseChapterLines(input.chapters.split(/\r?\n/));assert.equal(validateChapters(chapters,360000,3),chapters);
  validateChapters(parseChapterLines(['00:00 Welcome','00:10 Main','00:20 Closing']),30000,2);
  assert.throws(()=>validateChapters(parseChapterLines(['00:00 Welcome','00:10 Main']),30000,2),/at least three/);
  assert.equal(suggestChapterLines(360000,20000,3).length,3);
});
test('configured recurring segments are enforced from the configured episode, in any order, each once',()=>{
  const chapters=parseChapterLines(input.chapters.split(/\r?\n/));
  validateReleaseChapters(chapters,360000,3,segmented);
  validateReleaseChapters(chapters,359999,2,segmented);
  assert.throws(()=>validateReleaseChapters(chapters,359999,3,segmented),/at least 120 seconds/);
  const swapped=parseChapterLines(['00:00 Listener Mail: Education','02:00 Tool Bench: Making tools','04:00 World Desk: News','06:00 Closing: One Takeaway']);
  validateReleaseChapters(swapped,480000,4,segmented);
  validateReleaseChapters(swapped.map(c=>({...c,title:c.title.replace('’',"'")})),480000,4,segmented);
  assert.throws(()=>validateReleaseChapters(swapped.map((c,i)=>i===1?{...c,title:'Listener Mail: Duplicate'}:c),480000,4,segmented),/each used once/);
  assert.throws(()=>validateReleaseChapters(swapped.map((c,i)=>i===2?{...c,title:'Second story'}:c),480000,4,segmented),/configured segment names/);
  assert.throws(()=>validateReleaseChapters(swapped.map((c,i)=>i===0?{...c,title:'Listener Mail: '+'x'.repeat(100)}:c),480000,4,segmented),/1–100 characters/);
  assert.throws(()=>validateReleaseChapters(swapped.slice(0,2),240000,4,segmented),/at least 3 chapters/);
});
test('approved segment titles are kept exactly and long ones report a display warning',()=>{
  const titles=['Listener Mail: What a Weekly Deadline Made Possible Here','Tool Bench: A portable notebook','World Desk: Career growth in a new technology era','World Desk: Making time to learn','Closing: One Takeaway'];
  const lines=titles.map((title,i)=>`${['00:00','13:40','29:21','38:47','43:45'][i]} ${title}`);
  const chapters=parseChapterLines(lines);
  validateChapters(chapters,2774467,4);
  const warnings=validateChapterTitleAuthority(chapters,titles);
  assert.deepEqual(warnings.map(w=>[w.title,w.characters]),[[titles[0],titles[0].length],[titles[2],titles[2].length]]);
  const copy=buildReleaseCopy({...input,episode_number:4,chapters:lines.join('\n')});
  assert.deepEqual(copy.chapter_warnings,warnings);
  for(const title of titles) assert.ok(copy.youtube_description.includes(title));
  assert.deepEqual(chapters.map(c=>c.title),titles);
  assert.throws(()=>validateChapterTitleAuthority(chapters.map((c,i)=>i===0?{...c,title:'Listener Mail: Learning by doing'}:c),titles),/approved segment\/topic title/);
  assert.throws(()=>validateChapterTitleAuthority(chapters,titles.slice(1)),/every chapter/);
});
test('release and social drafts reject changed revisions, source mismatches, approval shortcuts and symlink writes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'eaol-release-'));
  try {
    const master=join(dir,'final.mp4');writeFileSync(master,'bytes');
    const sha=createHash('sha256').update('bytes').digest('hex');
    const episode={slug:'ep003_trial',recovery:{}};
    const files={final:{receipt:{output:{path:master,signature:signature(master),sha256:sha},checks:{durationSec:360}}}};
    let state=loadReleaseWorkspace(dir,episode,files);assert.equal(state.source.duration_ms,360000);
    state=saveReleaseWorkspace(dir,episode,files,{revision:state.revision,input});assert.equal(state.copy_stale,false);
    assert.throws(()=>saveReleaseWorkspace(dir,episode,files,{revision:'old',input}),/changed/);
    const body={schema:'eaol-portable-social-source-v1',source:{sha256:sha,bytes:5,width:3840,height:2160},timeline_shift_ms:0,program:{start_ms:0,end_ms:360000},shots:[{start_ms:0,end_ms:360000}],graphics:[],framing_presets:{host_1:{mode:'crop',x:420,y:240,width:1080,height:1920}},cues:[{segment_id:'a',start_ms:10000,end_ms:20000,speaker_id:'host_1',text:'First complete thought.'},{segment_id:'b',start_ms:20000,end_ms:30000,speaker_id:'host_1',text:'Second complete thought.'}]};
    const pack={...body,fingerprint:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
    let social=loadSocialWorkspace(dir,state.source);
    social=saveSocialWorkspace(dir,state.source,{revision:social.revision,pack});
    social=saveSocialWorkspace(dir,state.source,{revision:social.revision,title:'Useful thought',start_ms:10000,end_ms:30000,layout:'host_1'});
    assert.equal(social.drafts.length,1);assert.equal(social.drafts[0].selection.editorial_approval,'pending');
    assert.throws(()=>socialJobArgs('.',dir,social,{revision:social.revision,id:social.drafts[0].id}),/Confirm/);
    assert.equal(socialJobArgs('.',dir,social,{revision:social.revision,id:social.drafts[0].id,confirmLocalRender:true}).length,5);
    const stale=loadSocialWorkspace(dir,{...state.source,key:'changed'});assert.equal(stale.stale,true);
    assert.throws(()=>socialJobArgs('.',dir,stale,{confirmLocalRender:true}),/matching/);
    assert.equal(social.publication_authorized,false);assert.equal(existsSync(join(dir,'social_workspace')),false,'saving does not render');
    assert.throws(()=>localDestination(dir,'../escape'),/Invalid/);
    symlinkSync(join(dir,'absent'),join(dir,'linked'));assert.throws(()=>localDestination(dir,'linked','output'),/Symlink/);
    writeFileSync(master,'changed');assert.equal(loadReleaseWorkspace(dir,episode,files).source,null);
    assert.equal(loadReleaseWorkspace(dir,episode,files).copy_stale,true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('new API routes preserve source-less episodes and reject external-origin writes and escaped workspaces',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'eaol-release-api-'));let server;
  try {
    const ep=join(dir,'work','ep003_trial');mkdirSync(ep,{recursive:true});writeFileSync(join(ep,'meta.json'),JSON.stringify({source:join(ep,'missing.mp4'),duration_sec:360}));
    server=createStudioServer({workRoot:join(dir,'work')});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
    const url=base+'/api/episodes/ep003_trial/release-workspace';let r=await fetch(url);assert.equal(r.status,200);let state=await r.json();assert.equal(state.source,null);
    r=await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,input})});assert.equal(r.status,200);state=await r.json();assert.ok(state.copy.pending.includes('Verify chapter timing against the completed export'));
    assert.equal(state.copy_stale,false);
    const brief=await (await fetch(url+'/brief')).text();assert.match(brief,/release brief/);assert.ok(!brief.includes(dir));
    const briefJson=await (await fetch(url+'/brief-json')).json();assert.equal(briefJson.upload_authorized,false);assert.equal(briefJson.publication_authorized,false);
    r=await fetch(url,{method:'PUT',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({revision:state.revision,input})});assert.equal(r.status,403);
    assert.equal((await fetch(base+'/api/episodes/ep003_trial/social-workspace')).status,200);
    mkdirSync(join(dir,'outside'));symlinkSync(join(dir,'outside'),join(dir,'work','escaped'));
    for(const route of ['release-workspace','social-workspace'])assert.equal((await fetch(base+'/api/episodes/escaped/'+route)).status,400);
    assert.equal((await (await fetch(base+'/api/show-config')).json()).show.show_name,'Example Podcast');
    assert.equal(existsSync(join(ep,'studio_job.json')),false);
  } finally {if(server)await new Promise(ok=>server.close(ok));rmSync(dir,{recursive:true,force:true});}
});
