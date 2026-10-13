"use client";

import { useActionState } from "react";
import { startCoverBackfillAction, type BackfillActionState } from "@/app/covers/actions";

const initial: BackfillActionState = { status: "idle", message: "" };

export function BackfillButton() {
  const [state, action, pending] = useActionState(startCoverBackfillAction, initial);
  return (
    <form action={action} className="space-y-3">
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
      >
        {pending ? "Starting…" : "Backfill covers"}
      </button>
      {state.message ? <p className={state.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{state.message}</p> : null}
    </form>
  );
}
