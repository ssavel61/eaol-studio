# Clip selection and packaging rubric

This is the document an AI coding agent (or a person) follows when choosing clips. The code in this repository makes no model calls. It validates what the rubric-follower writes into `clips.json` and renders it.

The default Studio path uses deterministic transcript evidence to reduce review time, then requires human editorial selection, complete output watches, and one shared package for YouTube Shorts, Instagram Reels, and TikTok. It produces one clean editorial master per idea, not three edits. The transcribe and render lanes remain deterministic; visibility is an outcome to measure, not a score Studio may invent.

## Step 1 — Select (what makes a clip)

1. **Hook inside 3 seconds** — cold open on the boldest line; never on the question being asked, never "today we'll learn." Enter a few seconds after the setup; the most quotable sentence goes at 0:00.
2. **Self-contained** — the stranger test: no orphaned pronouns, no episode context required. "A movie trailer, not a highlight reel."
3. **One idea.** Multi-point cramming is the named cross-platform killer.
4. **Ends on a beat, then one closing line** — cut at the punchline, then 3–5 seconds naming the full episode, spoken and on screen ("The full conversation is in Episode N."). No outro card and no "like and subscribe": those signal "swipe now". Other CTAs live in post text and bio.
5. **Length: 15–90s hard contract bounds; prefer 25–60s.** 60–90s must be earned by the idea.
6. **Says its topic out loud early** — TikTok and Instagram index spoken words for search; a clip that names its subject in the first sentence is discoverable, one that circles it is not.
7. **The send test (Reels' top signal, good everywhere):** would a viewer send this to a specific coworker? Prefer "this is so us" over "this is interesting."
8. Clip-worthy shapes: counterintuitive claim · mistake→correction · list/steps · respectful disagreement · emotional peak · specific numbers and stakes.

## Step 2 — Package one master for three destinations

- **`hook_overlay`** (optional contract field): a brief, accurate payoff promise only when it adds meaning beyond the spoken captions. New suggestions leave it absent; repeated opening text is suppressed during social rendering. Watch the first three seconds silently for clarity and legibility. Do not invent a stronger claim, add a headline quota, or treat this as proof of retention. Curiosity wording versus a plain claim remains an editorial experiment.
- **One clean 1080×1920 master** — the exact same approved pixels and audio go to all three platforms. Do not download one platform's version and repost its watermark.
- **One core caption plus exactly three specific hashtags** — the wording stays identical. Studio adds only the platform-required funnel and fields:
  - **Shorts:** searchable title and description; attach the public full episode as the Related Video before publishing.
  - **TikTok:** use the tracked episode link in the bio when available; otherwise keep the full tracked URL visible in the caption so the destination is explicit even though it may not be clickable.
  - **Reels:** CTA to the tracked bio link; choose the 3:4 cover while keeping all essential content safe in the 9:16 composition.
- **Cadence:** assign the three selected ideas to Day 0, Day 5, and Day 10. Fewer than three requires a written quality-over-quota exception, not a filler clip.
- The post kit is where platform differences get applied per clip.

**Music in clips. This is a rule, not a preference:**

- **Never open a clip with the theme.** The first one to two seconds must be speech; that is the scroll-stop, and music spends it.
- **No music bed under dialogue.** On a phone speaker, music and speech compete for the same 300 Hz–4 kHz band, and the cognitive-load argument against scoring talking heads is stronger than any evidence for it. If a clip feels flat, that is an editing problem, not a music problem.
- **Ending:** no end card or sonic mark. Use the 3–5 second spoken or on-screen episode closing line.

## Step 3 — Reserve the learning loop (phase 2)

The local social delivery reserves campaign/content IDs and per-platform post IDs. Metrics ingestion is not part of this repository. If you track results, record hypotheses before publication in **`work/<slug>/predictions.json`**:

```json
{
  "schema": "eaol-predictions-v1",
  "predicted_at": "M.D.YY",
  "clips": [
    { "id": "clip_001",
      "best_platform": "tiktok",
      "why": "one line stating the reason",
      "ab_variables": { "hook_style": "curiosity-gap", "caption_style": "line" },
      "expected": "one falsifiable sentence (e.g. 'beats the account's median engaged-view rate')",
      "graded": null }
  ]
}
```

- Grade against **engaged views, completion and sends, never raw views**.
- When real numbers arrive, fill `graded` with the outcome and one line on what it says about the reason given in `why`. A wrong prediction that corrects an assumption is the system working.
- Open A/B variables: karaoke vs line captions · curiosity vs statement hooks · split vs single-speaker crops · loop vs clean endings.

## Step 4 — Validate and hand off

1. Approve each candidate in Studio; approval authorizes only local render eligibility.
2. Render one source-bound master, let technical QA finish, then watch it continuously and confirm opening, captions, crop, audio, and ending.
3. Approve the single three-platform package and release slot. Build the immutable local `social_delivery/vNNN/` bundle.
4. Copying, upload and publication happen outside Studio and need their own approval.

## The clips.json contract

The command line continues to accept this v1 shape for older episodes and manual workflows. Studio writes additive `eaol-clips-v2` records so the shared candidate inbox can preserve transcript segment IDs, proposer, proposal time, origin, and category. Both schemas feed the same deterministic render path; collaboration metadata never changes the pixels by itself.

```json
{
  "schema": "eaol-clips-v1",
  "source_slug": "<slug>",
  "selected_by": "who/what, and when",
  "clips": [
    { "id": "clip_001", "start": "00:01:12.340", "end": "00:01:58.900",
      "title": "working title", "hook": "first spoken line, verbatim from transcript",
      "rationale": "why this stands alone", "crop_offset_px": 0,
      "hook_overlay": "5-8 word payoff promise" }
  ]
}
```

Timestamps `HH:MM:SS.mmm`, snapped to SRT segment boundaries; duration 15–90s; `hook` quoted verbatim (receipts before claims); unknown fields, out-of-frame crops, and empty overlays are rejected loudly by render.mjs before any cutting. In Studio v2, candidate decisions remain separate in `studio_review.json`: `suggested | proposed | needs_discussion | approved | rejected`. Rejected ideas and attributed discussion are evidence and are not deleted.
