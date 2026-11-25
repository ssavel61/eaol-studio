#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALGORITHM = "envelope-correlation-v1";
const PCM_RATE = 8000;
const ENVELOPE_HZ = 100;
const WINDOW_SEC = 60;
const MAX_LAG_SEC = 15;
const MIN_CONFIDENCE = 0.28;
const MIN_STABLE_CONFIDENCE = 0.15;
const MAX_STABLE_DRIFT_MS = 50;
const MIN_PAIR_RAW_CONFIDENCE = 0.08;
const MIN_PAIR_PROGRAM_CONFIDENCE = 0.06;

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function normalize(values) {
  if (!values.length) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance) || 1;
  return values.map((value) => (value - mean) / deviation);
}

export function envelopeFromPcm(buffer, sampleRate = PCM_RATE, envelopeHz = ENVELOPE_HZ) {
  const bucketSize = Math.max(1, Math.round(sampleRate / envelopeHz));
  const rms = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += bucketSize * 2) {
    let sum = 0;
    let count = 0;
    const end = Math.min(buffer.length, offset + bucketSize * 2);
    for (let index = offset; index + 1 < end; index += 2) {
      const sample = buffer.readInt16LE(index) / 32768;
      sum += sample * sample;
      count++;
    }
    rms.push(Math.log1p(30 * Math.sqrt(sum / Math.max(1, count))));
  }
  const transients = rms.map((value, index) => (index ? value - rms[index - 1] : 0));
  return normalize(transients);
}

export function findBestLag(reference, target, maxLagSamples) {
  let best = { lag: 0, confidence: -1 };
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
    const referenceStart = Math.max(0, -lag);
    const targetStart = Math.max(0, lag);
    const length = Math.min(reference.length - referenceStart, target.length - targetStart);
    if (length < Math.min(reference.length, target.length) * 0.55) continue;
    let dot = 0;
    let refPower = 0;
    let targetPower = 0;
    for (let index = 0; index < length; index++) {
      const a = reference[referenceStart + index];
      const b = target[targetStart + index];
      dot += a * b;
      refPower += a * a;
      targetPower += b * b;
    }
    const confidence = dot / Math.sqrt(Math.max(1e-12, refPower * targetPower));
    if (confidence > best.confidence) best = { lag, confidence };
  }
  return best;
}

function positionScore(reference, target, position, stride = 1) {
  const referenceStart = Math.max(0, -position);
  const targetStart = Math.max(0, position);
  const length = Math.min(reference.length - referenceStart, target.length - targetStart);
  if (length < reference.length * 0.55) return -1;
  let dot = 0;
  let refPower = 0;
  let targetPower = 0;
  for (let index = 0; index < length; index += stride) {
    const a = reference[referenceStart + index];
    const b = target[targetStart + index];
    dot += a * b;
    refPower += a * a;
    targetPower += b * b;
  }
  return dot / Math.sqrt(Math.max(1e-12, refPower * targetPower));
}

export function findBestPosition(reference, target, {
  minPosition = -Math.round(reference.length * 0.45),
  maxPosition = target.length - Math.round(reference.length * 0.55),
  coarseStep = 50,
  sampleStride = 5,
} = {}) {
  const minimum = Math.ceil(minPosition);
  const maximum = Math.floor(maxPosition);
  if (maximum < minimum) return { position: 0, confidence: -1 };
  const step = Math.max(1, Math.round(coarseStep));
  const stride = Math.max(1, Math.round(sampleStride));
  let coarse = { position: minimum, confidence: -1 };
  for (let position = minimum; position <= maximum; position += step) {
    const confidence = positionScore(reference, target, position, stride);
    if (confidence > coarse.confidence) coarse = { position, confidence };
  }
  let best = { position: coarse.position, confidence: -1 };
  const refineStart = Math.max(minimum, coarse.position - step);
  const refineEnd = Math.min(maximum, coarse.position + step);
  for (let position = refineStart; position <= refineEnd; position++) {
    const confidence = positionScore(reference, target, position);
    if (confidence > best.confidence) best = { position, confidence };
  }
  return best;
}

export function classifyMeasurement(confidence, driftMs) {
  return confidence >= MIN_CONFIDENCE
    || (confidence >= MIN_STABLE_CONFIDENCE && Math.abs(driftMs) <= MAX_STABLE_DRIFT_MS)
    ? "measured"
    : "low_confidence";
}

function extractEnvelope(source, startSec, windowSec) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-ss", String(Math.max(0, startSec)), "-t", String(windowSec),
      "-i", source.path, "-vn", "-ac", "1", "-ar", String(PCM_RATE),
      "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1",
    ],
    { encoding: null, maxBuffer: Math.max(32 * 1024 * 1024, Math.ceil(windowSec * PCM_RATE * 2 * 1.2)) },
  );
  if (result.error) throw new Error(`ffmpeg failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${source.label} audio extraction failed: ${String(result.stderr || "")}`);
  const envelope = envelopeFromPcm(result.stdout);
  if (envelope.length < ENVELOPE_HZ * 3) throw new Error(`${source.label} has too little shared audio to measure`);
  return envelope;
}

export function manifestSourceSignature(source) {
  const parts = Array.isArray(source.parts) ? source.parts.map((part) => [
    String(part.id || ""),
    resolve(String(part.path || "")),
    Number(part.bytes || 0),
    Number(part.modified_ms || 0),
    String(part.sha256 || ""),
    Number(part.order || 0),
  ]) : [];
  return JSON.stringify([
    String(source.id || ""),
    resolve(String(source.path || "")),
    Number(source.bytes || 0),
    Number(source.modified_ms || 0),
    String(source.sequence_fingerprint || ""),
    parts,
  ]);
}

export function currentSourceSignature(source) {
  const stat = statSync(source.path);
  const parts = Array.isArray(source.parts) ? source.parts.map((part) => {
    const partStat = statSync(part.path);
    return [
      String(part.id || ""),
      resolve(String(part.path || "")),
      partStat.size,
      Math.round(partStat.mtimeMs),
      String(part.sha256 || ""),
      Number(part.order || 0),
    ];
  }) : [];
  return JSON.stringify([
    String(source.id || ""),
    resolve(String(source.path || "")),
    stat.size,
    Math.round(stat.mtimeMs),
    String(source.sequence_fingerprint || ""),
    parts,
  ]);
}

export function sourceReceiptsAreCurrent(sources) {
  try {
    return sources.every((source) => manifestSourceSignature(source) === currentSourceSignature(source));
  } catch {
    return false;
  }
}

export function analyzeSources(manifest) {
  const sources = manifest.sources || [];
  if (!sourceReceiptsAreCurrent(sources)) {
    throw new Error("one or more source files changed since intake; run source checks again before sync analysis");
  }
  const reference = sources.find((source) => source.id === "primary_camera");
  if (!reference) throw new Error("the episode has no Host 1 camera receipt");
  if (!reference.audio) throw new Error("the Host 1 camera has no audio stream to use as the sync reference");
  const targets = sources.filter((source) => source.id !== reference.id);
  if (!targets.length) throw new Error("add at least one companion camera or audio track before sync analysis");
  const referenceWindow = Math.min(WINDOW_SEC, reference.duration_sec);
  const refStartEnvelope = extractEnvelope(reference, 0, referenceWindow);
  const refEndStart = Math.max(0, reference.duration_sec - referenceWindow);
  const refEndEnvelope = extractEnvelope(reference, refEndStart, referenceWindow);
  const results = [];
  for (const target of targets) {
    if (!target.audio) {
      results.push({ source_id: target.id, label: target.label, status: "blocked", error: "no audio stream" });
      continue;
    }
    try {
      const maxLag = MAX_LAG_SEC * ENVELOPE_HZ;
      const hasWideBoundaryDifference = Math.abs(target.duration_sec - reference.duration_sec) > MAX_LAG_SEC * 2;
      let start;
      let end;
      let startOffsetMs;
      let endOffsetMs;
      if (hasWideBoundaryDifference && target.duration_sec > referenceWindow) {
        const targetEnvelope = extractEnvelope(target, 0, target.duration_sec);
        start = findBestPosition(refStartEnvelope, targetEnvelope, {
          minPosition: -maxLag,
          maxPosition: targetEnvelope.length - Math.round(refStartEnvelope.length * 0.55),
        });
        const expectedEndPosition = start.position + Math.round(refEndStart * ENVELOPE_HZ);
        end = findBestPosition(refEndEnvelope, targetEnvelope, {
          minPosition: expectedEndPosition - maxLag,
          maxPosition: expectedEndPosition + maxLag,
          coarseStep: Math.max(1, Math.round(ENVELOPE_HZ / 10)),
        });
        startOffsetMs = Math.round((start.position / ENVELOPE_HZ) * 1000);
        endOffsetMs = Math.round(((end.position / ENVELOPE_HZ) - refEndStart) * 1000);
      } else {
        const targetWindow = Math.min(WINDOW_SEC, target.duration_sec);
        const startEnvelope = extractEnvelope(target, 0, targetWindow);
        const targetEndStart = Math.max(0, target.duration_sec - targetWindow);
        const endEnvelope = extractEnvelope(target, targetEndStart, targetWindow);
        start = findBestLag(refStartEnvelope, startEnvelope, maxLag);
        end = findBestLag(refEndEnvelope, endEnvelope, maxLag);
        startOffsetMs = Math.round((start.lag / ENVELOPE_HZ) * 1000);
        endOffsetMs = Math.round((targetEndStart - refEndStart + end.lag / ENVELOPE_HZ) * 1000);
      }
      const confidence = Math.min(start.confidence, end.confidence);
      const driftMs = endOffsetMs - startOffsetMs;
      results.push({
        source_id: target.id,
        label: target.label,
        status: classifyMeasurement(confidence, driftMs),
        start_offset_ms: startOffsetMs,
        end_offset_ms: endOffsetMs,
        drift_ms: driftMs,
        start_confidence: Number(start.confidence.toFixed(3)),
        end_confidence: Number(end.confidence.toFixed(3)),
      });
    } catch (error) {
      results.push({ source_id: target.id, label: target.label, status: "blocked", error: error.message });
    }
  }
  const hostOne = sources.find((source) => source.id === "host_1_audio");
  const hostTwo = sources.find((source) => source.id === "host_2_audio");
  const hostOneResult = results.find((result) => result.source_id === "host_1_audio");
  const hostTwoIndex = results.findIndex((result) => result.source_id === "host_2_audio");
  if (hostOne?.audio && hostTwo?.audio && hostOneResult?.status === "measured" && hostTwoIndex >= 0 && results[hostTwoIndex].status !== "measured") {
    try {
      const pairWindow = Math.min(WINDOW_SEC, hostOne.duration_sec, hostTwo.duration_sec);
      const rawPair = findBestLag(
        extractEnvelope(hostOne, 0, pairWindow),
        extractEnvelope(hostTwo, 0, pairWindow),
        MAX_LAG_SEC * ENVELOPE_HZ,
      );
      const candidateOffsetSec = hostOneResult.start_offset_ms / 1000 + rawPair.lag / ENVELOPE_HZ;
      if (candidateOffsetSec >= 0 && candidateOffsetSec + refEndStart + referenceWindow <= hostTwo.duration_sec) {
        const pairStart = findBestLag(
          extractEnvelope(hostOne, hostOneResult.start_offset_ms / 1000, referenceWindow),
          extractEnvelope(hostTwo, candidateOffsetSec, referenceWindow),
          MAX_LAG_SEC * ENVELOPE_HZ,
        );
        const pairEnd = findBestLag(
          extractEnvelope(hostOne, hostOneResult.end_offset_ms / 1000 + refEndStart, referenceWindow),
          extractEnvelope(hostTwo, candidateOffsetSec + refEndStart, referenceWindow),
          MAX_LAG_SEC * ENVELOPE_HZ,
        );
        const startOffsetMs = Math.round((candidateOffsetSec + pairStart.lag / ENVELOPE_HZ) * 1000);
        const endOffsetMs = Math.round((candidateOffsetSec + pairEnd.lag / ENVELOPE_HZ) * 1000);
        const driftMs = endOffsetMs - startOffsetMs;
        const pairConfidence = Math.min(pairStart.confidence, pairEnd.confidence);
        const corroborated = rawPair.confidence >= MIN_PAIR_RAW_CONFIDENCE
          && pairConfidence >= MIN_PAIR_PROGRAM_CONFIDENCE
          && Math.abs(driftMs) <= MAX_STABLE_DRIFT_MS;
        results[hostTwoIndex] = {
          source_id: hostTwo.id,
          label: hostTwo.label,
          status: corroborated ? "measured" : "low_confidence",
          start_offset_ms: startOffsetMs,
          end_offset_ms: endOffsetMs,
          drift_ms: driftMs,
          start_confidence: Number(pairStart.confidence.toFixed(3)),
          end_confidence: Number(pairEnd.confidence.toFixed(3)),
          method: "isolated-pair-corroboration",
          raw_pair_offset_ms: Math.round((rawPair.lag / ENVELOPE_HZ) * 1000),
          raw_pair_confidence: Number(rawPair.confidence.toFixed(3)),
        };
      }
    } catch {
      // Preserve the direct low-confidence result; the UI will keep the sync gate closed.
    }
  }
  const hasBlocked = results.some((result) => result.status === "blocked");
  const hasLowConfidence = results.some((result) => result.status === "low_confidence");
  return {
    schema: "eaol-sync-v1",
    algorithm: ALGORITHM,
    analyzed_at: new Date().toISOString(),
    reference_source_id: reference.id,
    input_signatures: sources.map(currentSourceSignature),
    settings: {
      pcm_rate: PCM_RATE,
      envelope_hz: ENVELOPE_HZ,
      window_sec: WINDOW_SEC,
      max_lag_sec: MAX_LAG_SEC,
      min_confidence: MIN_CONFIDENCE,
      min_stable_confidence: MIN_STABLE_CONFIDENCE,
      max_stable_drift_ms: MAX_STABLE_DRIFT_MS,
      min_pair_raw_confidence: MIN_PAIR_RAW_CONFIDENCE,
      min_pair_program_confidence: MIN_PAIR_PROGRAM_CONFIDENCE,
    },
    status: hasBlocked ? "blocked" : hasLowConfidence ? "attention" : "review_required",
    results,
    review: { status: "pending", notes: "", reviewed_at: null },
  };
}

function main() {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf("--run");
  if (runIndex < 0 || !args[runIndex + 1]) fail("Usage: node studio/sync.mjs --run work/<episode>");
  const workDir = resolve(args[runIndex + 1]);
  const manifestPath = join(workDir, "episode.json");
  if (!existsSync(manifestPath)) fail(`${basename(workDir)} has no multi-source episode receipt`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  console.log(`Reference: ${manifest.sources?.find((source) => source.id === "primary_camera")?.label || "Host 1 camera"}`);
  console.log("Measuring shared waveforms near the start and end…");
  let receipt;
  try {
    receipt = analyzeSources(manifest);
  } catch (error) {
    fail(error.message);
  }
  writeFileSync(join(workDir, "sync.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(workDir, "sync_review.json"), `${JSON.stringify({
    schema: "eaol-sync-review-v1",
    status: "pending",
    notes: "",
    reviewed_at: null,
    input_signatures: receipt.input_signatures,
  }, null, 2)}\n`);
  for (const result of receipt.results) {
    if (result.status === "blocked") console.log(`BLOCKED ${result.label}: ${result.error}`);
    else console.log(`${result.label}: start ${result.start_offset_ms}ms · end ${result.end_offset_ms}ms · drift ${result.drift_ms}ms · ${result.status}`);
  }
  console.log(`Sync analysis: ${receipt.status}. Human confirmation is still required.`);
  if (receipt.status === "blocked") process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
