export function needsReviewNote(note: string | null | undefined): string {
  const text = (note ?? "The printing cover has not been confirmed.").replace(/\s+/g, " ").trim();
  if (/needs review/i.test(text)) return text;
  return `Needs review. ${text}`;
}

/** Keep the cover already on the shelf until a file for the correct printing exists. */
export function keptPrintingCover(
  existingFile: string | null,
  replacementFile: string | null,
  note: string | null,
): { coverFile: string | null; coverUrl: string | null; coverNote: string | null } {
  if (replacementFile) {
    return { coverFile: replacementFile, coverUrl: `/covers/files/${replacementFile}`, coverNote: null };
  }
  return {
    coverFile: existingFile,
    coverUrl: existingFile ? `/covers/files/${existingFile}` : null,
    coverNote: needsReviewNote(note),
  };
}
