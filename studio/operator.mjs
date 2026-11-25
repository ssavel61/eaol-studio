// Which host is operating this computer. Stored locally and never shared.
// Review receipts record this id next to each human decision.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadShowConfig } from "./show_config.mjs";

const SCHEMA = "eaol-operator-v1";
const OPERATOR_IDS = new Set(["host_1", "host_2"]);

function operatorPath(workRoot) {
  return join(workRoot, ".studio", "operator.json");
}

function describe(operatorId, savedAt, config) {
  return {
    schema: SCHEMA,
    operator_id: operatorId,
    display_name: config.hosts[operatorId],
    saved_at: savedAt || null,
    local_only: true,
  };
}

export function loadOperatorIdentity(workRoot, config = loadShowConfig()) {
  const path = operatorPath(workRoot);
  if (!existsSync(path)) return null;
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (saved?.schema !== SCHEMA || !OPERATOR_IDS.has(saved.operator_id)) return null;
  return describe(saved.operator_id, saved.saved_at, config);
}

export function saveOperatorIdentity(workRoot, operatorId, config = loadShowConfig(), savedAt = new Date().toISOString()) {
  const normalized = String(operatorId || "").trim().toLowerCase();
  if (!OPERATOR_IDS.has(normalized)) throw new Error("operator must be host_1 or host_2");
  mkdirSync(join(workRoot, ".studio"), { recursive: true });
  writeFileSync(
    operatorPath(workRoot),
    `${JSON.stringify({ schema: SCHEMA, operator_id: normalized, saved_at: savedAt }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return describe(normalized, savedAt, config);
}
