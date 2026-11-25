// Small local-file helpers shared by intake and receipts.
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

export function fileSha256(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

// Confirms a source is a readable, non-empty file whose size and modified time
// hold still across the check, so a file that is still being copied is refused.
export function assertStableLocalFile(path) {
  const before = statSync(path);
  if (!before.isFile() || before.size <= 0) throw new Error(`${basename(path)} has no stable local bytes`);
  accessSync(path, constants.R_OK);
  const after = statSync(path);
  if (before.size !== after.size || Math.round(before.mtimeMs) !== Math.round(after.mtimeMs)) {
    throw new Error(`${basename(path)} changed while it was being checked; wait for the copy to finish`);
  }
  return { status: "local_stable", bytes: after.size, modified_ms: Math.round(after.mtimeMs) };
}
