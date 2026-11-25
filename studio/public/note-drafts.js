// Preserve each editor independently, including typing while its save is pending.
export function createNoteDrafts() {
  const drafts = new Map();
  return {
    get: id => drafts.get(id),
    set: (id, value) => drafts.set(id, { ...value }),
    discard: id => drafts.delete(id),
    get dirty() { return drafts.size > 0; },
    saved(id, submitted) {
      if (JSON.stringify(drafts.get(id)) === JSON.stringify(submitted)) drafts.delete(id);
    },
  };
}
