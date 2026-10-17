"use server";

import { revalidatePath } from "next/cache";
import { linkIssueToCatalog } from "@/lib/catalog/link-issue";
import { readManualLink, type CatalogSource } from "@/lib/catalog/manual-link";
import { acceptBlocked, acceptRequest, proposalBlocked } from "@/lib/covers/propose-match";
import { prisma } from "@/lib/db";

function catalog(value: string): CatalogSource | null {
  if (value === "metron" || value === "comicvine" || value === "gcd") return value;
  return null;
}

export async function acceptProposalAction(id: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.matchProposal.findUnique({
    where: { id },
    include: { comic: { select: { manualLink: true } } },
  });
  if (!row || row.status !== "pending") return { ok: false, message: "That proposal is no longer waiting." };
  const provider = catalog(row.provider);
  if (!provider) return { ok: false, message: "That proposal has no catalog." };
  const manual = proposalBlocked(row.comic.manualLink);
  if (manual) return { ok: false, message: manual };
  const blocked = acceptBlocked(row.comic.manualLink, provider, row.issueId);
  if (blocked) return { ok: false, message: blocked };
  const link = readManualLink(row.comic.manualLink);
  const result = await linkIssueToCatalog(
    acceptRequest(
      {
        comicId: row.comicId,
        provider,
        issueId: row.issueId,
        seriesId: row.seriesId,
        title: row.title,
        issueNo: row.issueNo,
        variant: row.variant,
        coverUrl: row.coverUrl,
      },
      link.userCover,
    ),
  );
  if (!result.ok) return { ok: false, message: result.message };
  await prisma.matchProposal.update({ where: { id }, data: { status: "accepted" } });
  revalidatePath("/review");
  revalidatePath(`/issues/${row.comicId}`);
  revalidatePath("/covers");
  return { ok: true, message: result.message };
}

export async function rejectProposalAction(id: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.matchProposal.findUnique({ where: { id }, select: { status: true } });
  if (!row || row.status !== "pending") return { ok: false, message: "That proposal is no longer waiting." };
  await prisma.matchProposal.update({ where: { id }, data: { status: "rejected" } });
  revalidatePath("/review");
  return { ok: true, message: "Rejected. That match will not be offered again." };
}

/** Links only the ids on the list the page was showing. */
export async function acceptProposalsAction(ids: string[]): Promise<{ ok: boolean; message: string }> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 500);
  let accepted = 0;
  let held = 0;
  for (const id of unique) {
    const result = await acceptProposalAction(id);
    if (result.ok) accepted += 1;
    else held += 1;
  }
  const message = held === 0 ? `Accepted ${accepted}.` : `Accepted ${accepted}. ${held} stayed for review.`;
  return { ok: held === 0, message };
}
