// End-to-end run on a generated episode: colour-bar cameras and gated-noise
// microphones made by ffmpeg at test time. No real recording, no whisper.
// It drives the same HTTP routes the Studio page uses, from intake through the
// camera plan, then changes a source file and checks that receipts go stale.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer } from "./server.mjs";
import {
  SYNTHETIC_OFFSETS_SEC,
  SYNTHETIC_SLUG,
  ingestSyntheticEpisode,
  makeSyntheticEpisode,
} from "../scripts/make-synthetic-episode.mjs";

test("synthetic episode runs from intake to an explained camera plan, and receipts go stale when a source changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "eaol-synthetic-"));
  let server;
  try {
    const episode = makeSyntheticEpisode({ outDir: join(root, "media"), durationSec: 40 });
    const workRoot = join(root, "work");
    const workDir = ingestSyntheticEpisode(episode.files, workRoot);
    const read = (name) => JSON.parse(readFileSync(join(workDir, name), "utf8"));

    const manifest = read("episode.json");
    assert.deepEqual(manifest.sources.map((source) => source.id), ["primary_camera", "secondary_camera", "host_1_audio", "host_2_audio"]);
    assert.equal(manifest.compatibility.blocking.length, 0);
    assert.equal(manifest.transcription.status, "not_run", "intake does not need whisper");

    server = createStudioServer({ workRoot });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = "GET", body) => {
      const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const runJob = async (path, body = {}) => {
      const started = await request(path, "POST", body);
      assert.equal(started.status, 202, JSON.stringify(started.body));
      let job = started.body.job;
      while (job.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        job = (await request(`/api/jobs/${job.id}`)).body.job;
      }
      assert.equal(job.status, "complete", (job.logs || []).join("\n"));
      return job;
    };
    const api = `/api/episodes/${SYNTHETIC_SLUG}`;

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Explore AI Out Loud Studio/);
    const listed = await request("/api/episodes");
    assert.ok(listed.body.episodes.some((item) => item.slug === SYNTHETIC_SLUG));

    // Sync: envelope correlation must recover the offsets the generator built in.
    await runJob(`${api}/sync`);
    const sync = read("sync.json");
    assert.equal(sync.status, "review_required");
    const offset = (id) => sync.results.find((result) => result.source_id === id).start_offset_ms;
    const cameraLagMs = SYNTHETIC_OFFSETS_SEC.host_1_camera * 1000;
    assert.ok(Math.abs(offset("host_1_audio") + cameraLagMs) <= 20, `host 1 mic offset ${offset("host_1_audio")}`);
    assert.ok(Math.abs(offset("host_2_audio") + cameraLagMs) <= 20, `host 2 mic offset ${offset("host_2_audio")}`);
    const cameraDeltaMs = (SYNTHETIC_OFFSETS_SEC.host_2_camera - SYNTHETIC_OFFSETS_SEC.host_1_camera) * 1000;
    assert.ok(Math.abs(offset("secondary_camera") - cameraDeltaMs) <= 20, `camera offset ${offset("secondary_camera")}`);

    // A human approval sits between stages: the timeline refuses to build without it.
    assert.equal((await request(`${api}/timeline`, "POST", {})).status, 400);
    assert.equal((await request(`${api}/sync-review`, "PUT", { status: "approved", notes: "synthetic" })).status, 200);
    assert.equal((await request(`${api}/timeline`, "POST", {})).status, 200);
    assert.equal((await request(`${api}/timeline-review`, "PUT", { status: "approved", checked_start: true, checked_end: true })).status, 200);

    // Speaker activity is locked until the microphone channel check passes.
    const locked = await request(`${api}/speaker-activity`, "POST", {});
    assert.equal(locked.status, 400);
    assert.match(locked.body.error, /channel/);
    await runJob(`${api}/channel-preflight`, { source_id: "isolated_masters" });
    assert.equal(read("channel_preflight.json").status, "passed");
    await runJob(`${api}/speaker-activity`);
    const activity = read("speaker_activity.json");
    const states = new Set(activity.segments.map((segment) => segment.state));
    assert.ok(states.has("host_1") && states.has("host_2"), `speaker states: ${[...states].join(", ")}`);

    const planned = await request(`${api}/camera-plan`, "POST", {});
    assert.equal(planned.status, 200, JSON.stringify(planned.body).slice(0, 300));
    const plan = read("camera_decision_manifest.json");
    assert.ok(plan.shots.length >= 1);
    for (const shot of plan.shots) assert.ok(typeof shot.reason_code === "string" && shot.reason_code.length > 0, "every shot carries a reason code");
    assert.equal(plan.render_authorized, false);
    assert.equal(plan.shots[0].start_ms, activity.segments[0].start_ms);

    const current = (await request(api)).body.episode;
    assert.equal(current.intake_stale, false);
    assert.equal(current.sync.stale, false);

    // Receipts are bound to source bytes. Change one source and they go stale.
    appendFileSync(episode.files.host_2_audio, Buffer.alloc(16));
    const changed = (await request(api)).body.episode;
    assert.equal(changed.intake_stale, true);
    assert.equal(changed.sync.stale, true);
    const refused = await request(`${api}/camera-plan`, "POST", {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /changed/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
