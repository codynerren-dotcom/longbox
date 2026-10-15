"use client";

import { useEffect, useState } from "react";

export function LimitToast({
  message,
  onDismiss,
  onQueue,
}: {
  message: string;
  onDismiss: () => void;
  onQueue?: () => Promise<string | void> | string | void;
}) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    setNote("");
  }, [message]);
  if (!message) return null;
  const text = note || message;
  const offer = Boolean(onQueue) && !note;

  async function queue() {
    if (!onQueue || pending) return;
    setPending(true);
    try {
      const next = await onQueue();
      if (typeof next === "string" && next) setNote(next);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-2xl bg-panel px-4 py-3 text-sm text-paper shadow-2xl ring-1 ring-comic"
      >
        <p className="flex-1">{text}</p>
        {offer ? (
          <span className="flex shrink-0 items-center gap-3">
            <button type="button" disabled={pending} className="rounded-full bg-comic px-3 py-1 text-sm font-semibold text-ink disabled:opacity-50" onClick={() => void queue()}>
              {pending ? "Queuing…" : "Queue it"}
            </button>
            <button type="button" disabled={pending} className="text-mist disabled:opacity-50" onClick={onDismiss}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="shrink-0 text-mist" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
