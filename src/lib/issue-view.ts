/** The slab block is only for a slabbed copy. Raw and unknown copies leave it off the page. */
export function showSlabSection(rawOrSlabbed: string | null | undefined): boolean {
  return rawOrSlabbed === "Slabbed";
}
