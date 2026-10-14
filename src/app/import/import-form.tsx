"use client";

import { useActionState } from "react";
import { importClzAction, type ImportActionState } from "@/app/import/actions";

const initial: ImportActionState = { status: "idle" };

export function ImportForm({ embedded = false }: { embedded?: boolean }) {
  const [state, action, pending] = useActionState(importClzAction, initial);

  return (
    <form action={action} className={embedded ? "space-y-4" : "space-y-4 rounded-2xl bg-panel p-5 ring-1 ring-white/5"}>
      <label className="block text-sm text-mist" htmlFor="clz-file">
        CLZ CSV export
      </label>
      <input id="clz-file" name="file" type="file" accept=".csv,text/csv" required className="field" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
      >
        {pending ? "Importing…" : "Import"}
      </button>
      {state.status === "error" ? <p className="text-sm text-red-300">{state.error}</p> : null}
      {state.status === "ok" ? (
        <div className="text-sm text-paper">
          <p>
            Read {state.summary.rows} rows, kept {state.summary.unique} unique comics. Created {state.summary.created}, updated{" "}
            {state.summary.updated}
            {state.summary.collapsed > 0 ? `, collapsed ${state.summary.collapsed} duplicates` : ""}.
          </p>
          {state.warnings.map((warning) => (
            <p key={warning} className="text-mist">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </form>
  );
}
