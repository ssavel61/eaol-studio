import { statSync } from "node:fs";
import { episodeProxyAuditMatches } from "./episode_proxy_audit.mjs";
import { episodeProxyFingerprint } from "./episode_proxy_identity.mjs";

export { episodeProxyFingerprint } from "./episode_proxy_identity.mjs";

export const EPISODE_PROXY_REVIEW_SCHEMA = "eaol-episode-proxy-review-v2";

const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const REQUIRED_CHECKS = ["complete_watch", "opening", "program_sync", "cta", "closing", "divider", "camera_balance"];
const REVIEW_MODES = new Set(["complete_watch", "metadata_assisted"]);
const FOCUSED_CHECKS = REQUIRED_CHECKS.filter((name) => name !== "complete_watch");

export function episodeProxyEndToEndFindings(proxy) {
  const segmentTypes = new Set((proxy?.segments || []).map((segment) => segment.type));
  return {
    opening: segmentTypes.has("opening"),
    program: segmentTypes.has("program"),
    in_program_cta: Number(proxy?.cta?.in_program_cue_count || 0) >= 1,
    closing: segmentTypes.has("closing"),
    closing_cta: proxy?.cta?.closing_overlay === true,
    divider: proxy?.visual_style?.side_by_side_divider?.enabled === true,
    camera_balance: proxy?.visual_style?.camera_balance?.enabled !== true
      || (proxy?.camera_balance?.enabled === true && Object.keys(proxy.camera_balance.adjustments || {}).length > 0),
    technical_checks: Object.values(proxy?.checks || {}).length > 0
      && Object.values(proxy.checks).every(Boolean),
  };
}

export function buildEpisodeProxyReview({
  proxy,
  audit = null,
  status,
  reviewMode = "complete_watch",
  checks = {},
  notes = "",
  reviewedAt = new Date().toISOString(),
} = {}) {
  if (!proxy || proxy.status !== "complete" || proxy.quality !== "proxy") {
    throw new Error("render the current low-resolution proxy before reviewing it");
  }
  if (!REVIEW_STATUSES.has(status)) throw new Error("proxy review must be pending, approved, or rejected");
  if (!REVIEW_MODES.has(reviewMode)) throw new Error("proxy review mode must be complete_watch or metadata_assisted");
  const normalizedChecks = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, checks[name] === true]));
  if (reviewMode === "metadata_assisted") normalizedChecks.complete_watch = false;
  const findings = episodeProxyEndToEndFindings(proxy);
  if (status === "approved") {
    const missingOutput = Object.entries(findings).filter(([, value]) => !value).map(([name]) => name);
    if (missingOutput.length) {
      throw new Error(`the proxy is not an end-to-end package proof: ${missingOutput.join(", ")}`);
    }
    const requiredChecks = reviewMode === "metadata_assisted" ? FOCUSED_CHECKS : REQUIRED_CHECKS;
    const missingChecks = requiredChecks.filter((name) => !normalizedChecks[name]);
    if (missingChecks.length) throw new Error(`complete every proxy review check before approval: ${missingChecks.join(", ")}`);
    if (reviewMode === "metadata_assisted" && !episodeProxyAuditMatches(audit, proxy)) {
      throw new Error("run and pass the metadata audit for this exact proxy before metadata-assisted approval");
    }
  }
  return {
    schema: EPISODE_PROXY_REVIEW_SCHEMA,
    status,
    review_mode: reviewMode,
    notes: String(notes || "").trim().slice(0, 2_000),
    reviewed_at: reviewedAt,
    proxy_fingerprint: episodeProxyFingerprint(proxy),
    assembly_fingerprint: proxy.assembly_fingerprint,
    output: {
      path: proxy.output.path,
      bytes: Number(proxy.output.bytes || 0),
      modified_ms: Number(proxy.output.modified_ms || 0),
    },
    checks: normalizedChecks,
    findings,
    audit_fingerprint: reviewMode === "metadata_assisted" ? audit?.fingerprint || null : null,
    full_render_authorized: status === "approved",
    publication_authorized: false,
  };
}

export function episodeProxyReviewMatches(review, proxy, audit = null) {
  if (!review || !proxy || !new Set([EPISODE_PROXY_REVIEW_SCHEMA, "eaol-episode-proxy-review-v1"]).has(review.schema)) return false;
  try {
    const stat = statSync(proxy.output?.path);
    return review.proxy_fingerprint === episodeProxyFingerprint(proxy)
      && review.assembly_fingerprint === proxy.assembly_fingerprint
      && review.output?.path === proxy.output?.path
      && Number(review.output?.bytes) === Number(proxy.output?.bytes)
      && Number(review.output?.modified_ms) === Number(proxy.output?.modified_ms)
      && stat.isFile()
      && stat.size === Number(proxy.output?.bytes)
      && Math.round(stat.mtimeMs) === Number(proxy.output?.modified_ms)
      && (review.review_mode !== "metadata_assisted"
        || (review.audit_fingerprint === audit?.fingerprint && episodeProxyAuditMatches(audit, proxy)));
  } catch {
    return false;
  }
}
