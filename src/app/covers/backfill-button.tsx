"use client";

import { useActionState, useEffect, useState } from "react";
import { startCoverBackfillAction, type BackfillActionState } from "@/app/covers/actions";
import { useBackfillStatus } from "@/components/backfill-status";
import { LimitToast } from "@/components/limit-toast";

const initial: BackfillActionState = { status: "idle", message: "", notice: "" };

export function BackfillButton() {
  const [state, action, pending] = useActionState(startCoverBackfillAction, initial);
  const [toast, setToast] = useState("");
  const { refresh } = useBackfillStatus();
  useEffect(() => {
    if (state.status !== "idle") refresh();
    setToast(state.notice);
  }, [state.status, state.message, state.notice, refresh]);
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
      <LimitToast message={toast} onDismiss={() => setToast("")} />
    </form>
  );
}
