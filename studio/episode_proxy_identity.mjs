import { createHash } from "node:crypto";

export function episodeProxyFingerprint(proxy) {
  if (!proxy) return null;
  const stable = {
    schema: proxy.schema,
    generated_at: proxy.generated_at,
    assembly_fingerprint: proxy.assembly_fingerprint,
    camera_plan_fingerprint: proxy.camera_plan_fingerprint,
    camera_plan_review_required: proxy.camera_plan_review_required,
    camera_plan_sample_set_fingerprint: proxy.camera_plan_sample_set_fingerprint,
    segments: proxy.segments,
    cta: proxy.cta,
    visual_style: proxy.visual_style,
    audio_balance: proxy.audio_balance,
    output: proxy.output,
    checks: proxy.checks,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
