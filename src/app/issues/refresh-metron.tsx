"use client";

import { useState, useTransition } from "react";
import { refreshFromMetronAction } from "@/app/issues/actions";

export function RefreshFromMetron({ comicId }: { comicId: string }) {
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        onClick={() => {
          start(async () => {
            const result = await refreshFromMetronAction(comicId);
            setOk(result.ok);
            setMessage(result.message);
          });
        }}
      >
        {pending ? "Refreshing…" : "Refresh from Metron"}
      </button>
      {message ? <p className={ok ? "text-sm text-paper" : "text-sm text-red-300"}>{message}</p> : null}
    </div>
  );
}
