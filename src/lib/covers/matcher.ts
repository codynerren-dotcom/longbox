/**
 * Future cover-photo recognition. A later version should combine:
 * - image embeddings against Metron `cover_hash` / local cover art
 * - OCR of the title, issue number, and barcode box
 * - an optional vision LLM when the embedding shortlist is ambiguous
 *
 * v1 does not implement matching and does not call a model.
 */
export type CoverMatchCandidate = {
  score: number;
  series?: string;
  issueNo?: string;
  barcode?: string;
  source: string;
};

export type CoverImage = {
  bytes?: Uint8Array;
  mimeType?: string;
};

export interface CoverMatcher {
  readonly id: string;
  match(image: CoverImage): Promise<CoverMatchCandidate[]>;
}

export class UnimplementedCoverMatcher implements CoverMatcher {
  readonly id = "cover-matcher";

  async match(_image: CoverImage): Promise<CoverMatchCandidate[]> {
    return [];
  }
}
