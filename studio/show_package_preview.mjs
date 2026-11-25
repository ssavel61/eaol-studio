#!/usr/bin/env node

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderCtaOverlay } from "./cta_overlay.mjs";
import { probeMedia, renderPackage } from "./episode_renderer.mjs";
import { loadShowPackageState, showPackagePaths } from "./show_package.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

export async function renderShowPackagePreview({ workRoot, sectionName, generatedAt = new Date().toISOString() }) {
  if (!["opening", "closing"].includes(sectionName)) throw new Error("preview section must be opening or closing");
  const state = loadShowPackageState(workRoot);
  if (!state.current || !state.show_package) throw new Error("save the current show package before previewing it");
  const section = state.show_package[sectionName];
  if (!section?.enabled) throw new Error(`attach the ${sectionName} visual before previewing it`);

  const paths = showPackagePaths(workRoot);
  const previewDir = join(paths.dir, "previews");
  mkdirSync(previewDir, { recursive: true });
  let overlayPath = null;
  if (sectionName === "closing" && state.show_package.cta_graphic.show_during_closing) {
    overlayPath = join(previewDir, "closing_cta_overlay.png");
    await renderCtaOverlay({
      eyebrow: "EXPLORE THE PODCAST",
      websiteLabel: state.show_package.cta_graphic.website_label,
      websiteUrlLabel: state.show_package.cta_graphic.display_url,
      actions: state.show_package.cta_graphic.actions,
      outputPath: overlayPath,
    });
  }

  const outputPath = join(previewDir, `${sectionName}_preview.mp4`);
  const duration = renderPackage({ section, outputPath, overlayPath });
  const stat = statSync(outputPath);
  const probe = probeMedia(outputPath);
  const receipt = {
    schema: "eaol-show-package-preview-v1",
    status: "complete",
    generated_at: generatedAt,
    section: sectionName,
    show_package_fingerprint: state.show_package.fingerprint,
    narration_mode: section.narration_mode,
    duration_source: section.voiceover ? "evergreen_voiceover" : section.music ? "music" : "visual",
    output: {
      path: outputPath,
      file: basename(outputPath),
      bytes: stat.size,
      modified_ms: Math.round(stat.mtimeMs),
      duration_sec: probe.duration_sec || duration,
      width: probe.video?.width || null,
      height: probe.video?.height || null,
      video_codec: probe.video?.codec_name || null,
      audio_codec: probe.audio?.codec_name || null,
      audio_sample_rate: Number(probe.audio?.sample_rate || 0),
      audio_channels: Number(probe.audio?.channels || 0),
    },
    checks: {
      dimensions: probe.video?.width === 1920 && probe.video?.height === 1080,
      video_codec: probe.video?.codec_name === "h264",
      audio_codec: probe.audio?.codec_name === "aac",
      audio: Number(probe.audio?.sample_rate || 0) === 48_000 && Number(probe.audio?.channels || 0) === 2,
      duration: Number(probe.duration_sec || 0) > 0,
    },
    episode_inheritance_authorized: false,
    publication_authorized: false,
  };
  if (Object.values(receipt.checks).some((value) => !value)) {
    throw new Error(`show-package preview checks failed: ${JSON.stringify(receipt.checks)}`);
  }
  writeFileSync(join(paths.dir, `${sectionName}_preview.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const argv = process.argv.slice(2);
  const workRoot = argValue(argv, "--work-root");
  const sectionName = argValue(argv, "--section");
  if (!workRoot || !sectionName) {
    console.error("usage: node studio/show_package_preview.mjs --work-root work --section opening|closing");
    process.exit(1);
  }
  renderShowPackagePreview({ workRoot: resolve(workRoot), sectionName })
    .then((receipt) => console.log(`${sectionName} show-package preview complete: ${receipt.output.path}`))
    .catch((error) => {
      console.error(`FATAL: ${error.message}`);
      process.exit(1);
    });
}
