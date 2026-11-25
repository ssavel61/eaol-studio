import { createHash } from "node:crypto";
import { loadShowConfig } from "./show_config.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SHOW_PACKAGE_SLUG = "show_package";
export const SHOW_PACKAGE_SCHEMA = "eaol-show-package-v1";
export const SHOW_PACKAGE_REVIEW_SCHEMA = "eaol-show-package-review-v1";

const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const NARRATION_MODES = new Set(["evergreen", "episode_specific"]);
const CTA_ACTIONS = new Set(["like", "comment", "subscribe"]);
const DEFAULT_WEBSITE_URL = loadShowConfig().links.website;
const DEFAULT_WEBSITE_LABEL = loadShowConfig().show_name;
const DEFAULT_NEWSLETTER_LABEL = loadShowConfig().links.newsletter_name || "Newsletter";

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function assetIdentity(asset) {
  if (!asset) return null;
  return {
    path: asset.path,
    file: asset.file,
    kind: asset.kind,
    bytes: Number(asset.bytes || 0),
    modified_ms: Number(asset.modified_ms || 0),
  };
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || DEFAULT_WEBSITE_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("show-package CTA website must be a complete https URL");
  }
  if (parsed.protocol !== "https:") throw new Error("show-package CTA website must use https");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeOptionalWebsiteUrl(value) {
  const raw = String(value || "").trim();
  return raw ? normalizeWebsiteUrl(raw) : null;
}

function visibleUrl(value) {
  return String(value || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function packageSection(label, value = {}) {
  const narrationMode = String(value.narration_mode || "episode_specific");
  if (!NARRATION_MODES.has(narrationMode)) {
    throw new Error(`${label} narration must be evergreen or episode-specific`);
  }
  const visual = assetIdentity(value.visual);
  const voiceover = narrationMode === "evergreen" ? assetIdentity(value.voiceover) : null;
  const music = assetIdentity(value.music);
  if (narrationMode === "episode_specific" && value.voiceover) {
    throw new Error(`${label} cannot store evergreen narration while episode-specific narration is selected`);
  }
  if ((voiceover || music) && !visual) throw new Error(`${label} audio requires a ${label} visual`);
  return {
    enabled: Boolean(visual),
    narration_mode: narrationMode,
    visual,
    voiceover,
    music,
    episode_voiceover_required: narrationMode === "episode_specific",
  };
}

export function showPackageFingerprint(showPackage) {
  if (!showPackage) return null;
  const stable = {
    schema: showPackage.schema,
    name: showPackage.name,
    opening: showPackage.opening,
    closing: showPackage.closing,
    cta_graphic: showPackage.cta_graphic,
    newsletter_cta: showPackage.newsletter_cta,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function showPackageAssetsAreCurrent(showPackage) {
  const assets = [
    showPackage?.opening?.visual,
    showPackage?.opening?.voiceover,
    showPackage?.opening?.music,
    showPackage?.closing?.visual,
    showPackage?.closing?.voiceover,
    showPackage?.closing?.music,
    showPackage?.cta_graphic?.asset,
    showPackage?.newsletter_cta?.asset,
  ].filter(Boolean);
  return assets.every((asset) => {
    try {
      const stat = statSync(asset.path);
      return stat.isFile()
        && stat.size === Number(asset.bytes)
        && Math.round(stat.mtimeMs) === Number(asset.modified_ms);
    } catch {
      return false;
    }
  });
}

export function buildShowPackage({ draft = {}, generatedAt = new Date().toISOString() } = {}) {
  const opening = packageSection("opening", draft.opening);
  const closing = packageSection("closing", draft.closing);
  const actions = [...new Set((Array.isArray(draft.cta_graphic?.actions)
    ? draft.cta_graphic.actions
    : ["like", "comment", "subscribe"])
    .map((value) => String(value || "").toLowerCase())
    .filter((value) => CTA_ACTIONS.has(value)))];
  const websiteUrl = normalizeWebsiteUrl(draft.cta_graphic?.website_url);
  const newsletterUrl = normalizeOptionalWebsiteUrl(draft.newsletter_cta?.website_url);
  const blocking = [];
  if (!opening.visual) blocking.push("Attach the reusable opening visual before approving the show package.");
  if (!closing.visual) blocking.push("Attach the reusable closing visual before approving the show package.");
  for (const [label, section] of [["opening", opening], ["closing", closing]]) {
    if (section.narration_mode === "evergreen" && !section.voiceover && !section.music && section.visual?.kind === "image") {
      blocking.push(`The ${label} image needs evergreen narration or music to define its duration.`);
    }
  }
  const warnings = [];
  if (opening.narration_mode === "episode_specific") warnings.push("Opening narration must be attached inside each episode.");
  if (closing.narration_mode === "episode_specific") warnings.push("Closing narration must be attached inside each episode.");
  const showPackage = {
    schema: SHOW_PACKAGE_SCHEMA,
    status: "review_required",
    generated_at: generatedAt,
    name: String(draft.name || DEFAULT_WEBSITE_LABEL).trim().slice(0, 120) || DEFAULT_WEBSITE_LABEL,
    opening,
    closing,
    cta_graphic: {
      asset: assetIdentity(draft.cta_graphic?.asset),
      website_url: websiteUrl,
      website_label: String(draft.cta_graphic?.website_label || DEFAULT_WEBSITE_LABEL).trim().slice(0, 80) || DEFAULT_WEBSITE_LABEL,
      display_url: visibleUrl(websiteUrl),
      actions,
      show_during_closing: draft.cta_graphic?.show_during_closing !== false,
    },
    newsletter_cta: {
      asset: assetIdentity(draft.newsletter_cta?.asset),
      website_url: newsletterUrl,
      website_label: String(draft.newsletter_cta?.website_label || DEFAULT_NEWSLETTER_LABEL).trim().slice(0, 80) || DEFAULT_NEWSLETTER_LABEL,
      display_url: visibleUrl(newsletterUrl),
    },
    blocking,
    warnings,
    ready_for_approval: blocking.length === 0,
    publication_authorized: false,
  };
  showPackage.fingerprint = showPackageFingerprint(showPackage);
  return showPackage;
}

export function buildShowPackageReview({ showPackage, status, notes = "", reviewedAt = new Date().toISOString() }) {
  if (!showPackage) throw new Error("save the show package before reviewing it");
  if (!REVIEW_STATUSES.has(status)) throw new Error("show-package review must be pending, approved, or rejected");
  if (status === "approved") {
    if (!showPackage.ready_for_approval || showPackage.blocking?.length) {
      throw new Error(showPackage.blocking?.[0] || "complete the show package before approving it");
    }
    if (!showPackageAssetsAreCurrent(showPackage)) throw new Error("a show-package asset changed or is unavailable");
    if (showPackage.fingerprint !== showPackageFingerprint(showPackage)) throw new Error("save the current show package before approving it");
  }
  return {
    schema: SHOW_PACKAGE_REVIEW_SCHEMA,
    status,
    notes: String(notes || "").trim().slice(0, 2_000),
    reviewed_at: reviewedAt,
    show_package_fingerprint: showPackage.fingerprint,
    episode_inheritance_authorized: status === "approved",
    publication_authorized: false,
  };
}

export function showPackageReviewMatches(review, showPackage) {
  return Boolean(review
    && showPackage
    && review.show_package_fingerprint === showPackage.fingerprint
    && showPackage.fingerprint === showPackageFingerprint(showPackage));
}

function previewState(dir, section, showPackage) {
  const receipt = readJson(join(dir, `${section}_preview.json`), null);
  if (!receipt) return null;
  let current = false;
  try {
    const stat = statSync(receipt.output?.path);
    current = receipt.show_package_fingerprint === showPackage?.fingerprint
      && stat.isFile()
      && stat.size === Number(receipt.output?.bytes)
      && Math.round(stat.mtimeMs) === Number(receipt.output?.modified_ms);
  } catch {
    current = false;
  }
  return { ...receipt, status: current ? receipt.status : "stale", stale: !current };
}

export function showPackagePaths(workRoot) {
  const dir = join(workRoot, SHOW_PACKAGE_SLUG);
  return {
    dir,
    package: join(dir, "show_package.json"),
    review: join(dir, "show_package_review.json"),
  };
}

export function loadShowPackageState(workRoot) {
  const paths = showPackagePaths(workRoot);
  const showPackage = readJson(paths.package, null);
  const reviewReceipt = readJson(paths.review, null);
  const current = Boolean(showPackage
    && showPackage.schema === SHOW_PACKAGE_SCHEMA
    && showPackage.fingerprint === showPackageFingerprint(showPackage)
    && showPackageAssetsAreCurrent(showPackage));
  const reviewCurrent = Boolean(current && showPackageReviewMatches(reviewReceipt, showPackage));
  const review = reviewReceipt ? {
    ...reviewReceipt,
    original_status: reviewReceipt.status,
    status: reviewCurrent ? reviewReceipt.status : "stale",
    stale: !reviewCurrent,
  } : {
    status: showPackage ? "pending" : "unavailable",
    notes: "",
    reviewed_at: null,
    stale: false,
    episode_inheritance_authorized: false,
    publication_authorized: false,
  };
  return {
    show_package: showPackage ? { ...showPackage, stale: !current } : null,
    review,
    current,
    approved: Boolean(reviewCurrent && reviewReceipt.status === "approved"),
    previews: {
      opening: previewState(paths.dir, "opening", showPackage),
      closing: previewState(paths.dir, "closing", showPackage),
    },
    storage: {
      scope: "local_only",
    },
  };
}

export function showPackageAssets(showPackage) {
  return [
    showPackage?.opening?.visual,
    showPackage?.opening?.voiceover,
    showPackage?.opening?.music,
    showPackage?.closing?.visual,
    showPackage?.closing?.voiceover,
    showPackage?.closing?.music,
    showPackage?.cta_graphic?.asset,
    showPackage?.newsletter_cta?.asset,
  ].filter(Boolean);
}
