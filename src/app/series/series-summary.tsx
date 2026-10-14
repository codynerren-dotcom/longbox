"use client";

import { useState } from "react";
import { missingClause, truncateMissingParts, type MissingChip } from "@/lib/series-view";

export function SeriesSummary({
  copies,
  have,
  missing,
}: {
  copies: string;
  have: string | null;
  missing: MissingChip | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const parts = missing?.parts ?? [];
  const cut = expanded || !missing ? { shown: parts, rest: 0 } : truncateMissingParts(parts);
  return (
    <div className="mt-3 flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-1 rounded-2xl bg-panel/75 px-4 py-3 text-sm ring-1 ring-white/5">
      <span className="font-semibold text-paper">{copies}</span>
      {have ? <span className="text-mist"> · {have}</span> : null}
      {missing ? (
        <span className="min-w-0 max-w-full text-mist">
          {" · "}
          {missingClause(missing, cut.shown)}
          {cut.rest > 0 ? (
            <button
              type="button"
              className="ml-2 inline-flex min-h-11 items-center font-semibold text-comic underline decoration-comic/40 underline-offset-2"
              onClick={() => setExpanded(true)}
            >
              show all
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
