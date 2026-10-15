import type { Prisma } from "@prisma/client";
import { manualLinkJson, withLinkedId, withoutLinkedId, type CatalogSource } from "@/lib/catalog/manual-link";
import { blankCrossIds } from "@/lib/covers/cross-link";
import { plainText, type MatchHit } from "@/lib/catalog/match-hits";
import { planEnrichment, readFieldSources, type FieldSources, type MetronDetails, type MetronField } from "@/lib/covers/enrich";
import { coverYearOf } from "@/lib/covers/match";

const METRON_ID_FIELDS = ["metronIssueId", "metronSeriesId", "metronIssueUrl", "metronSeriesUrl"] as const satisfies readonly MetronField[];
const CV_ID_FIELDS = ["comicvineIssueId", "comicvineSeriesId"] as const satisfies readonly MetronField[];

export function comicVineDetails(value: unknown, hit: MatchHit): MetronDetails {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const description = typeof row.description === "string" ? plainText(row.description) : null;
  const story = hit.variant && hit.variant.toLowerCase() !== hit.series.toLowerCase() ? hit.variant : null;
  return {
    id: hit.id,
    seriesId: null,
    seriesName: hit.series,
    number: hit.issueNo,
    imageUrl: hit.coverUrl,
    coverDate: hit.coverDate,
    coverYear: coverYearOf(hit.coverDate),
    releaseDate: null,
    title: story,
    storyArc: null,
    plot: description,
    pageCount: null,
    coverPrice: null,
    barcode: null,
    writer: null,
    artist: null,
    coverArtist: null,
    characters: null,
    teams: null,
    imprint: null,
    seriesYear: null,
    seriesVolume: null,
    metronIssueUrl: null,
    metronSeriesUrl: null,
    comicvineIssueId: hit.id,
    comicvineSeriesId: hit.seriesId,
    gcdIssueId: null,
    gcdSeriesId: null,
  };
}

function dropFields(plan: ReturnType<typeof planEnrichment>, fields: readonly MetronField[]) {
  for (const field of fields) {
    delete plan.patch[field];
    delete plan.sources[field];
  }
  plan.filled = plan.filled.filter((field) => !fields.includes(field));
}

export function linkUpdate(args: {
  source: CatalogSource;
  hit: MatchHit;
  current: Partial<Record<MetronField, unknown>> & {
    gcdIssueId?: string | null;
    gcdSeriesId?: string | null;
    collects?: string | null;
    publisher?: string | null;
    variantDescription?: string | null;
  };
  fieldSources: unknown;
  manualLink: unknown;
  detail: MetronDetails | null;
  fillMissing: boolean;
  /** Replace shelf values that were not edited by hand. GCD links only. */
  overwrite?: boolean;
  cover: { file: string; url: string; imageUrl: string } | null;
  issueUrl?: string | null;
  seriesUrl?: string | null;
}): { data: Prisma.ComicUpdateInput; filled: string[] } {
  const overwrite = args.source === "gcd" && args.overwrite === true;
  const writing = args.fillMissing || overwrite;
  const plan = writing && args.detail ? planEnrichment(args.current, args.detail, args.fieldSources, args.source === "gcd" ? "gcd" : "metron", { overwrite }) : null;
  if (plan) {
    dropFields(plan, METRON_ID_FIELDS);
    dropFields(plan, CV_ID_FIELDS);
  }
  const sources: FieldSources = { ...(plan?.sources ?? readFieldSources(args.fieldSources)) };
  const data: Prisma.ComicUpdateInput = {};
  if (plan) {
    Object.assign(data, plan.patch);
    data.fieldSources = sources;
  }
  const coverImage = args.cover?.imageUrl ?? null;
  const nextLink = withLinkedId(args.manualLink, args.source, args.hit.id, coverImage);
  data.manualLink = manualLinkJson(nextLink) ?? {};
  if (args.source === "metron") {
    data.metronIssueId = args.hit.id;
    if (args.hit.seriesId) data.metronSeriesId = args.hit.seriesId;
    if (args.issueUrl) data.metronIssueUrl = args.issueUrl;
    if (args.seriesUrl) data.metronSeriesUrl = args.seriesUrl;
    if (args.detail) Object.assign(data, blankCrossIds(args.current, args.fieldSources, args.manualLink, args.detail));
  } else if (args.source === "comicvine") {
    data.comicvineIssueId = args.hit.id;
    if (args.hit.seriesId) data.comicvineSeriesId = args.hit.seriesId;
  } else {
    data.gcdIssueId = args.hit.id;
    if (args.hit.seriesId) data.gcdSeriesId = args.hit.seriesId;
    data.coverNote = "Linked on GCD. Cover stays on GCD.";
    if (!args.cover) data.coverStatus = "gcd";
  }
  const copyFilled = args.source === "gcd" && writing ? applyGcdShelfFields(data, sources, args, overwrite) : [];
  if (copyFilled.length > 0) data.fieldSources = sources;
  const collected = collectedText(args.current, args.fieldSources, args.detail);
  if (collected) data.collects = collected;
  if (args.cover) {
    data.coverFile = args.cover.file;
    data.coverUrl = args.cover.url;
    data.coverStatus = "matched";
    data.coverNote = null;
    data.coverCheckedAt = new Date();
  }
  return { data, filled: [...(plan?.filled ?? []), ...copyFilled] };
}

const SHELF_LIMIT: Record<"publisher" | "variantDescription", number> = {
  publisher: 120,
  variantDescription: 200,
};

function applyGcdShelfFields(
  data: Prisma.ComicUpdateInput,
  sources: FieldSources,
  args: {
    hit: MatchHit;
    current: { publisher?: string | null; variantDescription?: string | null };
    detail: MetronDetails | null;
  },
  overwrite: boolean,
): string[] {
  const filled: string[] = [];
  const variant = clipShelf(args.hit.variant, SHELF_LIMIT.variantDescription);
  if (writeShelfField(data, sources, "variantDescription", args.current.variantDescription, variant, overwrite)) filled.push("variantDescription");
  const publisher = clipShelf(args.detail?.imprint ?? args.hit.publisher, SHELF_LIMIT.publisher);
  if (writeShelfField(data, sources, "publisher", args.current.publisher, publisher, overwrite)) filled.push("publisher");
  return filled;
}

function writeShelfField(
  data: Prisma.ComicUpdateInput,
  sources: FieldSources,
  field: "publisher" | "variantDescription",
  current: string | null | undefined,
  next: string | null,
  overwrite: boolean,
): boolean {
  if (!next) return false;
  if (sources[field] === "user") return false;
  const blank = current == null || !current.trim();
  if (!blank && !overwrite) return false;
  if (!blank && current.trim() === next) return false;
  data[field] = next;
  sources[field] = "gcd";
  return true;
}

function clipShelf(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export function unlinkUpdate(args: {
  source: CatalogSource;
  fieldSources: unknown;
  manualLink: unknown;
}): Prisma.ComicUpdateInput {
  const next = withoutLinkedId(args.manualLink, args.source);
  const sources = readFieldSources(args.fieldSources);
  const idFields = args.source === "metron" ? METRON_ID_FIELDS : args.source === "comicvine" ? CV_ID_FIELDS : [];
  for (const field of idFields) delete sources[field];
  const data: Prisma.ComicUpdateInput = {
    manualLink: manualLinkJson(next) ?? {},
    fieldSources: sources,
  };
  if (args.source === "metron") {
    data.metronIssueId = null;
    data.metronSeriesId = null;
    data.metronIssueUrl = null;
    data.metronSeriesUrl = null;
  } else if (args.source === "comicvine") {
    data.comicvineIssueId = null;
    data.comicvineSeriesId = null;
  } else {
    data.gcdIssueId = null;
    data.gcdSeriesId = null;
    if (data.coverStatus === undefined) data.coverNote = null;
  }
  return data;
}

export function collectedText(
  current: { collects?: string | null } | null,
  fieldSources: unknown,
  detail: { collects?: string | null } | null,
): string | null {
  const text = detail?.collects?.trim();
  if (!current || !text) return null;
  if (current.collects?.trim()) return null;
  if (readFieldSources(fieldSources).collects === "user") return null;
  return text;
}
