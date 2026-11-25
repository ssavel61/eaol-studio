import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const JOB_JOURNAL_FILENAME = "studio_job.json";
const MINIMUM_REQUIRED_BYTES = 2 * 1024 ** 3;
const SOURCE_HEADROOM_BYTES = 512 * 1024 ** 2;

export function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    slug: job.slug,
    status: job.status,
    logs: Array.isArray(job.logs) ? job.logs : [],
    started_at: job.started_at,
    completed_at: job.completed_at || null,
    error: job.error || null,
    recovered: Boolean(job.recovered),
    preflight: job.preflight || null,
  };
}

export function formatBytes(bytes) {
  const gibibytes = Number(bytes || 0) / 1024 ** 3;
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`;
}

export function buildDiskPreflight({ workRoot, sourcePaths = [], availableBytes } = {}) {
  const uniquePaths = [...new Set(sourcePaths.filter(Boolean))];
  const sourceBytes = uniquePaths.reduce((total, path) => {
    try {
      const stat = statSync(path);
      return stat.isFile() ? total + stat.size : total;
    } catch {
      return total;
    }
  }, 0);
  const fileSystem = Number.isFinite(Number(availableBytes)) ? null : statfsSync(workRoot);
  const available = fileSystem
    ? Number(fileSystem.bavail) * Number(fileSystem.bsize)
    : Number(availableBytes);
  const required = Math.max(
    MINIMUM_REQUIRED_BYTES,
    Math.ceil(sourceBytes * 0.15 + SOURCE_HEADROOM_BYTES),
  );
  return {
    method: "conservative-local-v1",
    source_bytes: sourceBytes,
    required_bytes: required,
    available_bytes: available,
    ok: available >= required,
  };
}

function atomicWrite(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeJobJournal(workRoot, job) {
  const path = join(workRoot, job.slug, JOB_JOURNAL_FILENAME);
  const receipt = {
    schema: "eaol-studio-job-v1",
    ...job,
    logs: Array.isArray(job.logs) ? job.logs.slice(-300) : [],
  };
  atomicWrite(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return path;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function interruptedJob(job) {
  const recoveryLine = "Studio restarted before it could verify this job's result. Start it again; valid completed phases will be reused.";
  return {
    ...job,
    status: "interrupted",
    recovered: true,
    completed_at: job.completed_at || new Date().toISOString(),
    error: recoveryLine,
    logs: [...(Array.isArray(job.logs) ? job.logs : []), recoveryLine].slice(-300),
  };
}

export function refreshRecoveredJob(workRoot, job, options = {}) {
  if (job.status !== "running" || !job.recovered) return job;
  // A process reattached after restart can finish and write its own receipt.
  // Read that result before treating its later exit as an interruption.
  try {
    const latest = JSON.parse(readFileSync(join(workRoot, job.slug, JOB_JOURNAL_FILENAME), "utf8"));
    if (latest.id && latest.id !== job.id) return interruptedJob(job);
    if (latest.id === job.id && latest.slug === job.slug && latest.pid === job.pid
      && latest.started_at === job.started_at && latest.completed_at
      && ["complete", "failed", "interrupted"].includes(latest.status)) {
      return { ...latest, recovered: true };
    }
  } catch {
    // Missing/malformed or unrelated journals do not prove completion.
  }
  const checkProcess = options.isProcessAlive || isProcessAlive;
  if (checkProcess(job.pid)) return job;
  const interrupted = interruptedJob(job);
  writeJobJournal(workRoot, interrupted);
  return interrupted;
}

export function loadJobJournals(workRoot, options = {}) {
  if (!existsSync(workRoot)) return [];
  const checkProcess = options.isProcessAlive || isProcessAlive;
  const jobs = [];
  for (const entry of readdirSync(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(workRoot, entry.name, JOB_JOURNAL_FILENAME);
    if (!existsSync(path)) continue;
    let job;
    try {
      job = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // A malformed or externally edited receipt is ignored instead of making
      // Studio unavailable. New jobs replace it atomically.
      continue;
    }
    if (!job?.id || !job?.slug || !job?.status) continue;
    if (job.status === "running") {
      job = { ...job, recovered: true };
      if (checkProcess(job.pid)) {
        const recoveryLine = "Studio reattached to this running local process after restart.";
        if (!job.logs?.includes(recoveryLine)) {
          job.logs = [...(Array.isArray(job.logs) ? job.logs : []), recoveryLine].slice(-300);
          try {
            writeJobJournal(workRoot, job);
          } catch {
            job.error = "Studio reattached, but could not update the on-disk job journal.";
          }
        }
      } else {
        job = interruptedJob(job);
        try {
          writeJobJournal(workRoot, job);
        } catch {
          job.error = "Studio could not verify the prior result or update its on-disk job journal.";
        }
      }
    }
    jobs.push(job);
  }
  return jobs;
}
