// Show-specific settings live in show.config.json at the repository root.
// Everything here is configuration: names, links and channel mapping are
// never hard-coded in the pipeline modules.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_SHOW_CONFIG = Object.freeze({
  show_name: "Example Podcast",
  hosts: { host_1: "Host 1", host_2: "Host 2" },
  links: {
    website: "https://example.com/podcast",
    apple_podcasts: "",
    spotify: "",
    newsletter_name: "",
    newsletter: "",
  },
  release: {
    cadence_line: "",
    utm_medium: "podcast",
    chapters: {
      enforce_from_episode: null,
      min_count: 3,
      min_duration_seconds: 120,
      required_segment_prefixes: [],
    },
  },
  audio: { channel_mapping: { left: "host_1", right: "host_2" } },
  social: { show_hashtag: "#ExamplePodcast", cover_tagline: "", topic_keywords: [] },
  tiles: { presented_by: "" },
});

function text(value, fallback, maximum = 200) {
  const result = String(value ?? "").trim();
  return result && result.length <= maximum ? result : fallback;
}

function httpsUrl(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`show.config.json: ${label} must be a full HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`show.config.json: ${label} must be an HTTPS URL without embedded credentials`);
  }
  return parsed.href;
}

// The first hashtag on every social post. Defaults to the show name without spaces.
function showHashtag(value, showName) {
  const tag = String(value ?? "").trim();
  if (/^#[A-Za-z0-9_]{1,50}$/.test(tag)) return tag;
  return `#${showName.replace(/[^A-Za-z0-9_]/g, "").slice(0, 50) || "Podcast"}`;
}

export function normalizeShowConfig(raw = {}) {
  const base = DEFAULT_SHOW_CONFIG;
  const mapping = raw.audio?.channel_mapping || {};
  const left = mapping.left === "host_2" ? "host_2" : "host_1";
  const right = left === "host_1" ? "host_2" : "host_1";
  const chapters = raw.release?.chapters || {};
  const enforceFrom = Number(chapters.enforce_from_episode);
  const prefixes = Array.isArray(chapters.required_segment_prefixes)
    ? chapters.required_segment_prefixes.map((value) => text(value, "", 80)).filter(Boolean).slice(0, 20)
    : [];
  return {
    show_name: text(raw.show_name, base.show_name, 120),
    hosts: {
      host_1: text(raw.hosts?.host_1, base.hosts.host_1, 80),
      host_2: text(raw.hosts?.host_2, base.hosts.host_2, 80),
    },
    links: {
      website: httpsUrl(raw.links?.website ?? base.links.website, "links.website") || base.links.website,
      apple_podcasts: httpsUrl(raw.links?.apple_podcasts, "links.apple_podcasts"),
      spotify: httpsUrl(raw.links?.spotify, "links.spotify"),
      newsletter_name: text(raw.links?.newsletter_name, "", 120),
      newsletter: httpsUrl(raw.links?.newsletter, "links.newsletter"),
    },
    release: {
      cadence_line: text(raw.release?.cadence_line, "", 200),
      utm_medium: text(raw.release?.utm_medium, base.release.utm_medium, 40),
      chapters: {
        enforce_from_episode: Number.isInteger(enforceFrom) && enforceFrom > 0 ? enforceFrom : null,
        min_count: Number.isInteger(Number(chapters.min_count)) && Number(chapters.min_count) > 0 ? Number(chapters.min_count) : 3,
        min_duration_seconds: Number(chapters.min_duration_seconds) >= 0 && chapters.min_duration_seconds !== undefined
          ? Number(chapters.min_duration_seconds) : 120,
        required_segment_prefixes: prefixes,
      },
    },
    audio: { channel_mapping: { left, right } },
    social: {
      show_hashtag: showHashtag(raw.social?.show_hashtag, text(raw.show_name, base.show_name, 120)),
      cover_tagline: text(raw.social?.cover_tagline, "", 80),
      topic_keywords: Array.isArray(raw.social?.topic_keywords)
        ? raw.social.topic_keywords.map((word) => text(word, "", 40).toLowerCase()).filter(Boolean).slice(0, 50)
        : [],
    },
    tiles: { presented_by: text(raw.tiles?.presented_by, "", 80) },
  };
}

export function showConfigPath(root = REPO_ROOT) {
  return process.env.EAOL_SHOW_CONFIG
    ? resolve(process.env.EAOL_SHOW_CONFIG)
    : join(resolve(root || REPO_ROOT), "show.config.json");
}

export function loadShowConfig(root = REPO_ROOT) {
  let path = showConfigPath(root);
  if (!existsSync(path) && !process.env.EAOL_SHOW_CONFIG) path = join(REPO_ROOT, "show.config.json");
  if (!existsSync(path)) return normalizeShowConfig({});
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("show.config.json is not valid JSON");
  }
  return normalizeShowConfig(raw);
}

// Stereo split recordings carry one host per channel. Studio measures Host 1 on
// the left, so a recording wired the other way is swapped while decoding.
export function stereoSplitDecodeArgs(config = loadShowConfig()) {
  return config.audio.channel_mapping.left === "host_2" ? ["-af", "channelmap=map=1|0"] : [];
}

// The website host decides which links receive campaign tags.
export function websiteHosts(config) {
  const host = new URL(config.links.website).hostname.replace(/^www\./, "");
  return [host, `www.${host}`];
}

export function publicShowConfig(config) {
  return {
    show_name: config.show_name,
    hosts: config.hosts,
    links: config.links,
    channel_mapping: config.audio.channel_mapping,
    show_hashtag: config.social.show_hashtag,
  };
}
