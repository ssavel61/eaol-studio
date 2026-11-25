import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { envelopeFromPcm, findBestPosition } from "./sync.mjs";

export const AUDIO_SEQUENCE_SCHEMA = "eaol-audio-sequence-v1";
const PCM_RATE = 8000;
const ENVELOPE_HZ = 100;
const EDGE_SEC = 20;
const SEARCH_MARGIN_SEC = 120;
const CONTINUITY_TOLERANCE_SEC = 0.25;
const MIN_MAPPING_CONFIDENCE = 0.1;

export function sha256File(path) {
  const hash = createHash("sha256");
  const file = createReadStream(path);
  return new Promise((accept, reject) => {
    file.on("data", (chunk) => hash.update(chunk));
    file.on("error", reject);
    file.on("end", () => accept(hash.digest("hex")));
  });
}

function runFfmpeg(args, { maxBuffer = 128 * 1024 * 1024 } = {}) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: null, maxBuffer });
  if (result.error) throw new Error(`ffmpeg failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(String(result.stderr || "ffmpeg could not analyze the audio sequence").trim());
  return result.stdout;
}

function extractEnvelope(path, startSec = null, durationSec = null) {
  const args = [];
  if (startSec != null) args.push("-ss", String(Math.max(0, startSec)));
  if (durationSec != null) args.push("-t", String(Math.max(0.1, durationSec)));
  args.push("-i", path, "-vn", "-ac", "1", "-ar", String(PCM_RATE), "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1");
  const pcm = runFfmpeg(args, {
    maxBuffer: Math.max(128 * 1024 * 1024, Math.ceil(Number(durationSec || 7_200) * PCM_RATE * 2 * 1.1)),
  });
  return envelopeFromPcm(pcm, PCM_RATE, ENVELOPE_HZ);
}

function cleanConfidence(value) {
  return Number(Number(value || 0).toFixed(3));
}

export function classifySeam(deltaSec, confidence) {
  if (!Number.isFinite(deltaSec) || confidence < MIN_MAPPING_CONFIDENCE) return "uncertain";
  if (deltaSec > CONTINUITY_TOLERANCE_SEC) return "gap";
  if (deltaSec < -CONTINUITY_TOLERANCE_SEC) return "overlap";
  return "continuous";
}

export function sequenceFingerprint(role, parts) {
  return createHash("sha256").update(JSON.stringify([
    role,
    ...parts.map((part, index) => [index, resolve(part.path), Number(part.bytes || 0), Number(part.modified_ms || 0), String(part.sha256 || "")]),
  ])).digest("hex");
}

export function buildSequenceReceipt({ role, label, parts, mappings = [], orderConfirmed = false, referenceDurationSec = null, previous = null, createdAt = new Date().toISOString() }) {
  const fingerprint = sequenceFingerprint(role, parts);
  const priorReviews = new Map((previous?.fingerprint === fingerprint ? previous.seams || [] : []).map((seam) => [seam.id, seam.review]));
  const seams = parts.slice(0, -1).map((part, index) => {
    const next = parts[index + 1];
    const currentMapping = mappings[index] || {};
    const nextMapping = mappings[index + 1] || {};
    const deltaSec = Number.isFinite(currentMapping.mapped_end_sec) && Number.isFinite(nextMapping.mapped_start_sec)
      ? Number((nextMapping.mapped_start_sec - currentMapping.mapped_end_sec).toFixed(3))
      : null;
    const confidence = Math.min(Number(currentMapping.end_confidence || 0), Number(nextMapping.start_confidence || 0));
    const id = `seam_${String(index + 1).padStart(3, "0")}`;
    const classification = classifySeam(deltaSec, confidence);
    return {
      id,
      previous_part_id: part.id,
      next_part_id: next.id,
      delta_sec: deltaSec,
      classification,
      duplicate_samples_suspected: classification === "overlap" && confidence >= MIN_MAPPING_CONFIDENCE,
      unexplained_discontinuity: classification === "uncertain",
      confidence: cleanConfidence(confidence),
      preview_file: null,
      review: priorReviews.get(id) || { status: "pending", decision: null, notes: "", reviewed_at: null },
    };
  });
  const compatibility = [];
  const sampleRates = new Set(parts.map((part) => Number(part.audio?.sample_rate || 0)));
  const channelLayouts = new Set(parts.map((part) => Number(part.audio?.channels || 0)));
  const codecs = new Set(parts.map((part) => String(part.audio?.codec || "")));
  const incompatibleFormat = sampleRates.size > 1 || channelLayouts.size > 1;
  const formatCompatibility = {
    status: incompatibleFormat ? "incompatible" : codecs.size > 1 ? "lossless_local_conversion_required" : "compatible",
    sample_rates: [...sampleRates],
    channel_counts: [...channelLayouts],
    codecs: [...codecs],
    finding: incompatibleFormat
      ? "Part sample rates or channel layouts differ. Studio refuses to invent a lossless match; produce and receipt compatible local derivatives before continuing."
      : codecs.size > 1
        ? "Part codecs differ. The approved logical track will decode them into a separate lossless FLAC without changing raw masters."
        : null,
  };
  if (formatCompatibility.finding) compatibility.push(formatCompatibility.finding);
  if (!orderConfirmed) compatibility.push("The recorded part order has not been confirmed.");
  const totalRecordedDurationSec = Number(parts.reduce((sum, part) => sum + Number(part.duration_sec || 0), 0).toFixed(3));
  const referenceDuration = Number(referenceDurationSec || 0);
  const uncoveredSec = referenceDuration > 0 ? Number(Math.max(0, referenceDuration - totalRecordedDurationSec).toFixed(3)) : null;
  const missingContinuationLikely = parts.length === 1
    && totalRecordedDurationSec >= 25 * 60
    && uncoveredSec > Math.max(120, referenceDuration * 0.05);
  const coverage = {
    reference_duration_sec: referenceDuration || null,
    recorded_duration_sec: totalRecordedDurationSec,
    uncovered_sec: uncoveredSec,
    status: missingContinuationLikely ? "incomplete" : referenceDuration && uncoveredSec > Math.max(30, referenceDuration * 0.05) ? "attention" : "complete",
    finding: missingContinuationLikely
      ? "The host track ends near the wireless microphone rollover interval while the camera continues materially longer. Add the likely continuation part before approval."
      : referenceDuration && uncoveredSec > Math.max(30, referenceDuration * 0.05)
        ? "The isolated-audio duration is materially shorter than the reference camera. Confirm that the uncovered program time is expected."
        : null,
  };
  if (coverage.finding) compatibility.push(coverage.finding);
  const ready = orderConfirmed && !incompatibleFormat && coverage.status !== "incomplete" && seams.every((seam) => seam.review?.status === "approved");
  return {
    schema: AUDIO_SEQUENCE_SCHEMA,
    role,
    label,
    fingerprint,
    order_confirmed: orderConfirmed,
    part_count: parts.length,
    parts: parts.map((part, index) => ({ ...part, order: index + 1, mapping: mappings[index] || null })),
    seams,
    coverage,
    compatibility,
    format_compatibility: formatCompatibility,
    total_recorded_duration_sec: totalRecordedDurationSec,
    status: ready ? "approved" : incompatibleFormat ? "incompatible" : coverage.status === "incomplete" ? "incomplete" : seams.length ? "review_required" : orderConfirmed ? "approved" : "order_required",
    ready,
    derived_source: previous?.fingerprint === fingerprint ? previous.derived_source || null : null,
    created_at: previous?.fingerprint === fingerprint ? previous.created_at || createdAt : createdAt,
    updated_at: createdAt,
  };
}

export function measurePartMappings(referenceSource, parts) {
  const reference = extractEnvelope(referenceSource.path);
  const mappings = [];
  for (const part of parts) {
    const duration = Number(part.duration_sec || 0);
    const edge = Math.min(EDGE_SEC, Math.max(3, duration));
    const startEdge = extractEnvelope(part.path, 0, edge);
    const expectedStart = mappings.length ? Number(mappings.at(-1).mapped_end_sec || 0) : 0;
    const start = findBestPosition(startEdge, reference, {
      minPosition: Math.max(0, Math.round((expectedStart - (mappings.length ? SEARCH_MARGIN_SEC : 15)) * ENVELOPE_HZ)),
      maxPosition: Math.min(reference.length - Math.round(startEdge.length * 0.55), Math.round((expectedStart + (mappings.length ? SEARCH_MARGIN_SEC : Math.max(SEARCH_MARGIN_SEC, referenceSource.duration_sec))) * ENVELOPE_HZ)),
      coarseStep: 25,
      sampleStride: 4,
    });
    const endStart = Math.max(0, duration - edge);
    const endEdge = extractEnvelope(part.path, endStart, edge);
    const expectedEndEdge = start.position / ENVELOPE_HZ + endStart;
    const end = findBestPosition(endEdge, reference, {
      minPosition: Math.max(0, Math.round((expectedEndEdge - SEARCH_MARGIN_SEC) * ENVELOPE_HZ)),
      maxPosition: Math.min(reference.length - Math.round(endEdge.length * 0.55), Math.round((expectedEndEdge + SEARCH_MARGIN_SEC) * ENVELOPE_HZ)),
      coarseStep: 25,
      sampleStride: 4,
    });
    mappings.push({
      mapped_start_sec: Number((start.position / ENVELOPE_HZ).toFixed(3)),
      mapped_end_sec: Number((end.position / ENVELOPE_HZ + edge).toFixed(3)),
      start_confidence: cleanConfidence(start.confidence),
      end_confidence: cleanConfidence(end.confidence),
      method: "camera-safety-audio-edge-correlation-v1",
    });
  }
  return mappings;
}

export function createSeamPreviews(sequence, workDir) {
  const sequenceDir = join(workDir, "audio_sequences", sequence.role);
  mkdirSync(sequenceDir, { recursive: true });
  for (const seam of sequence.seams) {
    const previous = sequence.parts.find((part) => part.id === seam.previous_part_id);
    const next = sequence.parts.find((part) => part.id === seam.next_part_id);
    const output = join(sequenceDir, `${seam.id}.wav`);
    const tailStart = Math.max(0, Number(previous.duration_sec || 0) - 4);
    runFfmpeg([
      "-ss", String(tailStart), "-t", "4", "-i", previous.path,
      "-t", "4", "-i", next.path,
      "-filter_complex", "[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono[a0];[1:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono[a1];[a0][a1]concat=n=2:v=0:a=1[out]",
      "-map", "[out]", "-c:a", "pcm_s16le", "-y", output,
    ]);
    seam.preview_file = output;
  }
  sequence.updated_at = new Date().toISOString();
  return sequence;
}

export function reviewSequenceSeam(sequence, seamId, { status, decision = "keep_boundary", notes = "", reviewedAt = new Date().toISOString() }) {
  if (!["pending", "approved", "rejected"].includes(status)) throw new Error("seam status must be pending, approved, or rejected");
  const seam = sequence.seams.find((item) => item.id === seamId);
  if (!seam) throw new Error("the split-audio seam was not found");
  seam.review = { status, decision: status === "approved" ? decision : null, notes: String(notes || "").trim().slice(0, 2_000), reviewed_at: reviewedAt };
  sequence.ready = sequence.order_confirmed && sequence.format_compatibility?.status !== "incompatible" && sequence.coverage?.status !== "incomplete" && sequence.seams.every((item) => item.review.status === "approved");
  sequence.status = sequence.ready ? "approved" : sequence.format_compatibility?.status === "incompatible" ? "incompatible" : sequence.coverage?.status === "incomplete" ? "incomplete" : sequence.seams.some((item) => item.review.status === "rejected") ? "blocked" : "review_required";
  sequence.updated_at = reviewedAt;
  return sequence;
}

export function buildDerivedTrack(sequence, workDir) {
  if (!sequence.ready) throw new Error("confirm the part order and approve every seam before building the logical host track");
  if (sequence.parts.length === 1) {
    sequence.derived_source = { path: sequence.parts[0].path, mode: "single_raw_part", created_at: new Date().toISOString() };
    return sequence;
  }
  const outputDir = join(workDir, "audio_sequences", sequence.role);
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, `${sequence.role}_logical.flac`);
  const inputs = sequence.parts.flatMap((part) => ["-i", part.path]);
  const streams = sequence.parts.map((_, index) => `[${index}:a]aresample=48000,aformat=sample_fmts=s32:channel_layouts=mono[a${index}]`).join(";");
  const concatInputs = sequence.parts.map((_, index) => `[a${index}]`).join("");
  runFfmpeg([...inputs, "-filter_complex", `${streams};${concatInputs}concat=n=${sequence.parts.length}:v=0:a=1[out]`, "-map", "[out]", "-c:a", "flac", "-y", output]);
  const stat = statSync(output);
  sequence.derived_source = {
    path: output,
    file: basename(output),
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    mode: "ordered_lossless_concat_flac",
    processing: {
      target_sample_rate: 48000,
      target_channels: 1,
      codec: "flac",
      agc: false,
      noise_reduction: false,
      loudness_normalization: false,
      boundary_repairs: sequence.seams.map((seam) => ({ seam_id: seam.id, decision: seam.review.decision })),
    },
    source_fingerprint: sequence.fingerprint,
    created_at: new Date().toISOString(),
  };
  sequence.updated_at = sequence.derived_source.created_at;
  return sequence;
}

export function writeAudioSequence(path, sequence) {
  writeFileSync(path, `${JSON.stringify(sequence, null, 2)}\n`);
  return sequence;
}
