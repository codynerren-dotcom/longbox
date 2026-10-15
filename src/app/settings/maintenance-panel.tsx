"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { clearDemoAction, rebuildSearchIndexAction, type LibraryState } from "@/app/settings/library-actions";
import { Panel } from "@/components/panel";

const initial: LibraryState = { status: "idle", message: "" };

export type DedupeGroup = {
  label: string;
  comics: Array<{ id: string; series: string; issue: string | null; variant: string | null }>;
};

export function MaintenancePanel({ groups, hiddenGroups, demoCount }: { groups: DedupeGroup[]; hiddenGroups: number; demoCount: number }) {
  const [rebuildMessage, setRebuildMessage] = useState("");
  const [pending, start] = useTransition();
  const [cleared, clearAction, clearPending] = useActionState(clearDemoAction, initial);

  return (
    <Panel title="Data maintenance" detail="Find copies that share a barcode or the same series, issue, and variant. Rebuild the sort fields search and the shelf use. Clear only the synthetic demo range.">
      <div>
        <h3 className="text-sm font-medium text-paper">Possible duplicates</h3>
        {groups.length === 0 ? <p className="mt-1 text-sm text-mist">No duplicate groups on the shelf.</p> : null}
        <ul className="mt-2 space-y-2">
          {groups.map((group) => (
            <li key={group.label} className="rounded-xl bg-panel2 px-3 py-2 text-sm">
              <p className="text-mist">{group.label}</p>
              <p className="text-paper">
                {group.comics.map((comic, index) => (
                  <span key={comic.id}>
                    {index > 0 ? " · " : null}
                    <Link href={`/issues/${comic.id}`} className="text-comic">
                      {comic.series} #{comic.issue || "?"}
                      {comic.variant ? ` ${comic.variant}` : ""}
                    </Link>
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
        {hiddenGroups > 0 ? <p className="mt-2 text-sm text-mist">{hiddenGroups} more groups.</p> : null}
      </div>
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        onClick={() => {
          start(async () => {
            const result = await rebuildSearchIndexAction();
            setRebuildMessage(result.message);
          });
        }}
      >
        {pending ? "Rebuilding…" : "Rebuild search index"}
      </button>
      {rebuildMessage ? <p className="text-sm text-paper">{rebuildMessage}</p> : null}
      <form action={clearAction} className="space-y-2 border-t border-white/5 pt-4">
        <p className="text-sm text-mist">
          {demoCount} comics use core ids 900001–900030. Clearing removes those copies and the two seed wishlist rows marked “Gap in the run”.
        </p>
        <label className="flex items-center gap-2 text-sm text-paper">
          <input type="checkbox" name="confirmDemo" className="h-4 w-4 accent-comic" />
          Clear the synthetic demo shelf
        </label>
        <button type="submit" disabled={clearPending} className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-red-200 disabled:opacity-50">
          {clearPending ? "Clearing…" : "Clear demo data"}
        </button>
        {cleared.message ? <p className={cleared.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{cleared.message}</p> : null}
      </form>
    </Panel>
  );
}
