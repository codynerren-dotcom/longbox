"use client";

import { useActionState, useEffect, useState } from "react";
import { addSeriesIssueAction, type AddIssueState } from "@/app/series/actions";

const initial: AddIssueState = { status: "idle", message: "" };

export function AddSeriesIssue({
  series,
  publisher,
  seriesId,
  coreSeriesId,
}: {
  series: string;
  publisher: string;
  seriesId: string;
  coreSeriesId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(addSeriesIssueAction, initial);
  const wide = open || state.status !== "idle";

  useEffect(() => {
    if (state.status === "added") setOpen(false);
  }, [state.status]);

  return (
    <div className={wide ? "w-full basis-full" : "ml-auto"}>
      <div className={wide ? "flex justify-end" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="hidden rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink md:inline-flex"
      >
        Add issue
      </button>
      </div>
      <button
        type="button"
        aria-label="Add an issue to this series"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-comic font-display text-4xl leading-none text-ink shadow-comic md:hidden"
      >
        +
      </button>
      {state.status !== "idle" ? (
        <p className={`mt-3 text-sm ${state.status === "error" || state.status === "exists" ? "text-red-300" : "text-paper"}`}>
          {state.message}
        </p>
      ) : null}
      {open ? (
        <form action={action} className="mt-4 grid gap-3 rounded-2xl bg-panel p-4 ring-1 ring-white/10 sm:grid-cols-2">
          <input type="hidden" name="series" value={series} />
          <input type="hidden" name="publisher" value={publisher} />
          <input type="hidden" name="seriesId" value={seriesId} />
          <input type="hidden" name="coreSeriesId" value={coreSeriesId} />
          <label className="block text-sm">
            <span className="mb-1 block text-mist">Issue number</span>
            <input name="issueNo" required inputMode="numeric" placeholder="1" className="field" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-mist">Variant letter</span>
            <input name="variant" maxLength={12} placeholder="A" className="field" />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block text-mist">Variant description</span>
            <input name="variantDescription" placeholder="Regular Inhyuk Lee Cover" className="field" />
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <button type="submit" disabled={pending} className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">
              {pending ? "Adding…" : "Add to this series"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-sm text-mist">
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
