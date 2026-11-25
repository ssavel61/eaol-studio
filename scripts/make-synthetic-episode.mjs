#!/usr/bin/env node
// Builds a synthetic two-camera, two-microphone episode with ffmpeg so the
// tests and the demo run without any real recording. Nothing here is committed
// media: every file is generated on demand into tmp/ (ignored by git).
//
//   node scripts/make-synthetic-episode.mjs            generate and ingest into work/
//   node scripts/make-synthetic-episode.mjs --no-ingest  generate the media only
//
// Picture: SMPTE colour bars for Host 1 and a moving test pattern for Host 2.
// Sound: each "host" is band-limited noise gated into alternating turns, which
// gives the sync and speaker-activity stages a speech-like envelope to measure.
// Camera audio is a quieter mix of both hosts, delayed by a known offset, so
// envelope correlation has a real answer to find.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveTool } from "../platform_tools.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SYNTHETIC_SLUG = "synthetic_episode";
export const SYNTHETIC_OFFSETS_SEC = { host_1_camera: 0.5, host_2_camera: 0.8 };

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `${command} failed`);
  }
  return result;
}

// A host "speaks" in 2.5 second turns separated by short pauses. Syllable-rate
// amplitude changes keep the envelope from being a flat block.
function voice({ seed, turnOffsetSec, durationSec }) {
  const turn = `lt(mod(t+${turnOffsetSec}\\,6)\\,2.5)`;
  const syllables = `(0.55+0.45*sin(2*PI*3.1*t+${seed}))`;
  return [
    `anoisesrc=d=${durationSec}:c=pink:r=48000:a=0.5:seed=${seed}`,
    "highpass=f=180",
    "lowpass=f=3200",
    `volume='${turn}*${syllables}':eval=frame`,
  ].join(",");
}

export function makeSyntheticEpisode({ outDir = join(ROOT, "tmp", "synthetic"), durationSec = 60 } = {}) {
  const ffmpeg = resolveTool("ffmpeg");
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const files = {
    host_1_audio: join(dir, "host_1_mic.wav"),
    host_2_audio: join(dir, "host_2_mic.wav"),
    primary_camera: join(dir, `${SYNTHETIC_SLUG}.mp4`),
    secondary_camera: join(dir, "host_2_camera.mp4"),
  };
  run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", voice({ seed: 11, turnOffsetSec: 0, durationSec }),
    "-ac", "1", "-c:a", "pcm_s16le", "-y", files.host_1_audio]);
  run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", voice({ seed: 23, turnOffsetSec: 3, durationSec }),
    "-ac", "1", "-c:a", "pcm_s16le", "-y", files.host_2_audio]);
  const camera = (pattern, output, offsetSec) => run(ffmpeg, [
    "-v", "error",
    "-f", "lavfi", "-i", `${pattern}=size=640x360:rate=30:d=${durationSec}`,
    "-i", files.host_1_audio, "-i", files.host_2_audio,
    "-filter_complex",
    `[1:a][2:a]amix=inputs=2:normalize=0,volume=0.6,adelay=${Math.round(offsetSec * 1000)}:all=1,apad[a]`,
    "-map", "0:v", "-map", "[a]", "-t", String(durationSec),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-y", output,
  ]);
  camera("smptebars", files.primary_camera, SYNTHETIC_OFFSETS_SEC.host_1_camera);
  camera("testsrc2", files.secondary_camera, SYNTHETIC_OFFSETS_SEC.host_2_camera);
  return { dir, files, durationSec };
}

export function ingestSyntheticEpisode(files, workRoot = join(ROOT, "work")) {
  run(process.execPath, [
    join(ROOT, "studio", "ingest.mjs"), "--analyze-only", "--work-root", resolve(workRoot),
    "--primary-camera", files.primary_camera,
    "--secondary-camera", files.secondary_camera,
    "--host-1-audio", files.host_1_audio,
    "--host-2-audio", files.host_2_audio,
  ]);
  return join(resolve(workRoot), SYNTHETIC_SLUG);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const episode = makeSyntheticEpisode();
    console.log(`Synthetic media written to ${episode.dir}`);
    if (!process.argv.includes("--no-ingest")) {
      const workDir = ingestSyntheticEpisode(episode.files);
      console.log(`Source intake receipt written to ${workDir}`);
      console.log("Next: npm run studio, then open the address it prints and choose \"synthetic_episode\".");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
