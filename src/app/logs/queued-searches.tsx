"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cancelQueuedSearchAction } from "@/app/logs/queue-actions";

export function CancelQueuedSearch({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <span className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-panel2 px-3 py-1.5 text-sm font-semibold text-paper ring-1 ring-white/10 disabled:opacity-50"
        onClick={() => {
          setPending(true);
          void cancelQueuedSearchAction(id).then((result) => {
            setMessage(result.message);
            setPending(false);
            router.refresh();
          });
        }}
      >
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      {message ? <span className="text-sm text-mist">{message}</span> : null}
    </span>
  );
}
