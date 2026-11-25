import { createHash, randomUUID } from "node:crypto";
import { loadShowConfig } from "./show_config.mjs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

export const SOCIAL_RENDER_REVIEW_SCHEMA = "eaol-social-render-review-v1";
export const SOCIAL_PACKAGE_REVIEW_SCHEMA = "eaol-social-package-review-v1";
export const SOCIAL_DELIVERY_SCHEMA = "eaol-social-delivery-v1";

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fileReceipt(path) {
  const stat = statSync(path);
  return {
    path,
    file: basename(path),
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function text(value, label, limit = 2_000) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > limit) throw new Error(`${label} must be at most ${limit} characters`);
  return result;
}

export function buildSocialRenderReview({
  renderReceipt,
  status,
  completeWatch,
  checks,
  reviewedBy,
  notes = "",
  reviewedAt = new Date().toISOString(),
} = {}) {
  if (!renderReceipt?.output?.sha256 || renderReceipt.status !== "complete") throw new Error("a current completed social render is required");
  if (!["approved", "rejected"].includes(status)) throw new Error("social render review must be approved or rejected");
  const required = ["opening", "captions", "crop", "audio", "ending"];
  const normalized = Object.fromEntries(required.map((key) => [key, checks?.[key] === true]));
  if (status === "approved" && (!completeWatch || !Object.values(normalized).every(Boolean))) {
    throw new Error("watch the complete clip and confirm its opening, captions, crop, audio, and ending before approval");
  }
  return {
    schema: SOCIAL_RENDER_REVIEW_SCHEMA,
    status,
    reviewed_at: reviewedAt,
    reviewed_by: text(reviewedBy, "reviewer", 80),
    render_sha256: renderReceipt.output.sha256,
    edit_plan_fingerprint: renderReceipt.edit_plan_fingerprint,
    complete_watch: completeWatch === true,
    checks: normalized,
    notes: String(notes || "").trim().slice(0, 2_000),
    packaging_authorized: status === "approved",
    external_copy_authorized: false,
    publication_authorized: false,
  };
}

export function socialRenderReviewMatches(review, renderReceipt) {
  return Boolean(review?.schema === SOCIAL_RENDER_REVIEW_SCHEMA
    && review.status === "approved"
    && review.complete_watch === true
    && Object.values(review.checks || {}).every(Boolean)
    && review.render_sha256 === renderReceipt?.output?.sha256
    && review.edit_plan_fingerprint === renderReceipt?.edit_plan_fingerprint);
}

export function buildSocialPackageReview({
  kit,
  status,
  reviewedBy,
  checks,
  notes = "",
  reviewedAt = new Date().toISOString(),
} = {}) {
  if (!kit?.fingerprint || kit.schema !== "eaol-social-packaging-v2") throw new Error("save the current three-platform package first");
  if (!["approved", "rejected"].includes(status)) throw new Error("social package review must be approved or rejected");
  const required = ["master", "cover", "core_copy", "youtube", "instagram", "tiktok", "release_slot"];
  const normalized = Object.fromEntries(required.map((key) => [key, checks?.[key] === true]));
  if (status === "approved" && !Object.values(normalized).every(Boolean)) {
    throw new Error("confirm the shared master, covers, core wording, three platform cards, and release slot before approval");
  }
  return {
    schema: SOCIAL_PACKAGE_REVIEW_SCHEMA,
    status,
    reviewed_at: reviewedAt,
    reviewed_by: text(reviewedBy, "reviewer", 80),
    kit_fingerprint: kit.fingerprint,
    source_master_sha256: kit.source.master.sha256,
    checks: normalized,
    notes: String(notes || "").trim().slice(0, 2_000),
    local_delivery_authorized: status === "approved",
    external_copy_authorized: false,
    upload_authorized: false,
    publication_authorized: false,
  };
}

export function socialPackageReviewMatches(review, kit) {
  return Boolean(review?.schema === SOCIAL_PACKAGE_REVIEW_SCHEMA
    && review.status === "approved"
    && Object.values(review.checks || {}).every(Boolean)
    && review.kit_fingerprint === kit?.fingerprint
    && review.source_master_sha256 === kit?.source?.master?.sha256);
}

function escapeXml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function coverSvg({ width, height, episodeTitle, headline, clipNumber }) {
  const max = width === 1080 && height === 1350 ? 29 : 34;
  const words = String(headline || "").split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const next = `${lines.at(-1)} ${word}`.trim();
    if (next.length > max && lines.at(-1)) lines.push(word);
    else lines[lines.length - 1] = next;
  }
  const lineHeight = height === 1350 ? 94 : 108;
  const startY = height * 0.39 - ((lines.length - 1) * lineHeight) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0e171b"/><stop offset="1" stop-color="#233b43"/></linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="86" y="86" width="908" height="${height - 172}" rx="42" fill="none" stroke="#8abfc5" stroke-width="4" opacity=".55"/>
  <text x="104" y="170" fill="#8abfc5" font-family="Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="5">EXPLORE AI OUT LOUD</text>
  <text x="104" y="235" fill="#f3e2ae" font-family="Arial, sans-serif" font-size="28" font-weight="700">CLIP ${String(clipNumber).padStart(2, "0")}</text>
  ${lines.slice(0, 4).map((line, index) => `<text x="104" y="${startY + index * lineHeight}" fill="#ffffff" font-family="Arial, sans-serif" font-size="78" font-weight="800">${escapeXml(line)}</text>`).join("\n")}
  <line x1="104" y1="${height - 300}" x2="976" y2="${height - 300}" stroke="#f3e2ae" stroke-width="8"/>
  <text x="104" y="${height - 215}" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${escapeXml(episodeTitle).slice(0, 54)}</text>
  <text x="104" y="${height - 145}" fill="#8abfc5" font-family="Arial, sans-serif" font-size="28">${escapeXml(loadShowConfig().social.cover_tagline)}</text>
</svg>`;
}

function writeCover(path, input) {
  const svg = coverSvg(input);
  const png = new Resvg(svg, { fitTo: { mode: "width", value: input.width } }).render().asPng();
  writeFileSync(path, png, { mode: 0o600 });
  return fileReceipt(path);
}

function postKitMarkdown(kit) {
  const names = { youtube_shorts: "YouTube Shorts", instagram_reels: "Instagram Reels", tiktok: "TikTok" };
  const lines = [
    `# ${kit.source.clip_title}`,
    "",
    `Release slot: ${kit.release_slot.replace("_", " ")}`,
    "",
    `Upload the same clean master to all three platforms: ${kit.source.master.file}`,
    "",
  ];
  for (const [key, card] of Object.entries(kit.platforms)) {
    lines.push(`## ${names[key]}`, "");
    if (card.title) lines.push(`Title: ${card.title}`, "");
    lines.push(card.description || card.caption, "", `Cover: ${card.cover_variant}`, "", `Check: ${card.publish_check}`, "");
  }
  lines.push("This local package does not authorize upload, scheduling, or publication.", "");
  return lines.join("\n");
}

function nextVersion(root) {
  if (!existsSync(root)) return 1;
  return Math.max(0, ...readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number(/^v(\d{3})$/.exec(entry.name)?.[1] || 0))) + 1;
}

export function writeSocialDelivery(workDir, {
  slug,
  episodeId,
  episodeTitle,
  clips,
  renderReceipts,
  renderReviews,
  packages,
  packageReviews,
  qualityException = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const approved = (clips || []).filter((clip) => clip.review?.status === "approved");
  if (approved.length !== 3) {
    if (!(qualityException?.approved === true && approved.length > 0 && String(qualityException.reason || "").trim())) {
      throw new Error("approve exactly three distinct clips, or record an explicit quality-over-quota exception");
    }
  }
  const slots = approved.map((clip) => packages?.[clip.id]?.release_slot);
  if (approved.length === 3 && new Set(slots).size !== 3) throw new Error("assign the three approved clips to day 0, day 5, and day 10");
  const ready = approved.map((clip) => {
    const render = renderReceipts?.[clip.id];
    const renderReview = renderReviews?.[clip.id];
    const kit = packages?.[clip.id];
    const packageReview = packageReviews?.[clip.id];
    if (!render?.output?.path || !existsSync(render.output.path)) throw new Error(`${clip.id} needs a current rendered master`);
    const current = fileReceipt(render.output.path);
    if (current.sha256 !== render.output.sha256 || current.bytes !== render.output.bytes) throw new Error(`${clip.id} render changed after QA`);
    if (!socialRenderReviewMatches(renderReview, render)) throw new Error(`${clip.id} needs a complete approved output watch`);
    if (kit?.source?.master?.sha256 !== render.output.sha256) throw new Error(`${clip.id} package does not match the approved master`);
    if (!socialPackageReviewMatches(packageReview, kit)) throw new Error(`${clip.id} needs one current three-platform package approval`);
    return { clip, render, renderReview, kit, packageReview };
  });

  const root = join(workDir, "social_delivery");
  mkdirSync(root, { recursive: true });
  const number = nextVersion(root);
  const version = `v${String(number).padStart(3, "0")}`;
  const staging = join(root, `.${version}-building-${randomUUID()}`);
  const finalDir = join(root, version);
  mkdirSync(staging, { recursive: true });
  const entries = [];
  try {
    for (const [index, item] of ready.entries()) {
      const clipDir = join(staging, item.clip.id);
      mkdirSync(clipDir, { recursive: true });
      const masterName = `${episodeId}_${item.clip.id}_social_9x16.mp4`;
      const masterPath = join(clipDir, masterName);
      copyFileSync(item.render.output.path, masterPath);
      const master = fileReceipt(masterPath);
      const cover9x16 = writeCover(join(clipDir, "cover_9x16.png"), {
        width: 1080, height: 1920, episodeTitle, headline: item.kit.cover.headline, clipNumber: index + 1,
      });
      const cover3x4 = writeCover(join(clipDir, "cover_3x4.png"), {
        width: 1080, height: 1350, episodeTitle, headline: item.kit.cover.headline, clipNumber: index + 1,
      });
      const kitPath = join(clipDir, "social_post_kit.json");
      const markdownPath = join(clipDir, "post_kit.md");
      writeFileSync(kitPath, `${JSON.stringify(item.kit, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(markdownPath, postKitMarkdown(item.kit), { mode: 0o600 });
      const reviewPath = join(clipDir, "approval_receipt.json");
      writeFileSync(reviewPath, `${JSON.stringify({ render_review: item.renderReview, package_review: item.packageReview }, null, 2)}\n`, { mode: 0o600 });
      const finalReceipt = (receipt) => ({ ...receipt, path: receipt.path.replace(staging, finalDir) });
      entries.push({
        clip_id: item.clip.id,
        title: item.clip.title,
        release_slot: item.kit.release_slot,
        source_master_sha256: item.render.output.sha256,
        files: {
          master: finalReceipt(master),
          cover_9x16: finalReceipt(cover9x16),
          cover_3x4: finalReceipt(cover3x4),
          post_kit_json: finalReceipt(fileReceipt(kitPath)),
          post_kit_markdown: finalReceipt(fileReceipt(markdownPath)),
          approval: finalReceipt(fileReceipt(reviewPath)),
        },
      });
    }
    const core = {
      schema: SOCIAL_DELIVERY_SCHEMA,
      status: "ready_for_local_handoff",
      generated_at: generatedAt,
      version,
      source_slug: text(slug, "source slug", 120),
      episode_id: text(episodeId, "episode ID", 40),
      episode_title: text(episodeTitle, "episode title", 180),
      editorial_master_count: entries.length,
      destination_count: entries.length * 3,
      destinations: ["youtube_shorts", "instagram_reels", "tiktok"],
      cadence: ["day_0", "day_5", "day_10"],
      quality_over_quota_exception: qualityException?.approved === true ? qualityException : null,
      entries,
      analytics_phase: "separate_later_build",
      provider_post_ids_reserved: true,
      connected_accounts: false,
      external_copy_authorized: false,
      upload_authorized: false,
      scheduling_authorized: false,
      publication_authorized: false,
    };
    const manifest = { ...core, fingerprint: fingerprint(core) };
    const manifestPath = join(staging, "social_delivery_manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, finalDir);
    const finalManifestPath = join(finalDir, "social_delivery_manifest.json");
    const pointer = { ...manifest, output_dir: finalDir, manifest: fileReceipt(finalManifestPath) };
    writeFileSync(join(workDir, "social_delivery.json"), `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 });
    return pointer;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
