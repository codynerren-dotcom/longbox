"use client";

import { useState, useTransition } from "react";
import { setReadAction } from "@/app/issues/actions";

export function ReadToggle({
  id,
  read,
  readDate,
}: {
  id: string;
  read: boolean;
  readDate: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await setReadAction(form);
          if (!result.ok) setError(result.error);
        });
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="read" value={read ? "false" : "true"} />
      <label className="block text-sm text-mist" htmlFor="read-date">
        Read date
      </label>
      <input id="read-date" name="readDate" type="date" defaultValue={readDate} className="field" />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
      >
        {pending ? "Saving…" : read ? "Mark unread" : "Mark read"}
      </button>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </form>
  );
}
