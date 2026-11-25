import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resetCandidateReviewContext({ workDir, reason, updatedAt = new Date().toISOString() }) {
  const manifestPath = join(workDir, "episode.json");
  const manifest = readJson(manifestPath, null);
  if (!manifest) throw new Error("episode receipt is missing");
  const clipDoc = readJson(join(workDir, "clips.json"), { clips: [] });
  const savedPath = join(workDir, "studio_review.json");
  const saved = readJson(savedPath, { clips: {} });
  const clips = Object.fromEntries((clipDoc.clips || []).map((clip) => [
    clip.id,
    {
      status: clip.proposed_by === "studio" ? "suggested" : "proposed",
      notes: String(saved.clips?.[clip.id]?.notes || ""),
      reviewed_by: saved.clips?.[clip.id]?.reviewed_by || null,
      reviewed_at: saved.clips?.[clip.id]?.reviewed_at || null,
      discussion: Array.isArray(saved.clips?.[clip.id]?.discussion) ? saved.clips[clip.id].discussion : [],
    },
  ]));
  if ((clipDoc.clips || []).length) {
    writeFileSync(savedPath, `${JSON.stringify({
      schema: "eaol-review-v2",
      clips,
      updated_at: updatedAt,
      invalidated_at: updatedAt,
      invalidated_reason: reason,
    }, null, 2)}\n`);
  }
  manifest.candidate_context_reset_at = updatedAt;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
