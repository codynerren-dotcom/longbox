"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { acceptProposalAction, acceptProposalsAction, rejectProposalAction } from "@/app/review/actions";

export type ReviewCard = {
  id: string;
  provider: "metron" | "comicvine" | "gcd";
  title: string;
  issueNo: string;
  variant: string | null;
  reason: string;
  shelfCover: string | null;
  shelfLabel: string;
  proposedCover: string | null;
  placeholder: boolean;
  viewHref: string | null;
  viewLabel: string;
  comicHref: string;
};

export function ReviewList({ cards }: { cards: ReviewCard[] }) {
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.message);
    });
  }

  if (cards.length === 0) return <p className="text-sm text-mist">No proposals match this filter.</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          onClick={() => {
            const count = cards.length;
            const noun = count === 1 ? "match" : "matches";
            if (!window.confirm(`Accept ${count} proposed ${noun}? Only the ones on this list are linked.`)) return;
            run(() => acceptProposalsAction(cards.map((card) => card.id)));
          }}
        >
          Accept all
        </button>
        <p className="text-sm text-mist">Accept all uses this list only.</p>
      </div>
      <ul className="space-y-3">
        {cards.map((card) => (
          <li key={card.id} className="rounded-2xl bg-panel p-4 ring-1 ring-white/5">
            <div className="flex gap-4">
              <CoverFrame src={card.shelfCover} label="Your cover" alt={card.shelfLabel} />
              <CoverFrame src={card.proposedCover} label="Proposed" alt={card.title} placeholder={card.placeholder} />
              <div className="min-w-0 flex-1">
                <Link href={card.comicHref} className="text-sm text-mist hover:text-comic">
                  {card.shelfLabel}
                </Link>
                <p className="font-medium text-paper">
                  {card.title} #{card.issueNo}
                  {card.variant ? <span className="text-mist"> · {card.variant}</span> : null}
                </p>
                <p className="mt-1 text-sm text-paper">{card.reason}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={pending} className="rounded-full bg-comic px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50" onClick={() => run(() => acceptProposalAction(card.id))}>
                    Accept
                  </button>
                  <button type="button" disabled={pending} className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-50" onClick={() => run(() => rejectProposalAction(card.id))}>
                    Reject
                  </button>
                  {card.viewHref ? (
                    <a href={card.viewHref} target="_blank" rel="noopener noreferrer" className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-comic">
                      {card.viewLabel}
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {message ? <p className={ok ? "mt-3 text-sm text-paper" : "mt-3 text-sm text-red-300"}>{message}</p> : null}
    </div>
  );
}

function CoverFrame({ src, label, alt, placeholder = false }: { src: string | null; label: string; alt: string; placeholder?: boolean }) {
  return (
    <div className="w-16 shrink-0">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-mist">{label}</p>
      {placeholder ? (
        <span aria-label="Cover on GCD" className="flex h-24 w-16 items-center justify-center rounded-md bg-panel2 px-1 text-center text-[9px] font-semibold uppercase leading-tight text-mist">
          Cover on GCD
        </span>
      ) : src ? (
        // Shelf files are local. A proposed Metron or Comic Vine scan is https.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="h-24 w-16 rounded-md object-cover" />
      ) : (
        <span aria-label="No cover" className="block h-24 w-16 rounded-md bg-panel2" />
      )}
    </div>
  );
}
