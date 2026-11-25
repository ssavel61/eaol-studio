import { validateShortTitle } from './release_policy.mjs';
import { loadShowConfig } from './show_config.mjs';
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const PLATFORM_KEYS = ["youtube_shorts", "instagram_reels", "tiktok"];
const HASHTAG = /^#[\p{L}\p{N}_]{2,50}$/u;
const CLIP_ID = /^clip_(\d{3,})$/;
const EPISODE_ID = /^ep\d{3,}$/;

function boundedText(value, label, limit, { required = true } = {}) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > limit) throw new Error(`${label} must be at most ${limit} characters`);
  return text;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceReceipt(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("the rendered social master is not a file");
  return {
    path,
    file: basename(path),
    bytes: stat.size,
    modified_ms: Math.round(stat.mtimeMs),
    sha256: sha256(path),
  };
}

function normalizedHashtags(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`add exactly three hashtags, with ${loadShowConfig().social.show_hashtag} first`);
  }
  const tags = value.map((tag) => boundedText(tag, "hashtag", 51));
  if (tags.some((tag) => !HASHTAG.test(tag))) throw new Error("hashtags must begin with # and contain letters, numbers, or underscores only");
  if (new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length) throw new Error("hashtags must be unique");
  const showTag = loadShowConfig().social.show_hashtag;
  if (tags[0] !== showTag) throw new Error(`${showTag} must be the first hashtag`);
  return tags;
}

function clipContentId(clipId) {
  const match = CLIP_ID.exec(String(clipId || ""));
  if (!match) throw new Error("clip id must look like clip_001");
  return `clip${match[1].slice(-2)}`;
}

export function trackedEpisodeLink({ destinationUrl, source, episodeId, clipId }) {
  if (!EPISODE_ID.test(String(episodeId || ""))) throw new Error("episode id must look like ep001");
  if (!new Set(["youtube", "instagram", "tiktok"]).has(source)) throw new Error("unsupported social source");
  let url;
  try {
    url = new URL(boundedText(destinationUrl, "public episode URL", 2_000));
  } catch {
    throw new Error("public episode URL must be an absolute URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("public episode URL must use https");
  if (!["example.com", "www.example.com"].includes(url.hostname)) return url.toString();
  url.searchParams.set("utm_source", source);
  url.searchParams.set("utm_medium", "short");
  url.searchParams.set("utm_campaign", episodeId);
  url.searchParams.set("utm_content", clipContentId(clipId));
  return url.toString();
}

/**
 * Produce publishing instructions for one reviewed, rendered master. This is a
 * local handoff only: no account connection, upload, scheduling, or publication
 * occurs here. The identical source receipt appears in every platform card so a
 * team cannot accidentally create three different edits for one idea.
 */
export function buildSocialPostKit({
  episodeId,
  episodeTitle,
  publicEpisodeUrl,
  clip,
  renderedMasterPath,
  caption,
  hashtags,
  coverNote,
  releaseSlot = "day_0",
  tiktokBioLinkAvailable = false,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!EPISODE_ID.test(String(episodeId || ""))) throw new Error("episode id must look like ep001");
  const master = sourceReceipt(boundedText(renderedMasterPath, "rendered social master path", 4_000));
  const clipId = boundedText(clip?.id, "clip id", 100);
  const content = clipContentId(clipId);
  if (clip?.review?.status !== "approved") throw new Error("approve the clip before creating its post kit");
  const title = boundedText(clip?.title, "clip title", 100);
  validateShortTitle(title);
  const message = boundedText(caption, "post caption", 2_200);
  const tags = normalizedHashtags(hashtags);
  const cover = boundedText(coverNote, "cover guidance", 300);
  const episode = boundedText(episodeTitle, "episode title", 180);
  const links = Object.fromEntries([
    ["youtube_shorts", trackedEpisodeLink({ destinationUrl: publicEpisodeUrl, source: "youtube", episodeId, clipId })],
    ["instagram_reels", trackedEpisodeLink({ destinationUrl: publicEpisodeUrl, source: "instagram", episodeId, clipId })],
    ["tiktok", trackedEpisodeLink({ destinationUrl: publicEpisodeUrl, source: "tiktok", episodeId, clipId })],
  ]);
  const hashtagLine = tags.join(" ");
  if (!["day_0", "day_5", "day_10"].includes(releaseSlot)) throw new Error("release slot must be day_0, day_5, or day_10");
  const coreCopy = { caption: message, hashtags: tags };
  const coreCopyFingerprint = fingerprint(coreCopy);
  const tiktokFunnel = tiktokBioLinkAvailable
    ? "Full episode via the link in bio."
    : `Watch the full episode: ${links.tiktok}`;
  const platformCards = {
    youtube_shorts: {
      title,
      description: `${message}\n\nWatch the full episode: ${links.youtube_shorts}\n\n${hashtagLine}`,
      related_video_url: publicEpisodeUrl,
      cover_variant: "cover_9x16.png",
      core_copy_fingerprint: coreCopyFingerprint,
      publish_check: "Attach this episode as Related Video; no podcast playlist. Check the 3–5 second episode closing line. No outro card. Playback and publication approval remain separate.",
    },
    instagram_reels: {
      caption: `${message}\n\nFull episode via the link in bio.\n\n${hashtagLine}`,
      bio_link: links.instagram_reels,
      cover_variant: "cover_3x4.png",
      core_copy_fingerprint: coreCopyFingerprint,
      publish_check: "Use the clean master and disable the native auto-caption sticker when burned captions are present.",
    },
    tiktok: {
      caption: `${message}\n\n${tiktokFunnel}\n\n${hashtagLine}`,
      bio_link: tiktokBioLinkAvailable ? links.tiktok : null,
      visible_episode_url: tiktokBioLinkAvailable ? null : links.tiktok,
      cover_variant: "cover_9x16.png",
      core_copy_fingerprint: coreCopyFingerprint,
      publish_check: "Use the clean master; verify the first caption words and cover remain visible in the TikTok composer.",
    },
  };
  const core = {
    schema: "eaol-social-packaging-v2",
    status: "review_required",
    generated_at: generatedAt,
    publication_authorized: false,
    source: {
      episode_id: episodeId,
      episode_title: episode,
      clip_id: clipId,
      clip_title: title,
      clip_category: boundedText(clip?.category, "clip category", 80),
      master,
      one_master_for: PLATFORM_KEYS,
    },
    core_copy: { ...coreCopy, fingerprint: coreCopyFingerprint },
    cover: { headline: cover, shared_composition: true, variants: ["cover_9x16.png", "cover_3x4.png"] },
    release_slot: releaseSlot,
    tracking: { campaign: episodeId, content, provider_post_ids: {} },
    same_verbiage_rule: "The core caption and hashtag set are identical. Cards add only the destination-specific funnel and required upload fields.",
    platforms: platformCards,
  };
  return { ...core, fingerprint: fingerprint(core) };
}

function markdown(kit) {
  const lines = [
    `# ${kit.source.clip_title} — social post kit`,
    "",
    `One approved master: ${kit.source.master.file} (${kit.source.master.sha256}). Upload this clean file natively to all three platforms; do not download it back from another platform.`,
    "",
  ];
  for (const key of PLATFORM_KEYS) {
    const card = kit.platforms[key];
    lines.push(`## ${key.replace(/_/g, " ")}`, "");
    if (card.title) lines.push(`**Title:** ${card.title}`, "");
    if (card.description) lines.push(`**Description:** ${card.description}`, "");
    if (card.caption) lines.push(`**Caption:** ${card.caption}`, "");
    if (card.related_video_url) lines.push(`**Related video:** ${card.related_video_url}`, "");
    if (card.bio_link) lines.push(`**Bio-link UTM:** ${card.bio_link}`, "");
    lines.push(`**Cover file:** ${card.cover_variant}`, "", `**Before posting:** ${card.publish_check}`, "");
  }
  lines.push("This local kit does not authorize upload, scheduling, or publication.", "");
  return lines.join("\n");
}

export function writeSocialPostKit(workDir, input) {
  const kit = buildSocialPostKit(input);
  const root = boundedText(workDir, "work directory", 4_000);
  const kitDir = join(root, "social_delivery", "drafts", kit.source.clip_id);
  mkdirSync(kitDir, { recursive: true });
  const jsonPath = join(kitDir, "social_post_kit.json");
  const markdownPath = join(kitDir, "post_kit.md");
  if (existsSync(jsonPath) || existsSync(markdownPath)) {
    throw new Error("a social post kit already exists for this clip; create a new versioned delivery before replacing it");
  }
  writeFileSync(jsonPath, `${JSON.stringify(kit, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdownPath, markdown(kit), { mode: 0o600 });
  return {
    ...kit,
    files: { json: sourceReceipt(jsonPath), markdown: sourceReceipt(markdownPath) },
  };
}
