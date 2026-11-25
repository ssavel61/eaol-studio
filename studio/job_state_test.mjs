#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiskPreflight,
  JOB_JOURNAL_FILENAME,
  loadJobJournals,
  publicJob,
  refreshRecoveredJob,
  writeJobJournal,
} from "./job_state.mjs";

const root = mkdtempSync(join(tmpdir(), "eaol-job-state-test-"));

try {
  const source = join(root, "source.mp4");
  writeFileSync(source, Buffer.alloc(1_000));

  const passing = buildDiskPreflight({
    workRoot: root,
    sourcePaths: [source, source],
    availableBytes: 5 * 1024 ** 3,
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.source_bytes, 1_000);
  assert.equal(passing.required_bytes, 2 * 1024 ** 3);

  const blocked = buildDiskPreflight({
    workRoot: root,
    sourcePaths: [source],
    availableBytes: 256 * 1024 ** 2,
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.required_bytes > blocked.available_bytes);

  const complete = {
    id: "complete-job",
    type: "render",
    slug: "complete_episode",
    status: "complete",
    logs: ["done"],
    started_at: "2026-08-16T12:00:00.000Z",
    completed_at: "2026-08-16T12:01:00.000Z",
  };
  writeJobJournal(root, complete);
  const completePath = join(root, complete.slug, JOB_JOURNAL_FILENAME);
  assert.equal(statSync(completePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(completePath, "utf8")).status, "complete");

  const dead = {
    id: "dead-job",
    type: "ingest",
    slug: "dead_episode",
    status: "running",
    pid: 999_999,
    logs: ["work began"],
    started_at: "2026-08-16T12:02:00.000Z",
  };
  writeJobJournal(root, dead);

  const live = {
    id: "live-job",
    type: "transcribe",
    slug: "live_episode",
    status: "running",
    pid: 123,
    logs: [],
    started_at: "2026-08-16T12:03:00.000Z",
  };
  writeJobJournal(root, live);

  const deadJobs = loadJobJournals(root, { isProcessAlive: () => false });
  const interrupted = deadJobs.find((job) => job.id === dead.id);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.recovered, true);
  assert.match(interrupted.error, /could verify this job's result/);
  assert.equal(JSON.parse(readFileSync(join(root, dead.slug, JOB_JOURNAL_FILENAME), "utf8")).status, "interrupted");

  writeJobJournal(root, live);
  const liveJobs = loadJobJournals(root, { isProcessAlive: (pid) => pid === 123 });
  const recovered = liveJobs.find((job) => job.id === live.id);
  assert.equal(recovered.status, "running");
  assert.equal(recovered.recovered, true);
  assert.match(recovered.logs.join("\n"), /reattached/);
  assert.equal(publicJob(recovered).pid, undefined);

  const terminal = { ...live, status: "complete", logs: ["exact output verified"], completed_at: "2026-08-16T12:04:00.000Z" };
  writeJobJournal(root, terminal);
  const refreshed = refreshRecoveredJob(root, recovered, { isProcessAlive: () => false });
  assert.equal(refreshed.status, "complete");
  assert.deepEqual(refreshed.logs, terminal.logs);
  assert.equal(JSON.parse(readFileSync(join(root, live.slug, JOB_JOURNAL_FILENAME))).status, "complete");
  writeJobJournal(root, { ...terminal, status: "failed", error: "decode failed" });
  assert.equal(refreshRecoveredJob(root, recovered, { isProcessAlive: () => false }).status, "failed");
  writeJobJournal(root, { ...terminal, id: "different-job" });
  assert.equal(refreshRecoveredJob(root, recovered, { isProcessAlive: () => false }).status, "interrupted");
  assert.equal(JSON.parse(readFileSync(join(root, live.slug, JOB_JOURNAL_FILENAME))).id, "different-job");

  mkdirSync(join(root, "malformed_episode"), { recursive: true });
  writeFileSync(join(root, "malformed_episode", JOB_JOURNAL_FILENAME), "not json");
  assert.doesNotThrow(() => loadJobJournals(root, { isProcessAlive: () => false }));

  console.log("PASS conservative disk-space preflight");
  console.log("PASS private atomic job journal");
  console.log("PASS dead recovered process becomes interrupted, never complete");
  console.log("PASS live recovered process remains reattachable without exposing its PID");
  console.log("PASS reattached process retains its matching terminal receipt; unrelated completion is not accepted");
  console.log("PASS malformed journal does not take Studio offline");
} finally {
  rmSync(root, { recursive: true, force: true });
}
