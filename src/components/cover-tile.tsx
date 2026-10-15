import Link from "next/link";
import { KeyBadge } from "@/components/key-badge";
import { paletteFor } from "@/lib/visual";
import { safeImageUrl } from "@/lib/url";

type CoverTileProps = {
  title: string;
  issue?: string | null;
  coverUrl?: string | null;
  keyLevel?: string | null;
  slab?: boolean;
  variant?: string | null;
  quantity?: number | null;
  href?: string;
  className?: string;
};

export function CoverTile({ title, issue, coverUrl, keyLevel, slab, variant, quantity, href, className }: CoverTileProps) {
  const image = safeImageUrl(coverUrl);
  const [from, to] = paletteFor(title);
  const inner = (
    <div className={`relative ${className ?? ""}`}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-panel2">
        {image ? (
          // Local files are served by the app. A catalog hit can still be an https URL until backfill downloads it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={`${title}${issue ? ` #${issue}` : ""}`} className="h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0" style={{ background: `linear-gradient(165deg, ${from}, ${to} 70%)` }}>
            <div className="halftone absolute inset-0" />
            <div className="relative flex h-full flex-col justify-between p-3">
              <span className="font-display text-4xl leading-none text-comic">{issue ? `#${issue}` : ""}</span>
              <span className="font-display text-[1.7rem] uppercase leading-[0.88] text-paper">{title}</span>
            </div>
          </div>
        )}
        {slab ? (
          <span className="absolute bottom-2 right-2 rounded bg-slab px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink">
            Slab
          </span>
        ) : null}
        {variant ? (
          <span className="absolute bottom-2 left-2 max-w-[68%] truncate rounded bg-ink/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-paper">
            {variant}
          </span>
        ) : null}
      </div>
      <KeyBadge level={keyLevel} className="absolute left-2.5 top-2.5" />
      {quantity != null && quantity > 1 ? (
        <span className="absolute right-2 top-2 rounded-md bg-comic px-1.5 py-0.5 text-xs font-bold text-ink">×{quantity}</span>
      ) : null}
    </div>
  );

  if (!href) return inner;
  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-comic"
    >
      {inner}
    </Link>
  );
}
