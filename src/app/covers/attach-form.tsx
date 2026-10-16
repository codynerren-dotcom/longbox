"use client";

import { useActionState, useState } from "react";
import { attachCoverAction, type AttachState } from "@/app/covers/actions";
import { LimitToast } from "@/components/limit-toast";

export function AttachForm({ comicId }: { comicId: string }) {
  const [state, action, pending] = useActionState(attachCoverAction, { status: "idle", id: comicId, message: "", notice: "" } satisfies AttachState);
  const [dismissed, setDismissed] = useState("");
  const visible = state.id === comicId ? state.message : "";
  const toast = state.id === comicId && state.notice !== dismissed ? state.notice : "";
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={comicId} />
      <label className="sr-only" htmlFor={`metron-${comicId}`}>
        Metron issue id
      </label>
      <input id={`metron-${comicId}`} name="metronIssueId" inputMode="numeric" placeholder="Metron issue id" className="field max-w-40" />
      <button type="submit" disabled={pending} className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-50">
        {pending ? "Saving…" : "Save cover"}
      </button>
      {visible ? <span className={state.status === "error" ? "text-sm text-red-300" : "text-sm text-mist"}>{visible}</span> : null}
      <LimitToast message={toast} onDismiss={() => setDismissed(state.notice)} />
    </form>
  );
}
