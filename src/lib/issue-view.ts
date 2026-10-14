/** The slab block is only for a slabbed copy. Raw and unknown copies leave it off the page. */
export function showSlabSection(rawOrSlabbed: string | null | undefined): boolean {
  return rawOrSlabbed === "Slabbed";
}

/** View mode drops blank facts instead of showing an em dash. */
export function isEmptyDisplay(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed === "—";
  }
  if (typeof value === "number") return false;
  return false;
}
