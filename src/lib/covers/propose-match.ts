import { defaultUseCover, isGcdScanHost } from "@/lib/catalog/match-row";
import { readManualLink, type CatalogSource } from "@/lib/catalog/manual-link";
import type { MatchHit } from "@/lib/catalog/match-hits";
import { needsReviewNote } from "@/lib/covers/printing-cover";

/** Bulk re-match stores a proposal and leaves the comic row alone. */
export const REMATCH_MODE_DEFAULT = "propose" as const;

export type RematchMode = "propose" | "apply";

export type ProposalStatus = "pending" | "rejected" | "accepted";

export type PriorLinkState = {
  metronIssueId: string | null;
  metronSeriesId: string | null;
  comicvineIssueId: string | null;
  comicvineSeriesId: string | null;
  gcdIssueId: string | null;
  gcdSeriesId: string | null;
  coverFile: string | null;
  coverUrl: string | null;
  coverStatus: string | null;
  userCover: boolean;
  manualMetronIssueId: string | null;
  manualComicvineIssueId: string | null;
  manualGcdIssueId: string | null;
};

export type ProposalInput = {
  comicId: string;
  provider: CatalogSource;
  issueId: string;
  seriesId: string | null;
  confidence: number;
  reason: string;
  coverUrl: string | null;
  title: string;
  issueNo: string;
  variant: string | null;
  priorLink: PriorLinkState;
};

export type ProposalSave = "saved" | "skipped" | "unchanged";

/** A hand-picked catalog id or an uploaded cover is not a re-match candidate. */
export function proposalBlocked(manualLink: unknown): string | null {
  const link = readManualLink(manualLink);
  if (link.metronIssueId || link.gcdIssueId || link.comicvineIssueId) return "This link was chosen by hand.";
  if (link.userCover) return "This cover was uploaded.";
  return null;
}

export function priorLinkOf(comic: {
  metronIssueId?: string | null;
  metronSeriesId?: string | null;
  comicvineIssueId?: string | null;
  comicvineSeriesId?: string | null;
  gcdIssueId?: string | null;
  gcdSeriesId?: string | null;
  coverFile?: string | null;
  coverUrl?: string | null;
  coverStatus?: string | null;
  manualLink?: unknown;
}): PriorLinkState {
  const link = readManualLink(comic.manualLink);
  return {
    metronIssueId: comic.metronIssueId ?? null,
    metronSeriesId: comic.metronSeriesId ?? null,
    comicvineIssueId: comic.comicvineIssueId ?? null,
    comicvineSeriesId: comic.comicvineSeriesId ?? null,
    gcdIssueId: comic.gcdIssueId ?? null,
    gcdSeriesId: comic.gcdSeriesId ?? null,
    coverFile: comic.coverFile ?? null,
    coverUrl: comic.coverUrl ?? null,
    coverStatus: comic.coverStatus ?? null,
    userCover: link.userCover,
    manualMetronIssueId: link.metronIssueId,
    manualComicvineIssueId: link.comicvineIssueId,
    manualGcdIssueId: link.gcdIssueId,
  };
}

/** Propose mode never clears or rewrites the comic. Apply mode does. */
export function unmatchedPlan(mode: RematchMode): "leave" | "clear" {
  return mode === "propose" ? "leave" : "clear";
}

export function proposalReason(provider: CatalogSource, series: string, number: string, issueId: string, score: number, review?: string | null): string {
  const name = provider === "gcd" ? "GCD" : provider === "comicvine" ? "Comic Vine" : "Metron";
  const note = review ? ` ${needsReviewNote(review)}` : "";
  return `Proposed ${name} ${issueId} (${series} #${number}), score ${score}.${note}`;
}

/** Rejected and accepted rows stay put. A pending row can be refreshed. */
export function proposalAction(status: ProposalStatus | null): "save" | "skip" {
  if (status === "rejected" || status === "accepted") return "skip";
  return "save";
}

export function sameAsCurrent(prior: PriorLinkState, provider: CatalogSource, issueId: string): boolean {
  if (provider === "metron") return prior.metronIssueId === issueId;
  if (provider === "comicvine") return prior.comicvineIssueId === issueId;
  return prior.gcdIssueId === issueId;
}

/** Accept refuses to replace a hand-picked id for that catalog. */
export function acceptBlocked(manualLink: unknown, provider: CatalogSource, issueId: string): string | null {
  const link = readManualLink(manualLink);
  const current = provider === "metron" ? link.metronIssueId : provider === "comicvine" ? link.comicvineIssueId : link.gcdIssueId;
  if (current && current !== issueId) return "This link was chosen by hand. Unlink it first.";
  return null;
}

export function proposalHit(input: Pick<ProposalInput, "provider" | "issueId" | "seriesId" | "title" | "issueNo" | "variant" | "coverUrl">): MatchHit {
  const showable = input.coverUrl && !isGcdScanHost(input.coverUrl) ? input.coverUrl : null;
  return {
    source: input.provider,
    id: input.issueId,
    seriesId: input.seriesId,
    series: input.title,
    issueNo: input.issueNo,
    variant: input.variant,
    coverDate: null,
    publisher: null,
    coverUrl: showable,
    covers: showable ? [{ label: "Cover", imageUrl: showable }] : [],
  };
}

/** The same flags the Match panel uses. A photo and a GCD scan stay off the shelf cover. */
export function acceptRequest(input: Pick<ProposalInput, "comicId" | "provider" | "issueId" | "seriesId" | "title" | "issueNo" | "variant" | "coverUrl">, userCover: boolean) {
  const hit = proposalHit(input);
  const useCover = defaultUseCover(input.provider, Boolean(hit.coverUrl), userCover);
  return {
    comicId: input.comicId,
    source: input.provider,
    hit,
    useCover,
    fillMissing: true,
    overwrite: false,
    replaceExisting: false,
    coverImageUrl: useCover ? hit.coverUrl : null,
  };
}

export function visibleProposals<T extends { id: string; provider: string; title: string; issueNo: string; variant: string | null; reason: string; shelf?: string | null }>(
  rows: T[],
  filter: { provider?: string | null; q?: string | null },
): T[] {
  const provider = filter.provider?.trim() || "";
  const q = filter.q?.trim().toLowerCase() || "";
  return rows.filter((row) => {
    if (provider && provider !== "all" && row.provider !== provider) return false;
    if (!q) return true;
    const hay = `${row.title} ${row.issueNo} ${row.variant ?? ""} ${row.reason} ${row.shelf ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
}

export type ProposalStore = {
  find(comicId: string, provider: string, issueId: string): Promise<{ status: ProposalStatus } | null>;
  save(input: ProposalInput): Promise<void>;
};

let injected: ProposalStore | null | undefined;

/** Tests inject a store. Production uses Prisma. Vitest leaves it off unless injected. */
export function setProposalStoreForTests(store: ProposalStore | null): void {
  injected = store;
}

function activeStore(): ProposalStore {
  if (injected) return injected;
  return prismaStore;
}

const prismaStore: ProposalStore = {
  async find(comicId, provider, issueId) {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.matchProposal.findUnique({
      where: { comicId_provider_issueId: { comicId, provider, issueId } },
      select: { status: true },
    });
    if (!row) return null;
    if (row.status !== "pending" && row.status !== "rejected" && row.status !== "accepted") return null;
    return { status: row.status };
  },
  async save(input) {
    const { prisma } = await import("@/lib/db");
    const data = {
      seriesId: input.seriesId,
      confidence: input.confidence,
      reason: input.reason,
      coverUrl: input.coverUrl,
      title: input.title,
      issueNo: input.issueNo,
      variant: input.variant,
      priorLink: input.priorLink,
      status: "pending",
    };
    await prisma.matchProposal.upsert({
      where: { comicId_provider_issueId: { comicId: input.comicId, provider: input.provider, issueId: input.issueId } },
      create: { comicId: input.comicId, provider: input.provider, issueId: input.issueId, ...data },
      update: data,
    });
  },
};

export async function saveProposal(input: ProposalInput): Promise<ProposalSave> {
  if (sameAsCurrent(input.priorLink, input.provider, input.issueId)) return "unchanged";
  const existing = await activeStore().find(input.comicId, input.provider, input.issueId);
  if (proposalAction(existing?.status ?? null) === "skip") return "skipped";
  await activeStore().save(input);
  return "saved";
}

export async function countPendingProposals(): Promise<number> {
  if (injected) return 0;
  try {
    const { prisma } = await import("@/lib/db");
    return await prisma.matchProposal.count({ where: { status: "pending" } });
  } catch {
    return 0;
  }
}
