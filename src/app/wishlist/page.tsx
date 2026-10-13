import { PageHeader } from "@/components/page-header";
import { removeWishlistAction } from "@/app/wishlist/actions";
import { prisma } from "@/lib/db";
import { formatIssue } from "@/lib/format";

export const metadata = { title: "Wishlist" };

export default async function WishlistPage() {
  const items = await prisma.wishlistItem.findMany({
    orderBy: [{ series: "asc" }, { issueNo: "asc" }],
  });

  return (
    <div>
      <PageHeader kicker="Still hunting" title="Wishlist" />
      {items.length === 0 ? (
        <p className="rounded-2xl bg-panel px-4 py-8 text-center text-mist">
          No wishes yet. Open a series and add the missing issues.
        </p>
      ) : (
        <ul className="divide-y divide-white/5 overflow-hidden rounded-2xl bg-panel ring-1 ring-white/5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">
                  {item.series} {formatIssue(item.issueNo)}
                </p>
                <p className="text-sm text-mist">{[item.publisher, item.notes].filter(Boolean).join(" · ") || "Wanted"}</p>
              </div>
              <form action={removeWishlistAction}>
                <input type="hidden" name="id" value={item.id} />
                <button type="submit" className="rounded-full bg-panel2 px-3 py-1.5 text-sm ring-1 ring-white/10 hover:ring-comic/70">
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
